import * as vscode from 'vscode';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as cp from 'child_process';
import type {
  ConversationTurn,
  ExtensionConfig,
  ExtensionToWebviewMessage,
  FileChange,
  RoundRequest,
} from '../types';
import {
  AgentName,
  ProviderMode,
  validateSendMessagePayload,
  validateApplyChangesPayload,
} from '../types';
import { RoundType } from '../types';
import type { ProgressEvent } from '../agents/AgentRunner';
import { AgentRunner } from '../agents/AgentRunner';
import { CopilotProvider } from '../agents/CopilotProvider';
import { ApiKeyProvider } from '../agents/ApiKeyProvider';
import { WorkspaceReader } from '../workspace/WorkspaceReader';
import { WorkspaceWriter } from '../workspace/WorkspaceWriter';
import type { ConfigManager } from '../extension';
import { ValidationError } from '../errors';

const VIEW_TYPE = 'aiRoundtable.chatPanel';
const PANEL_TITLE = 'AI Roundtable';

/** Maximum length for error messages exposed to the webview (prevents info leakage). */
const MAX_ERROR_MESSAGE_LENGTH = 300;

export class ChatPanel implements vscode.Disposable {
  private static instance: ChatPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly workspaceReader: WorkspaceReader;
  private readonly workspaceWriter: WorkspaceWriter;
  private readonly disposables: vscode.Disposable[] = [];
  private isDisposed = false;

  private currentCancellationTokenSource:
    | vscode.CancellationTokenSource
    | undefined;

  private conversationHistory: ConversationTurn[] = [];
  private currentRoundType: RoundType | undefined;
  private lastRunCommand: string | undefined;
  private lastRunMainAgent: AgentName = AgentName.CLAUDE;
  private lastRunSubAgents: AgentName[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly configManager: ConfigManager,
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.workspaceReader = new WorkspaceReader();
    this.workspaceWriter = new WorkspaceWriter();

    this.panel.webview.html = this.buildHtml();

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
    extensionUri: vscode.Uri,
    configManager: ConfigManager,
  ): ChatPanel {
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

    ChatPanel.instance = new ChatPanel(panel, extensionUri, configManager);
    return ChatPanel.instance;
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
            !fc['filePath'].startsWith('/') &&
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
        break;

      case 'configureProvider':
        await this.configManager.configureProvider();
        await this.handleRequestConfig();
        break;

      case 'runCommand': {
        const runPayload = msg.payload as { command?: unknown; mainAgent?: unknown; subAgents?: unknown };
        if (typeof runPayload?.command === 'string' && runPayload.command.trim().length > 0) {
          const mainAgent = typeof runPayload.mainAgent === 'string' && Object.values(AgentName).includes(runPayload.mainAgent as AgentName)
            ? runPayload.mainAgent as AgentName
            : AgentName.COPILOT;
          const subAgents = Array.isArray(runPayload.subAgents)
            ? (runPayload.subAgents as string[]).filter((a): a is AgentName => Object.values(AgentName).includes(a as AgentName))
            : [];
          await this.handleRunCommand(runPayload.command.trim(), mainAgent, subAgents);
        }
        break;
      }

      case 'runAgain':
        if (this.lastRunCommand) {
          await this.handleRunCommand(this.lastRunCommand, this.lastRunMainAgent, this.lastRunSubAgents);
        }
        break;

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
            await this.handleRunCommand(command, this.lastRunMainAgent, this.lastRunSubAgents);
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
  ): Promise<void> {
    // Reset history when round type changes
    if (roundType !== this.currentRoundType) {
      this.conversationHistory = [];
      this.currentRoundType = roundType;
    }

    // Cancel any in-flight request
    this.currentCancellationTokenSource?.cancel();
    this.currentCancellationTokenSource?.dispose();
    this.currentCancellationTokenSource = new vscode.CancellationTokenSource();
    const cancellationToken = this.currentCancellationTokenSource.token;

    const userMsgId = crypto.randomUUID();
    this.postMessage({
      type: 'addMessage',
      payload: {
        id: userMsgId,
        role: 'user',
        content: userMessage,
        timestamp: Date.now(),
      },
    });

    this.postMessage({ type: 'setLoading', payload: { loading: true } });
    this.postMessage({ type: 'clearFileChanges' });

    try {
      const config = await this.configManager.getConfig();
      const runner = this.buildAgentRunner(config);

      const workspaceContext = await this.workspaceReader.buildContext();

      const request: RoundRequest = {
        userMessage,
        roundType,
        mainAgent,
        subAgents,
        workspaceContext,
        conversationHistory: [...this.conversationHistory],
      };

      const result = await runner.runRound(
        request,
        cancellationToken,
        (event: ProgressEvent) => {
          this.handleProgressEvent(event);
        },
      );

      if (cancellationToken.isCancellationRequested) {
        return;
      }

      // Update conversation history with this turn
      this.conversationHistory.push({ role: 'user', content: userMessage });
      this.conversationHistory.push({ role: 'assistant', content: result.reflectedResponse });

      // Show final response
      this.postMessage({
        type: 'addMessage',
        payload: {
          id: crypto.randomUUID(),
          role: 'agent',
          agentName: mainAgent,
          content: result.reflectedResponse,
          timestamp: Date.now(),
        },
      });

      // Show file changes if any
      if (result.fileChanges.length > 0) {
        const enrichedChanges = await this.enrichFileChanges(
          result.fileChanges,
        );
        this.postMessage({
          type: 'showFileChanges',
          payload: { fileChanges: enrichedChanges },
        });
      }
    } catch (err) {
      if (err instanceof vscode.CancellationError) {
        this.postMessage({
          type: 'addMessage',
          payload: {
            id: crypto.randomUUID(),
            role: 'system',
            content: 'Request cancelled.',
            timestamp: Date.now(),
          },
        });
        return;
      }

      this.postErrorMessage(this.toSafeUserMessage(err));
    } finally {
      this.postMessage({ type: 'setLoading', payload: { loading: false } });
      this.currentCancellationTokenSource?.dispose();
      this.currentCancellationTokenSource = undefined;
    }
  }

