import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type {
  ConversationTurn,
  ExtensionToWebviewMessage,
  FileChange,
} from '../types';
import { SessionManager } from '../sessions/SessionManager';
import {
  AgentName,
  ProviderMode,
  validateSendMessagePayload,
  validateApplyChangesPayload,
} from '../types';
import { RoundType } from '../types';
import { WorkspaceReader } from '../workspace/WorkspaceReader';
import { WorkspaceWriter } from '../workspace/WorkspaceWriter';
import type { ConfigManager } from '../extension';
import { ValidationError } from '../errors';
import { RoundOrchestrator, execCommand } from './RoundOrchestrator';

const VIEW_TYPE = 'aiRoundtable.chatPanel';
const PANEL_TITLE = 'AI Roundtable';
const DRAFT_FILE_CHANGES_KEY = 'aiRoundtable.draftFileChanges';

/** Maximum length for error messages exposed to the webview (prevents info leakage). */
const MAX_ERROR_MESSAGE_LENGTH = 300;

/** Approximate context token limits per main agent (conservative estimates). */
const CONTEXT_LIMIT_TOKENS: Record<string, number> = {
  [AgentName.CLAUDE]:   200_000,
  [AgentName.GPT]:      128_000,
  [AgentName.GEMINI]:   200_000, // 1M but cap at 200k for gauge purposes
  [AgentName.DEEPSEEK]:  64_000,
  [AgentName.COPILOT]:  128_000,
};

/** Rough chars-to-tokens ratio (4 chars ≈ 1 token). */
const CHARS_PER_TOKEN = 4;

export class ChatPanel implements vscode.Disposable {
  private static instance: ChatPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly workspaceReader: WorkspaceReader;
  private readonly workspaceWriter: WorkspaceWriter;
  private readonly disposables: vscode.Disposable[] = [];
  private isDisposed = false;

  private conversationHistory: ConversationTurn[] = [];
  private currentRoundType: RoundType | undefined;
  private lastSendMessage: { userMessage: string; roundType: RoundType; mainAgent: AgentName; subAgents: AgentName[] } | undefined;
  /** Files read by the agent — reused on next turn within a round, cleared on round change or Apply Changes. */
  private fileCache: Map<string, string> = new Map();
  /** Command outputs from the current turn — cleared on round change or Apply Changes. */
  private commandOutputCache: Map<string, import('../types').CommandOutput> = new Map();
  private sessionManager: SessionManager | undefined;
  private currentSessionId: string | undefined;
  private readonly orchestrator: RoundOrchestrator;

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly configManager: ConfigManager,
    private readonly context: vscode.ExtensionContext | undefined,
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.workspaceReader = new WorkspaceReader();
    this.workspaceWriter = new WorkspaceWriter();
    this.orchestrator = new RoundOrchestrator(
      configManager,
      this.workspaceReader,
      (msg) => this.postMessage(msg),
    );
    if (context) {
      this.sessionManager = new SessionManager(context.globalStorageUri);
      void this.startNewSession();
    }

    this.panel.webview.html = this.buildHtml();

    this.setupFileCacheWatcher();

