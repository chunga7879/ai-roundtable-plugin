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
          cachedCommandOutputs.set(toolCall.command, output);
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

    onProgress({ type: 'main_agent_done', agentName: mainAgent });

    // Snapshot files written during the main agent turn — used to build reflection context.
    const mainAgentFileChanges = [...allFileChanges];

    // Step 2: Sub agents verify in parallel (skip if none selected or same as main)
    const uniqueSubAgents = subAgents.filter((a) => a !== mainAgent);
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

      // Include command outputs so sub-agents can verify the primary agent's interpretation
      const commandOutputsSection = cachedCommandOutputs.size > 0
        ? `[COMMANDS RUN BY PRIMARY AGENT]\n\n${Array.from(cachedCommandOutputs.values())
            .map((o) => `Command: ${o.command}\nExit code: ${o.exitCode}\n\`\`\`\n${o.stdout || '(no output)'}\n\`\`\``)
            .join('\n\n')}\n\n[END COMMANDS]`
        : '';

      const baseMessage = priorUserTurns
        ? `Prior conversation context:\n${priorUserTurns}\n\nThe primary agent was given the current request:\n${userMessage}\n\nVerify whether its response (shown below) correctly and completely addresses this request.`
        : `The primary agent was given the following request:\n\n${userMessage}\n\nVerify whether its response (shown below) correctly and completely addresses this request.`;

      const contextSections = [resolvedFilesSection, commandOutputsSection].filter(Boolean).join('\n\n');

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

      subAgentVerifications = await Promise.all(verificationPromises);

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

    let reflectedResponse: string;

    if (validFeedbacks.length > 0) {
      onProgress({ type: 'reflection_start', agentName: mainAgent, mainAgentResponse });

      // Developer and QA rounds need exact code context to apply precise fixes —
      // inline written file contents so the reflection agent has full code context.
      // Other rounds (documentation, requirements, architect, reviewer) only need prose —
      // note which files were written so the reflection agent can re-emit them.
      const FILE_WRITING_ROUNDS = new Set([RoundType.DEVELOPER, RoundType.QA]);
      let reflectionMainResponse: string;
      if (FILE_WRITING_ROUNDS.has(roundType)) {
        const writtenFilesSection = mainAgentFileChanges.length > 0
          ? `\n\n[FILES WRITTEN VIA write_file TOOL]\n${mainAgentFileChanges.map((f) => `[FILE: ${f.filePath}]\n\`\`\`\n${f.content}\n\`\`\``).join('\n\n')}`
          : '';
        reflectionMainResponse = mainAgentResponse + writtenFilesSection;
      } else {
        const writtenFilePaths = mainAgentFileChanges.map((f) => f.filePath);
        const filePathNote = writtenFilePaths.length > 0
          ? `\n\n[FILES YOU WROTE — re-emit all of these using write_file tool in your final response]\n${writtenFilePaths.map((p) => `- ${p}`).join('\n')}`
          : '';
        reflectionMainResponse = mainAgentResponse + filePathNote;
      }
      const reflectionUserMessage = buildReflectionPrompt(
        reflectionMainResponse,
        validFeedbacks.map((v) => ({
          agentName: v.agentName,
          feedback: v.feedback,
        })),
      );

      const { content: reflected, usage: reflectUsage } = await this.callAgent(
        mainAgent,
        {
          systemPrompt,
          userMessage: reflectionUserMessage,
          onChunk: (chunk) => onProgress({ type: 'reflection_chunk', agentName: mainAgent, chunk }),
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

    const displayResponse = reflectedResponse;

    const hasUsage = totalUsage.inputTokens > 0 || totalUsage.outputTokens > 0;

    return {
      mainAgentResponse,
      subAgentVerifications,
      reflectedResponse: displayResponse,
      fileChanges,
      tokenUsage: hasUsage ? totalUsage : undefined,
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
    if (cachedSection) parts.push(`[FILES FROM PREVIOUS TURN]\n${cachedSection}\n[END FILES FROM PREVIOUS TURN]`);
    if (uncachedList) parts.push(`[WORKSPACE FILES]\n${activeNote}${uncachedList}\n[END WORKSPACE FILES]\n\nUse the read_file tool to read any file you need.`);

    return parts.join('\n\n');
  }
}

export type ProgressEvent =
  | { type: 'main_agent_start'; agentName: AgentName }
  | { type: 'main_agent_chunk'; agentName: AgentName; chunk: string }
  | { type: 'main_agent_done'; agentName: AgentName }
  | { type: 'tool_read'; agentName: AgentName; filePath: string }
  | { type: 'tool_run_command'; agentName: AgentName; command: string }
  | { type: 'tool_write_file'; agentName: AgentName; filePath: string }
  | { type: 'sub_agents_start'; agentNames: AgentName[] }
  | { type: 'sub_agent_feedback'; agentName: AgentName; feedback: string }
  | { type: 'sub_agents_done'; agentNames: AgentName[] }
  | { type: 'reflection_start'; agentName: AgentName; mainAgentResponse: string }
  | { type: 'reflection_chunk'; agentName: AgentName; chunk: string }
  | { type: 'reflection_done'; agentName: AgentName };

export type { AgentResponse, FileChange };