  private async handleApplyChanges(fileChanges: FileChange[]): Promise<void> {
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
          result.deletedFiles.length > 0
            ? `Deleted: ${result.deletedFiles.join(', ')}`
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
          await this.handleRunCommand(installCommand, this.lastRunMainAgent, this.lastRunSubAgents);
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

  private async handleRunCommand(command: string, mainAgent: AgentName, subAgents: AgentName[]): Promise<void> {
    // Guard: prevent concurrent executions
    if (this.currentCancellationTokenSource) {
      return;
    }

    this.lastRunCommand = command;
    this.lastRunMainAgent = mainAgent;
    this.lastRunSubAgents = subAgents;

    this.postMessage({ type: 'setLoading', payload: { loading: true } });
    this.postMessage({ type: 'executionStarted', payload: { command } });

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const MAX_OUTPUT = 50_000;

    const { output, exitCode } = await new Promise<{ output: string; exitCode: number }>((resolve) => {
      cp.exec(command, { cwd: workspaceRoot, timeout: 60_000, maxBuffer: MAX_OUTPUT }, (err, stdout, stderr) => {
        const combined = [stdout, stderr].filter(Boolean).join('\n').slice(0, MAX_OUTPUT);
        resolve({ output: combined || '(no output)', exitCode: err?.code ?? (err ? 1 : 0) });
      });
    });

    this.postMessage({ type: 'executionComplete', payload: { command, output, exitCode } });
    this.postMessage({ type: 'setLoading', payload: { loading: false } });

    // Only feed to Runner AI if the command failed
    if (exitCode !== 0) {
      const analysisMessage = `[Execution Output]\nCommand: ${command}\nExit code: ${exitCode}\n\n${output}`;
      await this.handleSendMessage(analysisMessage, RoundType.RUNNER, mainAgent, subAgents);
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
        payload: { providerMode: config.providerMode, hasApiKeys, availableAgents },
      });
    } catch {
      this.postMessage({
        type: 'configLoaded',
        payload: {
          providerMode: ProviderMode.COPILOT,
          hasApiKeys: false,
          availableAgents: [AgentName.CLAUDE, AgentName.GPT, AgentName.GEMINI, AgentName.DEEPSEEK],
        },
      });
    }
  }

  private handleProgressEvent(event: ProgressEvent): void {
    const systemMsgId = crypto.randomUUID();

    switch (event.type) {
      case 'main_agent_start':
        this.postMessage({
          type: 'addMessage',
          payload: {
            id: systemMsgId,
            role: 'system',
            content: `${this.formatAgentName(event.agentName)} is thinking\u2026`,
            timestamp: Date.now(),
          },
        });
        break;

      case 'sub_agents_start':
        this.postMessage({
          type: 'addMessage',
          payload: {
            id: systemMsgId,
            role: 'system',
            content: `Verifiers running: ${event.agentNames.map((n) => this.formatAgentName(n)).join(', ')}\u2026`,
            timestamp: Date.now(),
          },
        });
        break;

      case 'sub_agent_feedback':
        if (!event.feedback.startsWith('[Verification unavailable')) {
          this.postMessage({
            type: 'addMessage',
            payload: {
              id: systemMsgId,
              role: 'agent',
              agentName: event.agentName,
              content: event.feedback,
              timestamp: Date.now(),
              isSubAgentFeedback: true,
            },
          });
        }
        break;

      case 'reflection_start':
        this.postMessage({
          type: 'addMessage',
          payload: {
            id: systemMsgId,
            role: 'system',
            content: `${this.formatAgentName(event.agentName)} is reflecting on feedback\u2026`,
            timestamp: Date.now(),
          },
        });
        break;

      default:
        break;
    }
  }

  private formatAgentName(agentName: AgentName): string {
    const names: Record<AgentName, string> = {
      [AgentName.COPILOT]: 'GitHub Copilot',
      [AgentName.CLAUDE]: 'Claude',
      [AgentName.GPT]: 'GPT',
      [AgentName.GEMINI]: 'Gemini',
      [AgentName.DEEPSEEK]: 'DeepSeek',
    };
    return names[agentName] ?? agentName;
  }

  private async enrichFileChanges(
    fileChanges: FileChange[],
  ): Promise<FileChange[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return fileChanges;
    }

    const workspaceRoot = workspaceFolders[0].uri;

    return Promise.all(
      fileChanges.map(async (change) => {
        const targetUri = vscode.Uri.joinPath(workspaceRoot, change.filePath);
        try {
          await vscode.workspace.fs.stat(targetUri);
          return { ...change, isNew: false };
        } catch {
          return { ...change, isNew: true };
        }
      }),
    );
  }

  private buildAgentRunner(config: ExtensionConfig): AgentRunner {
    const copilotProvider = new CopilotProvider();
    copilotProvider.setPreferredFamily(config.copilotModelFamily);
    const apiKeyProvider = new ApiKeyProvider({
      anthropicApiKey: config.anthropicApiKey,
      openaiApiKey: config.openaiApiKey,
      googleApiKey: config.googleApiKey,
      deepseekApiKey: config.deepseekApiKey,
    });

    return new AgentRunner({
      copilotProvider,
      apiKeyProvider,
      providerMode: config.providerMode,
    });
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
  private postErrorMessage(message: string): void {
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

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this.isDisposed = true;

    this.currentCancellationTokenSource?.cancel();
    this.currentCancellationTokenSource?.dispose();
    this.currentCancellationTokenSource = undefined;

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
