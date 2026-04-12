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
import type { RoundType } from '../types';
import type { ProgressEvent } from '../agents/AgentRunner';
import { AgentRunner } from '../agents/AgentRunner';
import { CopilotProvider } from '../agents/CopilotProvider';
import { ApiKeyProvider } from '../agents/ApiKeyProvider';
import { resolveWorkspaceRootForCommand } from '../workspace/WorkspaceRootResolver';
import { sanitizeCommandForWorkspace } from '../workspace/CommandSanitizer';
import type { WorkspaceReader } from '../workspace/WorkspaceReader';
import type { ConfigManager } from '../extension';
import type { ExtensionConfig } from '../types';
import {
  extractEnclosingJsonObject as extractEnclosingVerifierJsonObject,
  extractIssueTitlesFromParsedJson as extractVerifierIssueTitlesFromParsedJson,
  normalizeIssueTitle as normalizeVerifierIssueTitle,
  parseVerifierIssueTitles,
} from '../verification/issueParser';

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
      /** Streaming bubble ID to finalize; captured before finally clears streamingMsgId */
      streamingBubbleId: string | undefined;
      /** Command the AI suggested to run after Apply to verify its changes (e.g. "npm test"). */
      verifyCommand?: string;
      verificationSummary: {
        configuredSubAgents: number;
        invokedSubAgents: number;
        validSubAgents: number;
        unavailableSubAgents: number;
        verifierIssuesTotal: number;
        consensusIssueCount: number;
        reflectionUsed: boolean;
      };
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
  private lastToolFilePath: string | undefined;

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

  get isRunning(): boolean {
    return this.currentCancellationTokenSource !== undefined;
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
    this.lastToolFilePath = undefined;

    let succeeded = false;
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
        (command: string) => this.runCommandWithApproval(command, cancellationToken),
      );

      if (cancellationToken.isCancellationRequested) {
        return { status: 'cancelled' };
      }

      const lastEntry = conversationHistory[conversationHistory.length - 1];
      const isNewUserTurn = !lastEntry || lastEntry.role !== 'user' || lastEntry.content !== userMessage;

      succeeded = true;
      return {
        status: 'success',
        newUserTurn: isNewUserTurn ? { role: 'user', content: userMessage } : undefined,
        assistantTurn: { role: 'assistant', content: result.reflectedResponse },
        fileChanges: result.fileChanges,
        tokenUsage: result.tokenUsage,
        streamingBubbleId: this.streamingMsgId,
        verifyCommand: result.verifyCommand,
        verificationSummary: this.buildVerificationSummary(result.subAgentVerifications, subAgents.length),
      };
    } catch (err) {
      if (err instanceof vscode.CancellationError) {
        return { status: 'cancelled' };
      }
      return { status: 'error', error: err };
    } finally {
      if (!succeeded && this.streamingMsgId) {
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

      case 'main_agent_done':
        if (this.streamingMsgId) {
          this.emit({ type: 'stopStreaming', payload: { id: this.streamingMsgId } });
        }
        break;

      case 'tool_read':
        this.lastToolFilePath = event.filePath;
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

      case 'tool_run_command_chunk':
        if (this.streamingMsgId) {
          this.emit({ type: 'commandChunk', payload: { msgId: this.streamingMsgId, command: event.command, chunk: event.chunk } });
        }
        break;

      case 'tool_run_command_done':
        if (this.streamingMsgId) {
          this.emit({ type: 'commandOutput', payload: { msgId: this.streamingMsgId, command: event.command, stdout: event.stdout, exitCode: event.exitCode } });
        }
        break;

      case 'tool_write_file':
        this.lastToolFilePath = event.filePath;
        if (this.streamingMsgId) {
          this.emit({ type: 'toolCallProgress', payload: { msgId: this.streamingMsgId, filePath: `✎ ${event.filePath}` } });
        }
        break;

      case 'tool_delete_file':
        this.lastToolFilePath = event.filePath;
        if (this.streamingMsgId) {
          this.emit({ type: 'toolCallProgress', payload: { msgId: this.streamingMsgId, filePath: `✗ ${event.filePath}` } });
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

  private async runCommandWithApproval(command: string, cancellationToken?: vscode.CancellationToken): Promise<CommandOutput> {
    const MAX_PREVIEW = 300;
    const preview = command.length > MAX_PREVIEW
      ? command.slice(0, MAX_PREVIEW) + `\n… (${command.length - MAX_PREVIEW} more chars)`
      : command;
    const choice = await vscode.window.showWarningMessage(
      `Agent wants to run a command:\n\n${preview}`,
      { modal: true },
      'Run',
    );

    if (choice !== 'Run') {
      return { command, stdout: '[User denied command execution]', exitCode: 1 };
    }

    const workspaceRoot = resolveWorkspaceRootForCommand({
      candidateFilePaths: this.lastToolFilePath ? [this.lastToolFilePath] : [],
    });
    const config = await this.configManager.getConfig();
    const msgId = this.streamingMsgId;
    const onChunk = msgId
      ? (chunk: string) => this.emit({ type: 'commandChunk', payload: { msgId, command, chunk } })
      : undefined;
    return execCommand(command, workspaceRoot, config.runnerTimeoutMs, cancellationToken, onChunk);
  }

  private buildAgentRunner(config: ExtensionConfig): AgentRunner {
    const copilotProvider = new CopilotProvider();
    copilotProvider.setPreferredFamily(config.copilotModelFamily);
    copilotProvider.setModelTier(config.modelTier);
    const apiKeyProvider = new ApiKeyProvider({
      anthropicApiKey: config.anthropicApiKey,
      openaiApiKey: config.openaiApiKey,
      googleApiKey: config.googleApiKey,
      deepseekApiKey: config.deepseekApiKey,
      modelTier: config.modelTier,
    });

    return new AgentRunner({
      copilotProvider,
      apiKeyProvider,
      providerMode: config.providerMode,
      workspaceReader: this.workspaceReader,
    });
  }

  private buildVerificationSummary(
    verifications: Array<{ feedback: string }>,
    configuredSubAgents: number,
  ): {
    configuredSubAgents: number;
    invokedSubAgents: number;
    validSubAgents: number;
    unavailableSubAgents: number;
    verifierIssuesTotal: number;
    consensusIssueCount: number;
    reflectionUsed: boolean;
  } {
    const unavailableSubAgents = verifications.filter((v) => v.feedback.startsWith('[Verification unavailable')).length;
    const validFeedbacks = verifications
      .map((v) => v.feedback)
      .filter((feedback) => !feedback.startsWith('[Verification unavailable'));
    const parsedIssuesByVerifier = validFeedbacks.map((feedback) => this.extractIssueTitles(feedback));
    const verifierIssuesTotal = parsedIssuesByVerifier.reduce((acc, items) => acc + items.length, 0);

    const counts = new Map<string, number>();
    for (const issues of parsedIssuesByVerifier) {
      const unique = new Set<string>();
      for (const issue of issues) {
        const key = this.normalizeIssueTitle(issue);
        if (!key || unique.has(key)) {
          continue;
        }
        unique.add(key);
      }
      for (const key of unique) {
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }

    const validSubAgents = parsedIssuesByVerifier.length;
    const consensusIssueCount = validSubAgents > 0
      ? Array.from(counts.values()).filter((count) => count === validSubAgents).length
      : 0;

    return {
      configuredSubAgents,
      invokedSubAgents: verifications.length,
      validSubAgents,
      unavailableSubAgents,
      verifierIssuesTotal,
      consensusIssueCount,
      reflectionUsed: validSubAgents > 0,
    };
  }

  private extractIssueTitles(feedback: string): string[] {
    return parseVerifierIssueTitles(feedback);
  }

  public extractEnclosingJsonObject(text: string, requiredToken: string): string | null {
    return extractEnclosingVerifierJsonObject(text, requiredToken);
  }

  public extractIssueTitlesFromParsedJson(parsed: unknown): string[] | null {
    return extractVerifierIssueTitlesFromParsedJson(parsed);
  }

  private normalizeIssueTitle(issue: string): string {
    return normalizeVerifierIssueTitle(issue);
  }
}

export function execCommand(
  command: string,
  cwd: string | undefined,
  timeoutMs: number,
  cancellationToken?: vscode.CancellationToken,
  onChunk?: (chunk: string) => void,
): Promise<CommandOutput> {
  const sanitized = sanitizeCommandForWorkspace(command);
  const displayCommand = sanitized.skipped ? sanitized.original : sanitized.effective;
  const normalizedPrefix = sanitized.normalized && sanitized.note
    ? `[Command normalized] ${sanitized.note}\n\n`
    : '';

  if (sanitized.skipped) {
    return Promise.resolve({
      command: displayCommand,
      stdout: sanitized.note ?? '[Skipped command]',
      exitCode: 0,
    });
  }

  return new Promise((resolve) => {
    let cancelDisposable: vscode.Disposable | undefined;
    let timeout: NodeJS.Timeout | undefined;

    try {
      const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
      const shellFlag = process.platform === 'win32' ? '/c' : '-c';
      const child = cp.spawn(shell, [shellFlag, sanitized.effective], {
        cwd,
        env: process.env,
        detached: process.platform !== 'win32',
      });

      const chunks: string[] = [];
      let resolved = false;
      let totalBytes = 0;

      const cleanup = (): void => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = undefined;
        }
        cancelDisposable?.dispose();
        cancelDisposable = undefined;
      };

      const finish = (stdout: string, exitCode: number): void => {
        if (resolved) {return;}
        resolved = true;
        cleanup();
        resolve({ command: displayCommand, stdout: normalizedPrefix + stdout, exitCode });
      };

      const handleData = (data: Buffer) => {
        if (resolved) {return;}
        const text = data.toString('utf8');
        totalBytes += text.length;
        if (totalBytes > EXEC_MAX_OUTPUT) {return;} // stop accumulating but keep process running
        chunks.push(text);
        if (onChunk) {
          onChunk(text);
        }
      };

      child.stdout.on('data', (d: Buffer) => handleData(d));
      child.stderr.on('data', (d: Buffer) => handleData(d));

      timeout = setTimeout(() => {
        terminateCommandProcess(child);
        const stdout = chunks.join('') || '(no output)';
        finish(`${stdout}\n[Timed out]`, 1);
      }, timeoutMs);

      child.on('close', (code) => {
        if (resolved) {return;}
        let stdout = chunks.join('') || '(no output)';
        if (totalBytes > EXEC_MAX_OUTPUT) {
          stdout += `\n[... output truncated at ${EXEC_MAX_OUTPUT} bytes ...]`;
        }
        finish(stdout, code ?? 1);
      });

      child.on('error', (err) => {
        finish(String(err), 1);
      });

      cancelDisposable = cancellationToken?.onCancellationRequested(() => {
        if (resolved) {
          return;
        }
        terminateCommandProcess(child);
        const cancelledOutput = chunks.length > 0
          ? `${chunks.join('')}\n[Cancelled]`
          : '[Cancelled]';
        finish(cancelledOutput, 1);
      });
    } catch (syncErr) {
      if (timeout) {
        clearTimeout(timeout);
      }
      cancelDisposable?.dispose();
      resolve({ command: displayCommand, stdout: normalizedPrefix + String(syncErr), exitCode: 1 });
    }
  });
}

function terminateCommandProcess(child: cp.ChildProcess): void {
  if (process.platform === 'win32') {
    const pid = child.pid;
    if (typeof pid === 'number' && pid > 0) {
      try {
        const killer = cp.spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
        killer.on('error', () => {
          child.kill();
        });
        return;
      } catch {
        child.kill();
        return;
      }
    }
    child.kill();
    return;
  }

  const pid = child.pid;
  if (typeof pid === 'number' && pid > 0) {
    try {
      process.kill(-pid, 'SIGTERM');
      setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) {
          return;
        }
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }, 1000).unref();
      return;
    } catch {
      // Fall through to direct kill.
    }
  }

  child.kill();
}
