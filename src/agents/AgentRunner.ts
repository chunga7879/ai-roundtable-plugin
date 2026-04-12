import * as vscode from 'vscode';
import type {
  AgentName,
  AgentResponse,
  CommandOutput,
  ConversationTurn,
  FileChange,
  RoundRequest,
  RoundResult,
  SubAgentVerification,
  ToolCall,
  ToolResult,
  TokenUsage,
} from '../types';
import { ProviderMode, RoundType } from '../types';
import { buildSystemPrompt } from '../prompts/roundPrompts';
import type { CopilotProvider } from './CopilotProvider';
import { CopilotProviderError } from './CopilotProvider';
import type { ApiKeyProvider } from './ApiKeyProvider';
import { ApiKeyProviderError } from './ApiKeyProvider';
import type { WorkspaceReader } from '../workspace/WorkspaceReader';
import { RoundtableError } from '../errors';
import {
  normalizeIssueTitle as normalizeVerifierIssueTitle,
  parseVerifierIssueTitles,
} from '../verification/issueParser';
import { RoundExecutionStages } from './RoundExecutionStages';
import type { RoundToolHandlers } from './RoundExecutionStages';

const TOOL_RECOVERY_ROUNDS = new Set<RoundType>([
  RoundType.REQUIREMENTS,
  RoundType.ARCHITECT,
  RoundType.DEVELOPER,
  RoundType.QA,
  RoundType.DEVOPS,
  RoundType.DOCUMENTATION,
]);
export class AgentRunnerError extends RoundtableError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'AgentRunnerError';
  }
}

interface AgentRunnerDependencies {
  copilotProvider: CopilotProvider;
  apiKeyProvider: ApiKeyProvider;
  providerMode: ProviderMode;
  workspaceReader: WorkspaceReader;
}

interface CallAgentOptions {
  systemPrompt: string;
  userMessage: string;
  conversationHistory?: ConversationTurn[];
  onChunk?: (chunk: string) => void;
  onToolCall?: (toolCall: ToolCall) => Promise<ToolResult>;
  enabledTools?: ToolCall['name'][];
}

export class AgentRunner {
  private readonly copilotProvider: CopilotProvider;
  private readonly apiKeyProvider: ApiKeyProvider;
  private readonly providerMode: ProviderMode;
  private readonly workspaceReader: WorkspaceReader;

  constructor(deps: AgentRunnerDependencies) {
    this.copilotProvider = deps.copilotProvider;
    this.apiKeyProvider = deps.apiKeyProvider;
    this.providerMode = deps.providerMode;
    this.workspaceReader = deps.workspaceReader;
  }

  async runRound(
    request: RoundRequest,
    cancellationToken: vscode.CancellationToken,
    onProgress: (event: ProgressEvent) => void,
    onRunCommand?: (command: string) => Promise<CommandOutput>,
  ): Promise<RoundResult> {
    const {
      roundType,
      mainAgent,
      subAgents,
      userMessage,
      workspaceContext,
      conversationHistory,
      cachedFiles,
      cachedCommandOutputs,
    } = request;
    const systemPrompt = buildSystemPrompt(roundType);
    const stages = new RoundExecutionStages({
      workspaceReader: this.workspaceReader,
      callAgent: (agentName, options, token) => this.callAgent(agentName, options, token),
      shouldRetryMissingToolWrites: (type, response) => this.shouldRetryMissingToolWrites(type, response),
      buildMissingToolWriteRecoveryPrompt: (originalUserMessage, mainAgentResponse) =>
        this.buildMissingToolWriteRecoveryPrompt(originalUserMessage, mainAgentResponse),
      toSafeErrorMessage: (err) => this.toSafeErrorMessage(err),
      extractConsensusIssues: (verifications) => this.extractConsensusIssues(verifications),
      awaitWithCancellation: (promise, token) => this.awaitWithCancellation(promise, token),
    });
    const fullUserMessage = stages.buildFullUserMessage(
      workspaceContext,
      cachedFiles,
      userMessage,
      (context, cache) => this.buildFileListSection(context, cache),
    );
    const toolHandlers: RoundToolHandlers = stages.createRoundToolHandlers({
      mainAgent,
      onProgress,
      onRunCommand,
      cachedFiles,
      cachedCommandOutputs,
    });

    const totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    const addUsage = (usage?: TokenUsage) => {
      if (usage) {
        totalUsage.inputTokens += usage.inputTokens;
        totalUsage.outputTokens += usage.outputTokens;
      }
    };

    const { mainAgentResponse, mainAgentFileChanges } = await stages.runMainAgentStage({
      mainAgent,
      roundType,
      userMessage,
      systemPrompt,
      fullUserMessage,
      conversationHistory,
      cancellationToken,
      onProgress,
      toolHandlers,
      addUsage,
    });

    const subAgentVerifications = await stages.runSubAgentVerificationStage({
      roundType,
      mainAgent,
      subAgents,
      userMessage,
      mainAgentResponse,
      mainAgentFileChanges,
      conversationHistory,
      cachedFiles,
      cachedCommandOutputs,
      cancellationToken,
      onProgress,
      addUsage,
    });

    const reflectedResponse = await stages.runReflectionStage({
      roundType,
      mainAgent,
      mainAgentResponse,
      mainAgentFileChanges,
      subAgentVerifications,
      cancellationToken,
      onProgress,
      toolHandlers,
      addUsage,
    });

    const fileChanges: FileChange[] = [...toolHandlers.getAllFileChanges()];
    const { displayResponse, verifyCommand } = this.parseVerifyCommandFromResponse(reflectedResponse);
    const hasUsage = totalUsage.inputTokens > 0 || totalUsage.outputTokens > 0;

    return {
      mainAgentResponse,
      subAgentVerifications,
      reflectedResponse: displayResponse,
      fileChanges,
      tokenUsage: hasUsage ? totalUsage : undefined,
      verifyCommand,
    };
  }

