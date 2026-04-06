import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as crypto from 'crypto';
import type {
  AgentName,
  CommandOutput,
  ConversationTurn,
  ExtensionToWebviewMessage,
  FileChange,
  RoundRequest,
  TokenUsage,
} from '../types';
import { RoundType } from '../types';
import type { ProgressEvent } from '../agents/AgentRunner';
import { AgentRunner } from '../agents/AgentRunner';
import { CopilotProvider } from '../agents/CopilotProvider';
import { ApiKeyProvider } from '../agents/ApiKeyProvider';
import type { WorkspaceReader } from '../workspace/WorkspaceReader';
import type { ConfigManager } from '../extension';
import type { ExtensionConfig } from '../types';

export interface OrchestratorRunParams {
  userMessage: string;
  roundType: RoundType;
  mainAgent: AgentName;
  subAgents: AgentName[];
  conversationHistory: ConversationTurn[];
  fileCache: Map<string, string>;
  commandOutputCache: Map<string, CommandOutput>;
}

export type OrchestratorResult =
  | {
      status: 'success';
      /** undefined if user turn was a duplicate (already in history) */
      newUserTurn: ConversationTurn | undefined;
      assistantTurn: ConversationTurn;
      fileChanges: FileChange[];
      tokenUsage?: TokenUsage;
    }
  | { status: 'cancelled' }
  | { status: 'error'; error: unknown };

const EXEC_MAX_OUTPUT = 50_000;

/**
 * Owns all round-execution concerns: streaming state, cancellation,
 * AgentRunner orchestration, and command execution.
 * ChatPanel owns conversation state and session persistence.
 */
export class RoundOrchestrator {
  private streamingMsgId: string | undefined;
  private streamingAgentName: AgentName | undefined;
  private verifierPlaceholderIds: Map<string, string> = new Map();
  private currentCancellationTokenSource: vscode.CancellationTokenSource | undefined;

  constructor(
    private readonly configManager: ConfigManager,
    private readonly workspaceReader: WorkspaceReader,
    private readonly emit: (msg: ExtensionToWebviewMessage) => void,
  ) {}

  cancel(): void {
    this.currentCancellationTokenSource?.cancel();
  }

  dispose(): void {
    this.currentCancellationTokenSource?.cancel();
    this.currentCancellationTokenSource?.dispose();
    this.currentCancellationTokenSource = undefined;
  }

  async run(params: OrchestratorRunParams): Promise<OrchestratorResult> {
    const { userMessage, roundType, mainAgent, subAgents, conversationHistory, fileCache, commandOutputCache } = params;

    // Remove orphaned streaming bubble from a previous interrupted request
    if (this.streamingMsgId) {
      this.emit({ type: 'removeMessage', payload: { id: this.streamingMsgId } });
      this.streamingMsgId = undefined;
      this.streamingAgentName = undefined;
    }
    this.currentCancellationTokenSource?.cancel();
    this.currentCancellationTokenSource?.dispose();
    this.currentCancellationTokenSource = new vscode.CancellationTokenSource();
    const cancellationToken = this.currentCancellationTokenSource.token;

    this.emit({ type: 'setLoading', payload: { loading: true } });
    this.emit({ type: 'clearFileChanges' });
    this.emit({ type: 'clearContextFiles' });

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
        conversationHistory: [...conversationHistory],
        cachedFiles: fileCache,
        cachedCommandOutputs: commandOutputCache,
      };

      const result = await runner.runRound(
        request,
        cancellationToken,
        (event: ProgressEvent) => this.handleProgressEvent(event),
        (command: string) => this.runCommandWithApproval(command),
      );

      if (cancellationToken.isCancellationRequested) {
        return { status: 'cancelled' };
      }

      const lastEntry = conversationHistory[conversationHistory.length - 1];
      const isNewUserTurn = !lastEntry || lastEntry.role !== 'user' || lastEntry.content !== userMessage;

