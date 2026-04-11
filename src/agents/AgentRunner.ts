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
import {
  buildReflectionPrompt,
  buildReflectionSystemPrompt,
  buildSubAgentSystemPrompt,
  buildSubAgentUserMessage,
  buildSystemPrompt,
} from '../prompts/roundPrompts';
import type { CopilotProvider } from './CopilotProvider';
import { CopilotProviderError } from './CopilotProvider';
import type { ApiKeyProvider } from './ApiKeyProvider';
import { ApiKeyProviderError } from './ApiKeyProvider';
import { normalizePath } from '../workspace/WorkspaceWriter';
import type { WorkspaceReader } from '../workspace/WorkspaceReader';
import { MAX_TOOL_CALLS } from '../workspace/WorkspaceReader';
import { RoundtableError } from '../errors';

const TOOL_RECOVERY_ROUNDS = new Set<RoundType>([
  RoundType.REQUIREMENTS,
  RoundType.ARCHITECT,
  RoundType.DEVELOPER,
  RoundType.QA,
  RoundType.DEVOPS,
  RoundType.DOCUMENTATION,
]);
const REFLECTION_ENABLED_TOOLS: ToolCall['name'][] = ['write_file', 'delete_file'];

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
    const { roundType, mainAgent, subAgents, userMessage, workspaceContext, conversationHistory, cachedFiles, cachedCommandOutputs } =
      request;

    const systemPrompt = buildSystemPrompt(roundType);

    // Build initial user message: file list + any cached file contents from previous turn
    const fileListSection = this.buildFileListSection(workspaceContext, cachedFiles);
    const fullUserMessage = fileListSection
      ? `${fileListSection}\n\n---\n\nUser Request:\n${userMessage}`
      : userMessage;

    let toolCallCount = 0;
    let reflectionWriteCount = 0;
    const MAX_REFLECTION_WRITES = 20;
    let allowedReflectionFilePaths: Set<string> = new Set();
    // Accumulates files written via write_file tool across all callAgent invocations.
    const allFileChanges: FileChange[] = [];

    const makeToolHandler = (): ((toolCall: ToolCall) => Promise<ToolResult>) => {
      return async (toolCall: ToolCall): Promise<ToolResult> => {
        if (toolCall.name === 'run_command') {
          if (!onRunCommand) {
            return { id: toolCall.id, content: 'Command execution is not available in this context.', isError: true };
          }
          onProgress({ type: 'tool_run_command', agentName: mainAgent, command: toolCall.command });
          const output = await onRunCommand(toolCall.command);
          const displayCommand = output.command || toolCall.command;
          cachedCommandOutputs.set(displayCommand, output);
          onProgress({ type: 'tool_run_command_done', agentName: mainAgent, command: displayCommand, stdout: output.stdout || '(no output)', exitCode: output.exitCode });
          const resultText = `Exit code: ${output.exitCode}\n\nOutput:\n${output.stdout || '(no output)'}`;
          return { id: toolCall.id, content: resultText, isError: output.exitCode !== 0 };
        }

        if (toolCall.name === 'write_file') {
          const normalized = normalizePath(toolCall.filePath);
          if (!normalized) {
            return { id: toolCall.id, content: `Invalid file path: ${toolCall.filePath}`, isError: true };
          }
          onProgress({ type: 'tool_write_file', agentName: mainAgent, filePath: normalized });
          const existing = allFileChanges.findIndex((f) => f.filePath === normalized);
          const change: FileChange = { filePath: normalized, content: toolCall.content, isNew: false };
          if (existing >= 0) {
            allFileChanges[existing] = change;
          } else {
            allFileChanges.push(change);
          }
          return { id: toolCall.id, content: `Staged write to ${normalized}`, isError: false };
        }

        if (toolCall.name === 'delete_file') {
          const normalized = normalizePath(toolCall.filePath);
          if (!normalized) {
            return { id: toolCall.id, content: `Invalid file path: ${toolCall.filePath}`, isError: true };
          }
          onProgress({ type: 'tool_delete_file', agentName: mainAgent, filePath: normalized });
          const existing = allFileChanges.findIndex((f) => f.filePath === normalized);
          const change: FileChange = { filePath: normalized, content: '', isNew: false, isDeleted: true };
          if (existing >= 0) {
            allFileChanges[existing] = change;
          } else {
            allFileChanges.push(change);
          }
          return { id: toolCall.id, content: `Staged delete of ${normalized}`, isError: false };
        }

        // read_file
        const cached = cachedFiles.get(toolCall.filePath);
        if (cached !== undefined) {
          onProgress({ type: 'tool_read', agentName: mainAgent, filePath: toolCall.filePath });
          return { id: toolCall.id, content: cached, isError: false };
        }

        if (toolCallCount >= MAX_TOOL_CALLS) {
          return {
            id: toolCall.id,
            content: `Tool call limit (${MAX_TOOL_CALLS}) reached. Work with the files already provided.`,
            isError: true,
          };
        }
        toolCallCount++;
        onProgress({ type: 'tool_read', agentName: mainAgent, filePath: toolCall.filePath });
        const result = await this.workspaceReader.readFileForTool(toolCall.filePath);
        if (!result.isError) {
          cachedFiles.set(toolCall.filePath, result.content);
        }
        return { id: toolCall.id, content: result.content, isError: result.isError };
      };
    };

    // Reflection-only tool handler: allows write_file and delete_file only.
    // run_command is blocked (staged files are not yet on disk).
    // read_file is blocked (file contents are inlined in the reflection prompt).
    const makeReflectionToolHandler = (): ((toolCall: ToolCall) => Promise<ToolResult>) => {
      return (toolCall: ToolCall): Promise<ToolResult> => {
        const resolve = (result: ToolResult): Promise<ToolResult> => Promise.resolve(result);
        if (toolCall.name === 'write_file') {
          if (reflectionWriteCount >= MAX_REFLECTION_WRITES) {
            return resolve({ id: toolCall.id, content: `Reflection write limit (${MAX_REFLECTION_WRITES}) reached.`, isError: true });
          }
          const normalized = normalizePath(toolCall.filePath);
          if (!normalized) {
            return resolve({ id: toolCall.id, content: `Invalid file path: ${toolCall.filePath}`, isError: true });
          }
          if (!allowedReflectionFilePaths.has(normalized)) {
            return resolve({
              id: toolCall.id,
              content: `Reflection may only modify files written in the initial response. Blocked path: ${normalized}`,
              isError: true,
            });
          }
          reflectionWriteCount++;
          onProgress({ type: 'tool_write_file', agentName: mainAgent, filePath: normalized });
          const existing = allFileChanges.findIndex((f) => f.filePath === normalized);
          const change: FileChange = { filePath: normalized, content: toolCall.content, isNew: false };
          if (existing >= 0) {
            allFileChanges[existing] = change;
          } else {
            allFileChanges.push(change);
          }
          return resolve({ id: toolCall.id, content: `Staged write to ${normalized}`, isError: false });
        }

        if (toolCall.name === 'delete_file') {
          const normalized = normalizePath(toolCall.filePath);
          if (!normalized) {
            return resolve({ id: toolCall.id, content: `Invalid file path: ${toolCall.filePath}`, isError: true });
          }
          if (!allowedReflectionFilePaths.has(normalized)) {
            return resolve({
              id: toolCall.id,
              content: `Reflection may only modify files written in the initial response. Blocked path: ${normalized}`,
              isError: true,
            });
          }
          onProgress({ type: 'tool_delete_file', agentName: mainAgent, filePath: normalized });
          const existing = allFileChanges.findIndex((f) => f.filePath === normalized);
          const change: FileChange = { filePath: normalized, content: '', isNew: false, isDeleted: true };
          if (existing >= 0) {
            allFileChanges[existing] = change;
          } else {
            allFileChanges.push(change);
          }
          return resolve({ id: toolCall.id, content: `Staged delete of ${normalized}`, isError: false });
        }

        if (toolCall.name === 'run_command') {
          return resolve({
            id: toolCall.id,
            content: 'run_command is not available during reflection. Use VERIFY: to suggest post-apply commands.',
            isError: true,
          });
        }

        // read_file: blocked — file contents are already inlined in the reflection prompt
        return resolve({
          id: toolCall.id,
          content: 'read_file is not available during reflection. File contents are already provided in the prompt.',
          isError: true,
        });
      };
    };

    // Accumulate token usage across all calls
    const totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    const addUsage = (usage?: TokenUsage) => {
      if (usage) {
        totalUsage.inputTokens += usage.inputTokens;
        totalUsage.outputTokens += usage.outputTokens;
      }
    };

    // Step 1: Main agent initial response (with tool calls for file reading/writing)
    onProgress({ type: 'main_agent_start', agentName: mainAgent });

    const { content: mainAgentResponse, usage: mainUsage } = await this.callAgent(
      mainAgent,
      {
        systemPrompt,
        userMessage: fullUserMessage,
        conversationHistory,
        onChunk: (chunk) => onProgress({ type: 'main_agent_chunk', agentName: mainAgent, chunk }),
        onToolCall: makeToolHandler(),
      },
      cancellationToken,
    );
    addUsage(mainUsage);

    // Propagate cancellation immediately after each await
    if (cancellationToken.isCancellationRequested) {
      throw new vscode.CancellationError();
    }

    // Recovery pass: if the model produced code-like text but staged no writes,
    // ask it once to re-emit using write_file/delete_file tool calls.
    if (allFileChanges.length === 0 && this.shouldRetryMissingToolWrites(roundType, mainAgentResponse)) {
      const { usage: recoveryUsage } = await this.callAgent(
        mainAgent,
        {
          systemPrompt,
          userMessage: this.buildMissingToolWriteRecoveryPrompt(userMessage, mainAgentResponse),
          conversationHistory,
          onToolCall: makeToolHandler(),
        },
        cancellationToken,
      );
      addUsage(recoveryUsage);
      if (cancellationToken.isCancellationRequested) {
        throw new vscode.CancellationError();
      }
    }

    onProgress({ type: 'main_agent_done', agentName: mainAgent });

    // Snapshot files written during the main agent turn — used to build reflection context.
    const mainAgentFileChanges = [...allFileChanges];

    // Step 2: Sub agents verify in parallel (skip if none selected or same as main)
    const uniqueSubAgents = Array.from(new Set(subAgents)).filter((a) => a !== mainAgent);
    let subAgentVerifications: SubAgentVerification[] = [];

    if (uniqueSubAgents.length > 0) {
      // System prompt: verifier role + expertise only (no data)
      const verificationSystemPrompt = buildSubAgentSystemPrompt(roundType);

      onProgress({
        type: 'sub_agents_start',
        agentNames: uniqueSubAgents,
      });

      // Build prior user turns as context for sub-agents
      const priorUserTurns = conversationHistory
        .filter((t) => t.role === 'user')
        .map((t, i) => `[User request ${i + 1}]: ${t.content}`)
        .join('\n');

      // Include all files available to the main agent (cachedFiles already contains newly-read files)
      const allFilesForSubAgent = Array.from(cachedFiles.entries()).map(([path, content]) => ({ path, content }));
      const resolvedFilesSection = allFilesForSubAgent.length > 0
        ? `[FILES READ BY PRIMARY AGENT]\n\n${allFilesForSubAgent
            .map((f) => `[FILE: ${f.path}]\n\`\`\`\n${f.content}\n\`\`\``)
            .join('\n\n')}\n\n[END FILES]`
        : '';
      const writtenFilesSection = mainAgentFileChanges.length > 0
        ? `[FILES WRITTEN BY PRIMARY AGENT]\n\n${mainAgentFileChanges
            .map((f) => (
              f.isDeleted
                ? `[FILE DELETED: ${f.filePath}]`
                : `[FILE: ${f.filePath}]\n\`\`\`\n${f.content}\n\`\`\``
            ))
            .join('\n\n')}\n\n[END WRITTEN FILES]`
        : '';

      // Include command outputs so sub-agents can verify the primary agent's interpretation
      const commandOutputsSection = cachedCommandOutputs.size > 0
        ? `[COMMANDS RUN BY PRIMARY AGENT]\n\n${Array.from(cachedCommandOutputs.values())
            .map((o) => `Command: ${o.command}\nExit code: ${o.exitCode}\n\`\`\`\n${o.stdout || '(no output)'}\n\`\`\``)
            .join('\n\n')}\n\n[END COMMANDS]`
        : '';

      const baseMessage = priorUserTurns
        ? `Prior conversation context:\n${priorUserTurns}\n\nThe primary agent was given the current request:\n${userMessage}\n\nVerify whether its response (shown below) correctly and completely addresses this request.`
        : `The primary agent was given the following request:\n\n${userMessage}\n\nVerify whether its response (shown below) correctly and completely addresses this request.`;

      const contextSections = [resolvedFilesSection, writtenFilesSection, commandOutputsSection].filter(Boolean).join('\n\n');

      // User message: all data the verifier needs — files, commands, primary response, user request
      const subAgentUserMessage = buildSubAgentUserMessage(
        mainAgentResponse,
        contextSections,
        baseMessage,
      );

      const verificationPromises = uniqueSubAgents.map(async (agentName) => {
        try {
          const { content: feedback, usage: subUsage } = await this.callAgent(
            agentName,
            {
              systemPrompt: verificationSystemPrompt,
              userMessage: subAgentUserMessage,
            },
            cancellationToken,
          );
          addUsage(subUsage);
          return { agentName, feedback };
        } catch (err) {
          if (err instanceof vscode.CancellationError) {
            throw err;
          }
          // Graceful degradation: don't fail the round if a sub-agent fails.
          // The error message is sanitized (never exposes raw API errors).
          const safeMessage = this.toSafeErrorMessage(err);
          return {
            agentName,
            feedback: `[Verification unavailable: ${safeMessage}]`,
          };
        }
      });

      subAgentVerifications = await this.awaitWithCancellation(
        Promise.all(verificationPromises),
        cancellationToken,
      );

      if (cancellationToken.isCancellationRequested) {
        throw new vscode.CancellationError();
      }

      // Emit each verification result so the UI can show them before reflection starts
      for (const verification of subAgentVerifications) {
        onProgress({
          type: 'sub_agent_feedback',
          agentName: verification.agentName,
          feedback: verification.feedback,
        });
      }

      onProgress({
        type: 'sub_agents_done',
        agentNames: uniqueSubAgents,
      });
    }

    // Step 3: Main agent reflects on feedback (only if there are valid feedbacks)
    const validFeedbacks = subAgentVerifications.filter(
      (v) => !v.feedback.startsWith('[Verification unavailable'),
    );
    const mandatoryConsensusIssues = this.extractConsensusIssues(validFeedbacks);

    let reflectedResponse: string;

    if (validFeedbacks.length > 0) {
      onProgress({ type: 'reflection_start', agentName: mainAgent, mainAgentResponse });
      allowedReflectionFilePaths = new Set(mainAgentFileChanges.map((f) => f.filePath));

      // All rounds inline written file contents so reflection can apply precise fixes via write_file.
      const writtenFilesSection = mainAgentFileChanges.length > 0
        ? `\n\n[FILES WRITTEN VIA write_file TOOL — re-emit any file you modify using write_file]\n${mainAgentFileChanges
            .map((f) => (
              f.isDeleted
                ? `[FILE DELETED: ${f.filePath}]`
                : `[FILE: ${f.filePath}]\n\`\`\`\n${f.content}\n\`\`\``
            ))
            .join('\n\n')}`
        : '';
      const reflectionMainResponse = mainAgentResponse + writtenFilesSection;
      const reflectionUserMessage = buildReflectionPrompt(
        reflectionMainResponse,
        validFeedbacks.map((v) => ({
          agentName: v.agentName,
          feedback: v.feedback,
        })),
        mandatoryConsensusIssues,
      );

      const { content: reflected, usage: reflectUsage } = await this.callAgent(
        mainAgent,
        {
          systemPrompt: buildReflectionSystemPrompt(roundType),
          userMessage: reflectionUserMessage,
          onChunk: (chunk) => onProgress({ type: 'reflection_chunk', agentName: mainAgent, chunk }),
          onToolCall: makeReflectionToolHandler(),
          enabledTools: REFLECTION_ENABLED_TOOLS,
        },
        cancellationToken,
      );
      reflectedResponse = reflected;
      addUsage(reflectUsage);

      if (cancellationToken.isCancellationRequested) {
        throw new vscode.CancellationError();
      }

      onProgress({ type: 'reflection_done', agentName: mainAgent });
    } else {
      reflectedResponse = mainAgentResponse;
    }

    // Step 4: Collect file changes from write_file tool calls.
    const fileChanges: FileChange[] = [...allFileChanges];

    // Step 5: Extract optional VERIFY: token from the final response.
    // The AI outputs "VERIFY: <command>" on its own line to suggest a post-Apply
    // verification command (e.g. "VERIFY: npm test"). This is stripped from the
    // displayed response and surfaced to ChatPanel to present as an approve/deny
    // dialog after the user clicks Apply All Changes.
    //
    // Backwards compatibility: accept legacy "RUN:" lines as fallback only.
    // If both tokens are present, VERIFY takes precedence.
    const VERIFY_PREFIX = 'VERIFY:';
    const LEGACY_RUN_PREFIX = 'RUN:';
    let verifyCommandFromVerify: string | undefined;
    let verifyCommandFromRun: string | undefined;
    const responseLines = reflectedResponse.split('\n');
    const filteredLines: string[] = [];
    let inCodeBlock = false;
    for (const line of responseLines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        filteredLines.push(line);
        continue;
      }
      if (!inCodeBlock && trimmed.startsWith(VERIFY_PREFIX)) {
        const cmd = trimmed.slice(VERIFY_PREFIX.length).trim();
        if (cmd.length > 0) {
          verifyCommandFromVerify = cmd;
        }
      } else if (!inCodeBlock && trimmed.startsWith(LEGACY_RUN_PREFIX)) {
        const cmd = trimmed.slice(LEGACY_RUN_PREFIX.length).trim();
        if (cmd.length > 0) {
          verifyCommandFromRun = cmd;
        }
      } else {
        filteredLines.push(line);
      }
    }
    const verifyCommand = verifyCommandFromVerify ?? verifyCommandFromRun;
    const displayResponse = verifyCommand
      ? filteredLines.join('\n').trimEnd()
      : reflectedResponse;

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
      const titles = this.extractIssueTitles(verification.feedback);
      const uniqueKeysForAgent = new Set<string>();
      for (const title of titles) {
        const key = this.normalizeIssueTitle(title);
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

  /**
   * Pulls issue titles from a verifier response.
   * Preferred format:
   *   {"issues":[{"title":"...","detail":"..."}]}
   * Legacy fallback:
   *   ISSUES:
   *   - title
   *   DETAILS:
   */
  private extractIssueTitles(feedback: string): string[] {
    const jsonIssues = this.extractIssueTitlesFromJson(feedback);
    if (jsonIssues !== null) {
      return jsonIssues;
    }

    if (/ISSUES:\s*NONE/i.test(feedback)) {
      return [];
    }

    const issuesSection = feedback.match(/ISSUES:\s*([\s\S]*?)(?:\nDETAILS:|$)/i)?.[1] ?? feedback;
    const titles = issuesSection
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^([-*]|\d+\.)\s+/.test(line))
      .map((line) => line.replace(/^([-*]|\d+\.)\s+/, '').trim())
      .filter((line) => line.length > 0 && !/^(none|n\/a)$/i.test(line));

    return Array.from(new Set(titles)).slice(0, 20);
  }

  /**
   * Parses JSON verifier output. Returns:
   * - string[] when JSON parse succeeds (including empty array for no issues)
   * - null when no valid JSON issue payload is found (caller should fall back)
   */
  private extractIssueTitlesFromJson(feedback: string): string[] | null {
    const candidates = this.extractJsonCandidates(feedback);
    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate) as unknown;
        const titles = this.extractIssueTitlesFromParsedJson(parsed);
        if (titles !== null) {
          return titles;
        }
      } catch {
        // Ignore malformed JSON candidates and continue with others.
      }
    }
    return null;
  }

  /**
   * Returns JSON snippets from verifier feedback.
   * Priority:
   * 1) fenced code blocks
   * 2) entire feedback body
   */
  private extractJsonCandidates(feedback: string): string[] {
    const candidates: string[] = [];
    const pushUnique = (value: string): void => {
      const trimmed = value.trim();
      if (trimmed.length === 0 || candidates.includes(trimmed)) {
        return;
      }
      candidates.push(trimmed);
    };

    const fenced = feedback.match(/```(?:json)?\s*([\s\S]*?)```/gi) ?? [];
    for (const block of fenced) {
      const inner = block.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
      pushUnique(inner);
    }

    const whole = feedback.trim();
    if (whole.length === 0) {
      return candidates;
    }

    const extractedObject = this.extractEnclosingJsonObject(whole, '"issues"');
    if (extractedObject) {
      pushUnique(extractedObject);
    }
    pushUnique(whole);

    return candidates;
  }

  private extractEnclosingJsonObject(text: string, requiredToken: string): string | null {
    const tokenIndex = text.indexOf(requiredToken);
    if (tokenIndex === -1) {
      return null;
    }

    const objectStart = text.lastIndexOf('{', tokenIndex);
    if (objectStart === -1) {
      return null;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = objectStart; i < text.length; i++) {
      const ch = text[i];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === '\\') {
          escaped = true;
          continue;
        }
        if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === '{') {
        depth += 1;
        continue;
      }
      if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          return text.slice(objectStart, i + 1);
        }
      }
    }

    return null;
  }

  private extractIssueTitlesFromParsedJson(parsed: unknown): string[] | null {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }

    const payload = parsed as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(payload, 'issues')) {
      return null;
    }

    const issues = payload.issues;
    if (Array.isArray(issues)) {
      const titles = issues
        .map((item) => {
          if (typeof item === 'string') {
            return item.trim();
          }
          if (item && typeof item === 'object') {
            const title = (item as Record<string, unknown>).title;
            if (typeof title === 'string') {
              return title.trim();
            }
          }
          return '';
        })
        .filter((title) => title.length > 0 && !/^(none|n\/a)$/i.test(title));
      return Array.from(new Set(titles)).slice(0, 20);
    }

    if (typeof issues === 'string' && /^(none|n\/a)$/i.test(issues.trim())) {
      return [];
    }

    return [];
  }

  private normalizeIssueTitle(issue: string): string {
    return issue
      .toLowerCase()
      .replace(/[`"'()[\]{}]/g, '')
      .replace(/[^a-z0-9\s_-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
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
