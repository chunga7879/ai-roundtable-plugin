import * as vscode from 'vscode';
import * as fs from 'fs';
import * as crypto from 'crypto';
import type {
  ExtensionConfig,
  ExtensionToWebviewMessage,
  FileChange,
  RoundRequest,
  WebviewToExtensionMessage,
} from '../types';
import { AgentName, ProviderMode } from '../types';
import type { RoundType } from '../types';
import type { ProgressEvent } from '../agents/AgentRunner';
import { AgentRunner } from '../agents/AgentRunner';
import { CopilotProvider } from '../agents/CopilotProvider';
import { ApiKeyProvider } from '../agents/ApiKeyProvider';
import { WorkspaceReader } from '../workspace/WorkspaceReader';
import { WorkspaceWriter } from '../workspace/WorkspaceWriter';
import type { ConfigManager } from '../extension';

const VIEW_TYPE = 'aiRoundtable.chatPanel';
const PANEL_TITLE = 'AI Roundtable';

type WebviewMessage =
  | WebviewToExtensionMessage
  | { type: 'previewChange'; payload: { fileChange: FileChange } };

export class ChatPanel {
  private static instance: ChatPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly workspaceReader: WorkspaceReader;
  private readonly workspaceWriter: WorkspaceWriter;
  private readonly disposables: vscode.Disposable[] = [];

  private currentCancellationTokenSource:
    | vscode.CancellationTokenSource
    | undefined;

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
      (message: WebviewMessage) => {
        void this.handleWebviewMessage(message);
      },
      undefined,
      this.disposables,
    );

    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
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

  private async handleWebviewMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'sendMessage':
        await this.handleSendMessage(
          message.payload.userMessage,
          message.payload.roundType,
          message.payload.mainAgent,
          message.payload.subAgents,
        );
        break;

      case 'applyChanges':
        await this.handleApplyChanges(message.payload.fileChanges);
        break;

      case 'rejectChanges':
        this.postMessage({ type: 'clearFileChanges' });
        break;

      case 'previewChange':
        await this.handlePreviewChange(message.payload.fileChange);
        break;

      case 'requestConfig':
        await this.handleRequestConfig();
        break;

      case 'configureProvider':
        await this.configManager.configureProvider();
        await this.handleRequestConfig();
        break;

      default:
        break;
    }
  }

  private async handleSendMessage(
    userMessage: string,
    roundType: RoundType,
    mainAgent: AgentName,
    subAgents: AgentName[],
  ): Promise<void> {
    // Cancel any in-flight request
    this.currentCancellationTokenSource?.cancel();
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

      // Show sub-agent feedbacks as collapsed messages
      for (const verification of result.subAgentVerifications) {
        if (!verification.feedback.startsWith('[Verification unavailable')) {
          this.postMessage({
            type: 'addMessage',
            payload: {
              id: crypto.randomUUID(),
              role: 'agent',
              agentName: verification.agentName,
              content: verification.feedback,
              timestamp: Date.now(),
              isSubAgentFeedback: true,
            },
          });
        }
      }

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

      const errorMessage =
        err instanceof Error ? err.message : 'An unexpected error occurred.';

      this.postMessage({
        type: 'addMessage',
        payload: {
          id: crypto.randomUUID(),
          role: 'error',
          content: errorMessage,
          timestamp: Date.now(),
        },
      });
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
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : 'Failed to apply changes.';
      this.postMessage({
        type: 'addMessage',
        payload: {
          id: crypto.randomUUID(),
          role: 'error',
          content: errorMessage,
          timestamp: Date.now(),
        },
      });
    }
  }

  private async handlePreviewChange(fileChange: FileChange): Promise<void> {
    try {
      await this.workspaceWriter.previewChange(fileChange);
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : 'Failed to preview change.';
      void vscode.window.showErrorMessage(errorMessage);
    }
  }

  private async handleRequestConfig(): Promise<void> {
    try {
      const config = await this.configManager.getConfig();
      const hasApiKeys = Boolean(
        config.anthropicApiKey ??
          config.openaiApiKey ??
          config.googleApiKey,
      );

      this.postMessage({
        type: 'configLoaded',
        payload: {
          providerMode: config.providerMode,
          hasApiKeys,
        },
      });
    } catch {
      this.postMessage({
        type: 'configLoaded',
        payload: {
          providerMode: ProviderMode.COPILOT,
          hasApiKeys: false,
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
    const apiKeyProvider = new ApiKeyProvider({
      anthropicApiKey: config.anthropicApiKey,
      openaiApiKey: config.openaiApiKey,
      googleApiKey: config.googleApiKey,
    });

    return new AgentRunner({
      copilotProvider,
      apiKeyProvider,
      providerMode: config.providerMode,
    });
  }

  private postMessage(message: ExtensionToWebviewMessage): void {
    void this.panel.webview.postMessage(message);
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
    this.currentCancellationTokenSource?.cancel();
    this.currentCancellationTokenSource?.dispose();

    ChatPanel.instance = undefined;

    for (const disposable of this.disposables) {
      disposable.dispose();
    }

    this.panel.dispose();
  }
}