    this.panel.webview.onDidReceiveMessage(
      (message: unknown) => {
        void this.handleWebviewMessage(message);
      },
      undefined,
      this.disposables,
    );

    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
  }

  static async refreshConfig(): Promise<void> {
    if (ChatPanel.instance) {
      await ChatPanel.instance.handleRequestConfig();
    }
  }

  static createOrReveal(
    context: vscode.ExtensionContext | vscode.Uri,
    configManager: ConfigManager,
  ): ChatPanel {
    const extensionUri = context instanceof vscode.Uri ? context : context.extensionUri;
    const extensionContext = context instanceof vscode.Uri ? undefined : context;

    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (ChatPanel.instance) {
      ChatPanel.instance.panel.reveal(column);
      return ChatPanel.instance;
    }

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      PANEL_TITLE,
      column ?? vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      },
    );

    ChatPanel.instance = new ChatPanel(panel, extensionUri, configManager, extensionContext);
    return ChatPanel.instance;
  }

  private async startNewSession(): Promise<void> {
    if (!this.sessionManager) {
      return;
    }
    try {
      const roundType = this.currentRoundType ?? RoundType.DEVELOPER;
      this.currentSessionId = await this.sessionManager.startSession(roundType);
    } catch {
      // Non-fatal — session saving must never break the chat
    }
  }

  private async handleWebviewMessage(message: unknown): Promise<void> {
    // Guard: type-narrow before dispatch
    if (typeof message !== 'object' || message === null || !('type' in message)) {
      return;
    }

    const msg = message as { type: string; payload?: unknown };

    switch (msg.type) {
      case 'sendMessage': {
        let payload;
        try {
          payload = validateSendMessagePayload(msg.payload);
        } catch (err) {
          this.postErrorMessage(
            err instanceof ValidationError
              ? err.message
              : 'Invalid message payload.',
          );
          return;
        }
        await this.handleSendMessage(
          payload.userMessage,
          payload.roundType,
          payload.mainAgent,
          payload.subAgents,
        );
        break;
      }

      case 'applyChanges': {
        let payload;
        try {
          payload = validateApplyChangesPayload(msg.payload);
        } catch (err) {
          this.postErrorMessage(
            err instanceof ValidationError
              ? err.message
              : 'Invalid applyChanges payload.',
          );
          return;
        }
        await this.handleApplyChanges(payload.fileChanges);
        break;
      }

      case 'rejectChanges':
        this.clearDraftFileChanges();
        this.postMessage({ type: 'clearFileChanges' });
        break;

      case 'previewChange': {
        const previewPayload = msg.payload as Record<string, unknown> | undefined;
        const rawFileChange = previewPayload?.['fileChange'];
        if (typeof rawFileChange === 'object' && rawFileChange !== null) {
          const fc = rawFileChange as Record<string, unknown>;
          // Validate filePath for path traversal before passing to WorkspaceWriter
          if (
            typeof fc['filePath'] === 'string' &&
            fc['filePath'].trim().length > 0 &&
            !fc['filePath'].includes('..') &&
            !path.isAbsolute(fc['filePath']) &&
            typeof fc['content'] === 'string'
          ) {
            await this.handlePreviewChange({
              filePath: (fc['filePath'] as string).trim(),
              content: fc['content'] as string,
              isNew: typeof fc['isNew'] === 'boolean' ? fc['isNew'] : false,
            });
          }
        }
        break;
      }

      case 'requestConfig':
        await this.handleRequestConfig();
        this.restoreDraftFileChangesIfAny();
        break;

      case 'configureProvider':
        await this.configManager.configureProvider();
        await this.handleRequestConfig();
        break;

      case 'clearChat':
        this.conversationHistory = [];
        this.currentRoundType = undefined;
        this.lastSendMessage = undefined;
        this.fileCache.clear();
        this.commandOutputCache.clear();
        this.clearDraftFileChanges();
        this.postMessage({ type: 'clearMessages' });
        this.postMessage({ type: 'clearFileChanges' });
        void this.startNewSession();
        break;

      case 'requestSessionList': {
        if (this.sessionManager) {
          const sessions = await this.sessionManager.listSessions();
          this.postMessage({ type: 'sessionListLoaded', payload: { sessions } });
        }
        break;
      }

      case 'restoreSession': {
        const { sessionId } = (msg.payload as { sessionId: string });
        if (this.sessionManager && sessionId) {
          const session = await this.sessionManager.loadSession(sessionId);
          if (session) {
            this.conversationHistory = [...session.turns];
            this.currentRoundType = session.roundType;
            this.lastSendMessage = undefined;
            this.fileCache.clear();
            this.commandOutputCache.clear();
            this.currentSessionId = session.id;
            this.postMessage({ type: 'sessionRestored', payload: { turns: session.turns, roundType: session.roundType } });
          }
        }
        break;
      }

      case 'retryLastMessage':
        if (this.lastSendMessage) {
          const { userMessage, roundType, mainAgent, subAgents } = this.lastSendMessage;
          await this.handleSendMessage(userMessage, roundType, mainAgent, subAgents);
        }
        break;

      case 'cancelRequest':
        this.orchestrator.cancel();
        break;

      case 'setModelTier': {
        const { tier } = (msg.payload as { tier: string });
        if (tier === 'light' || tier === 'heavy') {
          await this.configManager.setModelTier(tier);
          await this.handleRequestConfig();
        }
        break;
      }

      case 'executeCommand': {
        const execPayload = msg.payload as { command?: unknown };
        if (typeof execPayload?.command === 'string' && execPayload.command.trim().length > 0) {
          const command = execPayload.command.trim();
          const choice = await vscode.window.showWarningMessage(
            `Run this command in your workspace?\n\n${command}`,
            { modal: true },
            'Run',
          );
          if (choice === 'Run') {
            this.runInTerminal(command);
          }
        }
        break;
      }

      default:
        // Unknown message types are silently ignored
        break;
    }
  }

  private async handleSendMessage(
    userMessage: string,
    roundType: RoundType,
    mainAgent: AgentName,
    subAgents: AgentName[],
    suppressUserBubble = false,
  ): Promise<void> {
    // Save for retry
    this.lastSendMessage = { userMessage, roundType, mainAgent, subAgents };

    // Reset history and file cache when round type changes
    if (roundType !== this.currentRoundType) {
      this.conversationHistory = [];
      this.fileCache.clear();
      this.currentRoundType = roundType;
      void this.startNewSession();
    }

    // Command outputs are turn-scoped — clear every turn
    this.commandOutputCache.clear();

    if (!suppressUserBubble) {
      this.postMessage({
        type: 'addMessage',
        payload: { id: crypto.randomUUID(), role: 'user', content: userMessage, timestamp: Date.now() },
      });
    }

    const result = await this.orchestrator.run({
      userMessage,
      roundType,
      mainAgent,
      subAgents,
      conversationHistory: this.conversationHistory,
      fileCache: this.fileCache,
      commandOutputCache: this.commandOutputCache,
    });

    switch (result.status) {
      case 'cancelled':
        this.postMessage({
          type: 'addMessage',
          payload: { id: crypto.randomUUID(), role: 'system', content: 'Request cancelled.', timestamp: Date.now() },
        });
        break;

      case 'error':
        // Preserve user message in history so retry has context.
        this.conversationHistory.push({ role: 'user', content: userMessage });
        this.postErrorMessage(this.toSafeUserMessage(result.error), true);
        break;

      case 'success': {
        if (result.newUserTurn) {
          this.conversationHistory.push(result.newUserTurn);
        }
        this.conversationHistory.push(result.assistantTurn);

        // Persist turns (best-effort, non-blocking)
        if (this.sessionManager && this.currentSessionId) {
          if (result.newUserTurn) {
            void this.sessionManager.appendTurn(this.currentSessionId, result.newUserTurn);
          }
          void this.sessionManager.appendTurn(this.currentSessionId, result.assistantTurn);
        }

        this.postContextUsage(mainAgent);

        const prose = result.assistantTurn.content.trim() ||
          (result.fileChanges.length > 0 ? 'Done — see proposed file changes below.' : 'Done.');
        const agentContent = result.tokenUsage
          ? `${prose}\n\nIn: ${result.tokenUsage.inputTokens.toLocaleString()}  Out: ${result.tokenUsage.outputTokens.toLocaleString()} tokens`
          : prose;

        // Finalize the streaming bubble or add a fresh message
        const bubbleId = this.orchestrator.streamingBubbleId;
        if (bubbleId) {
          this.postMessage({ type: 'finalizeMessage', payload: { id: bubbleId, content: agentContent } });
          this.orchestrator.clearStreamingBubble();
        } else {
          this.postMessage({
            type: 'addMessage',
            payload: { id: crypto.randomUUID(), role: 'agent', agentName: mainAgent, content: agentContent, timestamp: Date.now() },
          });
        }

        if (result.fileChanges.length > 0) {
          const enriched = await this.enrichFileChanges(result.fileChanges);
          this.postMessage({ type: 'showFileChanges', payload: { fileChanges: enriched } });
          this.saveDraftFileChanges(enriched, roundType);
        } else {
          this.clearDraftFileChanges();
        }
        break;
      }
    }
  }

  private async handleApplyChanges(fileChanges: FileChange[]): Promise<void> {
    this.clearDraftFileChanges();
    // Invalidate file cache — applied files are now stale
    this.fileCache.clear();
    this.commandOutputCache.clear();
    this.postMessage({ type: 'clearContextFiles' });
    // Reset gauge to reflect cleared cache
    const mainAgent = this.lastSendMessage?.mainAgent ?? AgentName.CLAUDE;
    this.postContextUsage(mainAgent);
    try {
      const result = await this.workspaceWriter.applyChanges(fileChanges);

      const summary =
        [
          result.appliedFiles.length > 0
            ? `Modified: ${result.appliedFiles.join(', ')}`
            : '',
          result.newFiles.length > 0
            ? `Created: ${result.newFiles.join(', ')}`
            : '',
        ]
          .filter(Boolean)
          .join('\n') || 'No changes applied.';

      this.postMessage({
        type: 'addMessage',
        payload: {
          id: crypto.randomUUID(),
          role: 'system',
          content: `Changes applied.\n${summary}`,
          timestamp: Date.now(),
        },
      });
      // Detect dependency file changes and offer to run install command (exclude deletions)
      const allChanged = [...result.appliedFiles, ...result.newFiles];
      const installCommand = detectInstallCommand(allChanged);
      if (installCommand) {
        const choice = await vscode.window.showWarningMessage(
          `Dependency files changed. Run install command?\n\n${installCommand}`,
          { modal: true },
          'Run',
        );
        if (choice === 'Run') {
          const lastMsg = this.lastSendMessage;
          const mainAgent = lastMsg?.mainAgent ?? AgentName.CLAUDE;
          const subAgents = lastMsg?.subAgents ?? [];
          await this.handleRunCommand(installCommand, mainAgent, subAgents);
        }
      }
    } catch (err) {
      this.postErrorMessage(this.toSafeUserMessage(err));
    }
  }

  private async handlePreviewChange(fileChange: FileChange): Promise<void> {
    try {
      await this.workspaceWriter.previewChange(fileChange);
    } catch (err) {
      void vscode.window.showErrorMessage(this.toSafeUserMessage(err));
    }
  }

  /**
   * Runs a command in a dedicated VS Code terminal.
   * Used for RUN: button clicks — no output capture needed; user controls the terminal.
   */
  private runInTerminal(command: string): void {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const terminal = vscode.window.createTerminal({
      name: 'AI Roundtable',
      cwd: workspaceRoot,
    });
    terminal.show();
    terminal.sendText(command);
  }

  private async handleRunCommand(command: string, mainAgent: AgentName, subAgents: AgentName[]): Promise<void> {
    // Guard: prevent concurrent executions (orchestrator has an active request)
    if (this.orchestrator.streamingBubbleId !== undefined) {
      return;
    }

    this.postMessage({ type: 'setLoading', payload: { loading: true } });
    this.postMessage({
      type: 'addMessage',
      payload: { id: crypto.randomUUID(), role: 'system', content: `Running: ${command}`, timestamp: Date.now() },
    });

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const config = await this.configManager.getConfig();
    const { stdout: output, exitCode } = await execCommand(command, workspaceRoot, config.runnerTimeoutMs);

    this.postMessage({ type: 'setLoading', payload: { loading: false } });

    if (exitCode !== 0) {
      // Show collapsible output bubble so the user can inspect it without it flooding the chat
      this.postMessage({
        type: 'addCollapsibleMessage',
        payload: { id: crypto.randomUUID(), title: `${command}  ·  exit ${exitCode}`, content: output },
      });
      const analysisMessage = `[Execution Output]\nCommand: ${command}\nExit code: ${exitCode}\n\n${output}`;
      const roundType = this.currentRoundType ?? RoundType.DEVELOPER;
      // suppressUserBubble: the collapsible above already shows the output to the user
      await this.handleSendMessage(analysisMessage, roundType, mainAgent, subAgents, true);
    } else {
      this.postMessage({
        type: 'addMessage',
        payload: { id: crypto.randomUUID(), role: 'system', content: `✓ ${command} completed successfully.`, timestamp: Date.now() },
      });
    }
  }

  private async handleRequestConfig(): Promise<void> {
    try {
      const config = await this.configManager.getConfig();
      const hasApiKeys = Boolean(
        config.anthropicApiKey ??
          config.openaiApiKey ??
          config.googleApiKey ??
          config.deepseekApiKey,
      );

      const availableAgents: AgentName[] =
        config.providerMode === ProviderMode.COPILOT
          ? [AgentName.CLAUDE, AgentName.GPT, AgentName.GEMINI, AgentName.DEEPSEEK]
          : ([
              config.anthropicApiKey ? AgentName.CLAUDE : null,
              config.openaiApiKey ? AgentName.GPT : null,
              config.googleApiKey ? AgentName.GEMINI : null,
              config.deepseekApiKey ? AgentName.DEEPSEEK : null,
            ].filter((a): a is AgentName => a !== null));

      this.postMessage({
        type: 'configLoaded',
        payload: { providerMode: config.providerMode, hasApiKeys, availableAgents, modelTier: config.modelTier },
      });
    } catch {
      this.postMessage({
        type: 'configLoaded',
        payload: {
          providerMode: ProviderMode.COPILOT,
          hasApiKeys: false,
          availableAgents: [AgentName.CLAUDE, AgentName.GPT, AgentName.GEMINI, AgentName.DEEPSEEK],
          modelTier: 'heavy',
        },
      });
    }
  }

  private async enrichFileChanges(
    fileChanges: FileChange[],
  ): Promise<FileChange[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return fileChanges;
    }

    const workspaceRoot = workspaceFolders[0].uri;

    const results = await Promise.all(
      fileChanges.map(async (change) => {
        const targetUri = vscode.Uri.joinPath(workspaceRoot, change.filePath);
        try {
          const existing = await vscode.workspace.fs.readFile(targetUri);
          const existingText = Buffer.from(existing).toString('utf-8');
          if (existingText === change.content) {
            return null; // unchanged — exclude from diff panel
          }
          return { ...change, isNew: false };
        } catch {
          return { ...change, isNew: true };
        }
      }),
    );
    return results.filter((c): c is FileChange => c !== null);
  }

  private postContextUsage(mainAgent: AgentName): void {
    const limitTokens = CONTEXT_LIMIT_TOKENS[mainAgent] ?? 128_000;

    // Estimate tokens: cached file chars + history chars
    const fileChars = Array.from(this.fileCache.values()).reduce((sum, c) => sum + c.length, 0);
    const historyChars = this.conversationHistory.reduce((sum, t) => sum + t.content.length, 0);
    const estimatedTokens = Math.round((fileChars + historyChars) / CHARS_PER_TOKEN);

    const pct = Math.round((estimatedTokens / limitTokens) * 100);
    const pctCapped = Math.min(100, pct);

    let label: string;
    if (pct >= 80) {
      label = `Context ${pct}% — Consider clearing chat`;
    } else if (pct >= 50) {
      label = `Context ${pct}%`;
    } else {
      label = `Context ${pct}%`;
    }

    this.postMessage({ type: 'contextUsage', payload: { pct: pctCapped, label } });
  }

  private saveDraftFileChanges(fileChanges: FileChange[], roundType: RoundType): void {
    if (!this.context) return;
    this.context.globalState.update(DRAFT_FILE_CHANGES_KEY, {
      fileChanges,
      roundType,
      savedAt: Date.now(),
    });
  }

  private clearDraftFileChanges(): void {
    if (!this.context) return;
    this.context.globalState.update(DRAFT_FILE_CHANGES_KEY, undefined);
  }

  private restoreDraftFileChangesIfAny(): void {
    if (!this.context) return;
    const draft = this.context.globalState.get<{ fileChanges: FileChange[]; roundType: RoundType; savedAt: number }>(DRAFT_FILE_CHANGES_KEY);
    if (draft && draft.fileChanges.length > 0) {
      this.postMessage({ type: 'restoreDraftFileChanges', payload: draft });
    }
  }

  private postMessage(message: ExtensionToWebviewMessage): void {
    if (this.isDisposed) {
      return;
    }
    void this.panel.webview.postMessage(message);
  }

  /**
   * Posts a sanitized error message to the webview.
   * Truncates to MAX_ERROR_MESSAGE_LENGTH to prevent information leakage.
   */
  private postErrorMessage(message: string, retryable = false): void {
    const safe =
      message.length > MAX_ERROR_MESSAGE_LENGTH
        ? message.slice(0, MAX_ERROR_MESSAGE_LENGTH) + '…'
        : message;
    this.postMessage({
      type: 'addMessage',
      payload: {
        id: crypto.randomUUID(),
        role: 'error',
        content: safe,
        timestamp: Date.now(),
        retryable,
      },
    });
  }

  /**
   * Converts an unknown error to a user-safe message string.
   * Uses only `err.message` (never the stack trace).
   */
  private toSafeUserMessage(err: unknown): string {
    if (err instanceof Error) {
      return err.message;
    }
    return 'An unexpected error occurred.';
  }

  private buildHtml(): string {
    const nonce = crypto.randomBytes(16).toString('hex');

    const htmlPath = vscode.Uri.joinPath(
      this.extensionUri,
      'src',
      'panels',
      'webview',
      'index.html',
    );

    let html: string;
    try {
      html = fs.readFileSync(htmlPath.fsPath, 'utf-8');
    } catch {
      return this.buildFallbackHtml(nonce);
    }

    html = html.replace(/\{\{NONCE\}\}/g, nonce);
    return html;
  }

  private buildFallbackHtml(nonce: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}';" />
  <title>AI Roundtable</title>