      return {
        status: 'success',
        newUserTurn: isNewUserTurn ? { role: 'user', content: userMessage } : undefined,
        assistantTurn: { role: 'assistant', content: result.reflectedResponse },
        fileChanges: result.fileChanges,
        tokenUsage: result.tokenUsage,
      };
    } catch (err) {
      if (err instanceof vscode.CancellationError) {
        return { status: 'cancelled' };
      }
      return { status: 'error', error: err };
    } finally {
      if (this.streamingMsgId) {
        this.emit({ type: 'interruptMessage', payload: { id: this.streamingMsgId } });
      }
      this.streamingMsgId = undefined;
      this.streamingAgentName = undefined;
      this.emit({ type: 'setLoading', payload: { loading: false } });
      this.currentCancellationTokenSource?.dispose();
      this.currentCancellationTokenSource = undefined;
    }
  }

  get streamingBubbleId(): string | undefined {
    return this.streamingMsgId;
  }

  clearStreamingBubble(): void {
    this.streamingMsgId = undefined;
    this.streamingAgentName = undefined;
  }

  private handleProgressEvent(event: ProgressEvent): void {
    switch (event.type) {
      case 'main_agent_start': {
        this.emit({ type: 'pipelineProgress', payload: { stage: 'thinking' } });
        this.streamingMsgId = crypto.randomUUID();
        this.streamingAgentName = event.agentName;
        this.emit({
          type: 'addMessage',
          payload: {
            id: this.streamingMsgId,
            role: 'agent',
            agentName: event.agentName,
            content: '',
            timestamp: Date.now(),
            streaming: true,
          },
        });
        break;
      }

      case 'main_agent_chunk':
        if (this.streamingMsgId) {
          this.emit({ type: 'streamChunk', payload: { id: this.streamingMsgId, chunk: event.chunk } });
        }
        break;

      case 'tool_read':
        if (this.streamingMsgId) {
          this.emit({ type: 'toolCallProgress', payload: { msgId: this.streamingMsgId, filePath: event.filePath } });
        }
        this.emit({ type: 'contextFileRead', payload: { path: event.filePath } });
        break;

      case 'tool_run_command':
        if (this.streamingMsgId) {
          this.emit({ type: 'toolCallProgress', payload: { msgId: this.streamingMsgId, filePath: `$ ${event.command}` } });
        }
        break;

      case 'sub_agents_start': {
        this.emit({ type: 'pipelineProgress', payload: { stage: 'verifying' } });
        this.verifierPlaceholderIds.clear();
        for (const agentName of event.agentNames) {
          const placeholderId = crypto.randomUUID();
          this.verifierPlaceholderIds.set(agentName, placeholderId);
          this.emit({
            type: 'addMessage',
            payload: {
              id: placeholderId,
              role: 'agent',
              agentName,
              content: '',
              timestamp: Date.now(),
              isSubAgentFeedback: true,
              streaming: true,
            },
          });
        }
        break;
      }

      case 'sub_agent_feedback': {
        const placeholderId = this.verifierPlaceholderIds.get(event.agentName);
        if (event.feedback.startsWith('[Verification unavailable')) {
          if (placeholderId) {
            this.emit({ type: 'removeMessage', payload: { id: placeholderId } });
          }
        } else {
          if (placeholderId) {
            const agentLabel = event.agentName.charAt(0).toUpperCase() + event.agentName.slice(1);
            this.emit({ type: 'collapseMessage', payload: { id: placeholderId, content: event.feedback, label: `${agentLabel} (verifier)` } });
          } else {
            this.emit({
              type: 'addMessage',
              payload: {
                id: crypto.randomUUID(),
                role: 'agent',
                agentName: event.agentName,
                content: event.feedback,
                timestamp: Date.now(),
                isSubAgentFeedback: true,
              },
            });
          }
        }
        this.verifierPlaceholderIds.delete(event.agentName);
        break;
      }

      case 'reflection_start': {
        this.emit({ type: 'pipelineProgress', payload: { stage: 'reflecting' } });
        if (this.streamingMsgId) {
          const agentLabel = (this.streamingAgentName ?? event.agentName).charAt(0).toUpperCase()
            + (this.streamingAgentName ?? event.agentName).slice(1);
          this.emit({ type: 'collapseMessage', payload: { id: this.streamingMsgId, content: event.mainAgentResponse, label: `${agentLabel} (initial)` } });
        }
        this.streamingMsgId = crypto.randomUUID();
        this.emit({
          type: 'addMessage',
          payload: {
            id: this.streamingMsgId,
            role: 'agent',
            agentName: this.streamingAgentName ?? event.agentName,
            content: '',
            timestamp: Date.now(),
            streaming: true,
          },
        });
        break;
      }

      case 'reflection_chunk':
        if (this.streamingMsgId) {
          this.emit({ type: 'streamChunk', payload: { id: this.streamingMsgId, chunk: event.chunk } });
        }
        break;

      default:
        break;
    }
  }

  private async runCommandWithApproval(command: string): Promise<CommandOutput> {
    const choice = await vscode.window.showWarningMessage(
      `Agent wants to run a command:\n\n${command}`,
      { modal: true },
      'Run',
    );

    if (choice !== 'Run') {
      return { command, stdout: '[User denied command execution]', exitCode: 1 };
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const config = await this.configManager.getConfig();
    return execCommand(command, workspaceRoot, config.runnerTimeoutMs);
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
      workspaceReader: this.workspaceReader,
    });
  }
}

export function execCommand(
  command: string,
  cwd: string | undefined,
  timeoutMs: number,
): Promise<CommandOutput> {
  return new Promise((resolve) => {
    try {
      cp.exec(command, { cwd, timeout: timeoutMs, maxBuffer: EXEC_MAX_OUTPUT }, (err, stdout, stderr) => {
        const combined = [stdout, stderr].filter(Boolean).join('\n').slice(0, EXEC_MAX_OUTPUT);
        resolve({ command, stdout: combined || '(no output)', exitCode: err?.code ?? (err ? 1 : 0) });
      });
    } catch (syncErr) {
      resolve({ command, stdout: String(syncErr), exitCode: 1 });
    }
  });
}