  private async callAgent(
    agentName: AgentName,
    options: CallAgentOptions,
    cancellationToken: vscode.CancellationToken,
  ): Promise<{ content: string; usage?: TokenUsage }> {
    try {
      if (this.providerMode === ProviderMode.COPILOT) {
        const content = await this.copilotProvider.sendRequest(
          { ...options, onChunk: options.onChunk },
          agentName,
          cancellationToken,
        );
        return { content };
      }

      // API key mode — route to the appropriate provider
      if (!this.apiKeyProvider.hasKeyForAgent(agentName)) {
        throw new AgentRunnerError(
          `No API key configured for ${agentName}. Please run "AI Roundtable: Configure Provider".`,
        );
      }

      return await this.apiKeyProvider.sendRequest(agentName, { ...options, cancellationToken });
    } catch (err) {
      if (err instanceof vscode.CancellationError) {
        throw err;
      }
      // CancellationError from ApiKeyProvider (panel closed mid-request)
      if (err instanceof Error && err.name === 'CancellationError') {
        throw new vscode.CancellationError();
      }
      if (err instanceof AgentRunnerError) {
        throw err;
      }
      if (
        err instanceof CopilotProviderError ||
        err instanceof ApiKeyProviderError
      ) {
        throw new AgentRunnerError(
          `Agent ${agentName} failed: ${err.message}`,
          err,
        );
      }
      throw new AgentRunnerError(
        `Unexpected error from agent ${agentName}: ${this.toSafeErrorMessage(err)}`,
        err,
      );
    }
  }

  private async awaitWithCancellation<T>(
    promise: Promise<T>,
    cancellationToken: vscode.CancellationToken,
  ): Promise<T> {
    if (cancellationToken.isCancellationRequested) {
      throw new vscode.CancellationError();
    }

    let cancelDisposable: vscode.Disposable | undefined;
    const cancellationPromise = new Promise<never>((_, reject) => {
      cancelDisposable = cancellationToken.onCancellationRequested(() => {
        reject(new vscode.CancellationError());
      });
    });

    try {
      return await Promise.race([promise, cancellationPromise]);
    } finally {
      cancelDisposable?.dispose();
    }
  }

  private shouldRetryMissingToolWrites(roundType: RoundType, response: string): boolean {
    if (!TOOL_RECOVERY_ROUNDS.has(roundType)) {
      return false;
    }
    const trimmed = response.trim();
    if (!trimmed) {
      return false;
    }
    return trimmed.includes('```') || /^\s*FILE\s*:/im.test(trimmed);
  }

  private buildMissingToolWriteRecoveryPrompt(userMessage: string, mainAgentResponse: string): string {
    return [
      'Your previous response appears to include code/file changes, but no write_file/delete_file tool calls were made.',
      'Re-emit those changes NOW using tool calls only.',
      '',
      'MANDATORY:',
      '- Use write_file for each created/modified file and delete_file for deletions.',
      '- Do not output markdown fences or file content in prose.',
      '- If truly no file changes are needed, output exactly: NO_FILE_CHANGES_NEEDED',
      '',
      '[ORIGINAL USER REQUEST]',
      userMessage,
      '[END ORIGINAL USER REQUEST]',
      '',
      '[YOUR PREVIOUS RESPONSE]',
      mainAgentResponse,
      '[END YOUR PREVIOUS RESPONSE]',
    ].join('\n');
  }

  /**
   * Converts an unknown thrown value to a user-safe error message string.
   * Ensures API keys or internal stack traces are not included.
   */
  private toSafeErrorMessage(err: unknown): string {
    if (err instanceof Error) {
      // Use only the message, not the stack
      return err.message;
    }
    return 'An unexpected error occurred.';
  }