</head>
<body>
  <p>Error loading chat panel UI. Please reload the extension.</p>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
  </script>
</body>
</html>`;
  }

  private setupFileCacheWatcher(): void {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) return;

    const workspaceRoot = workspaceFolders[0].uri.fsPath;

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspaceFolders[0], '**/*'),
    );

    const invalidate = (uri: vscode.Uri) => {
      // Convert absolute path to relative and evict from cache if present
      const rel = uri.fsPath.startsWith(workspaceRoot)
        ? uri.fsPath.slice(workspaceRoot.length).replace(/^[\\/]/, '').replace(/\\/g, '/')
        : undefined;
      if (rel && this.fileCache.has(rel)) {
        this.fileCache.delete(rel);
      }
    };

    watcher.onDidChange(invalidate, undefined, this.disposables);
    watcher.onDidDelete(invalidate, undefined, this.disposables);
    this.disposables.push(watcher);
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this.isDisposed = true;

    this.orchestrator.dispose();

    ChatPanel.instance = undefined;

    for (const disposable of this.disposables) {
      try {
        disposable.dispose();
      } catch {
        // Best-effort cleanup — continue disposing remaining items
      }
    }
    this.disposables.length = 0;

    this.panel.dispose();
  }
}

/** Maps changed file names to the appropriate install command. Returns undefined if no dependency files changed. */
function detectInstallCommand(changedFiles: string[]): string | undefined {
  const fileNames = changedFiles.map((f) => f.split('/').pop() ?? f);

  // Order matters: check lockfiles first (more specific), then manifests
  if (fileNames.some((f) => f === 'package.json')) {
    return 'npm install';
  }
  if (fileNames.some((f) => f === 'requirements.txt' || f === 'pyproject.toml')) {
    return 'pip install -r requirements.txt';
  }
  if (fileNames.some((f) => f === 'Cargo.toml')) {
    return 'cargo build';
  }
  if (fileNames.some((f) => f === 'go.mod')) {
    return 'go mod download';
  }
  if (fileNames.some((f) => f === 'Gemfile')) {
    return 'bundle install';
  }
  if (fileNames.some((f) => f === 'pom.xml')) {
    return 'mvn dependency:resolve';
  }
  if (fileNames.some((f) => f === 'build.gradle' || f === 'build.gradle.kts')) {
    return 'gradle dependencies';
  }
  if (fileNames.some((f) => f === 'composer.json')) {
    return 'composer install';
  }
  return undefined;
}