  private buildFileListSection(
    workspaceContext: RoundRequest['workspaceContext'],
    cachedFiles: Map<string, string>,
  ): string {
    if (workspaceContext.files.length === 0) {
      return '';
    }

    const activeNote = workspaceContext.activeFilePath
      ? `Currently active file: ${workspaceContext.activeFilePath}\n\n`
      : '';

    // Separate files into cached (include content) and uncached (list only).
    // Use [FILE: path] brackets to distinguish input context from write_file output calls.
    const cachedSection = workspaceContext.files
      .filter((f) => cachedFiles.has(f.path))
      .map((f) => `[FILE: ${f.path}]\n\`\`\`\n${cachedFiles.get(f.path)}\n\`\`\``)
      .join('\n\n');

    const uncachedList = workspaceContext.files
      .filter((f) => !cachedFiles.has(f.path))
      .map((f) => f.path)
      .join('\n');

    const parts: string[] = [];
    if (cachedSection) {parts.push(`[FILES FROM PREVIOUS TURN]\n${cachedSection}\n[END FILES FROM PREVIOUS TURN]`);}
    if (uncachedList) {parts.push(`[WORKSPACE FILES]\n${activeNote}${uncachedList}\n[END WORKSPACE FILES]\n\nUse the read_file tool to read any file you need.`);}

    return parts.join('\n\n');
  }

  private parseVerifyCommandFromResponse(response: string): { displayResponse: string; verifyCommand?: string } {
    // Preferred token: VERIFY. Legacy fallback: RUN.
    const verifyPrefix = 'VERIFY:';
    const legacyRunPrefix = 'RUN:';
    let verifyCommandFromVerify: string | undefined;
    let verifyCommandFromRun: string | undefined;
    const filteredLines: string[] = [];
    let inCodeBlock = false;

    for (const line of response.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        filteredLines.push(line);
        continue;
      }

      if (!inCodeBlock && trimmed.startsWith(verifyPrefix)) {
        const cmd = trimmed.slice(verifyPrefix.length).trim();
        if (cmd.length > 0) {
          verifyCommandFromVerify = cmd;
        }
        continue;
      }

      if (!inCodeBlock && trimmed.startsWith(legacyRunPrefix)) {
        const cmd = trimmed.slice(legacyRunPrefix.length).trim();
        if (cmd.length > 0) {
          verifyCommandFromRun = cmd;
        }
        continue;
      }

      filteredLines.push(line);
    }

    const verifyCommand = verifyCommandFromVerify ?? verifyCommandFromRun;
    return {
      verifyCommand,
      displayResponse: verifyCommand
        ? filteredLines.join('\n').trimEnd()
        : response,
    };
  }

  /**
   * Extracts issue titles from sub-agent feedback and returns issues that were
   * flagged by every valid sub-agent (consensus).
   */
  private extractConsensusIssues(verifications: SubAgentVerification[]): string[] {
    if (verifications.length < 2) {
      return [];
    }

    const counts = new Map<string, number>();
    const canonicalLabelByKey = new Map<string, string>();

    for (const verification of verifications) {
      const titles = parseVerifierIssueTitles(verification.feedback);
      const uniqueKeysForAgent = new Set<string>();
      for (const title of titles) {
        const key = normalizeVerifierIssueTitle(title);
        if (!key || uniqueKeysForAgent.has(key)) {
          continue;
        }
        uniqueKeysForAgent.add(key);
        canonicalLabelByKey.set(key, canonicalLabelByKey.get(key) ?? title);
      }
      for (const key of uniqueKeysForAgent) {
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }

    const requiredCount = verifications.length;
    const consensusKeys = Array.from(counts.entries())
      .filter(([, count]) => count === requiredCount)
      .map(([key]) => key);

    return consensusKeys
      .map((key) => canonicalLabelByKey.get(key) ?? key)
      .slice(0, 12);
  }
}

export type ProgressEvent =
  | { type: 'main_agent_start'; agentName: AgentName }
  | { type: 'main_agent_chunk'; agentName: AgentName; chunk: string }
  | { type: 'main_agent_done'; agentName: AgentName }
  | { type: 'tool_read'; agentName: AgentName; filePath: string }
  | { type: 'tool_run_command'; agentName: AgentName; command: string }
  | { type: 'tool_run_command_chunk'; agentName: AgentName; command: string; chunk: string }
  | { type: 'tool_run_command_done'; agentName: AgentName; command: string; stdout: string; exitCode: number }
  | { type: 'tool_write_file'; agentName: AgentName; filePath: string }
  | { type: 'tool_delete_file'; agentName: AgentName; filePath: string }
  | { type: 'sub_agents_start'; agentNames: AgentName[] }
  | { type: 'sub_agent_feedback'; agentName: AgentName; feedback: string }
  | { type: 'sub_agents_done'; agentNames: AgentName[] }
  | { type: 'reflection_start'; agentName: AgentName; mainAgentResponse: string }
  | { type: 'reflection_chunk'; agentName: AgentName; chunk: string }
  | { type: 'reflection_done'; agentName: AgentName };

export type { AgentResponse, FileChange };
