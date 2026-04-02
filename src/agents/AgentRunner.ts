import * as vscode from 'vscode';
import type {
  AgentName,
  AgentResponse,
  ConversationTurn,
  FileChange,
  RoundRequest,
  RoundResult,
  SubAgentVerification,
  ToolCall,
  ToolResult,
  TokenUsage,
} from '../types';
import { ProviderMode } from '../types';
import {
  buildReflectionPrompt,
  buildSubAgentVerificationPrompt,
  buildSystemPrompt,
} from '../prompts/roundPrompts';
import type { CopilotProvider } from './CopilotProvider';
import { CopilotProviderError } from './CopilotProvider';
import type { ApiKeyProvider } from './ApiKeyProvider';
import { ApiKeyProviderError } from './ApiKeyProvider';
import { parseFileChanges } from '../workspace/WorkspaceWriter';
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
  ): Promise<RoundResult> {
    const { roundType, mainAgent, subAgents, userMessage, workspaceContext, conversationHistory } =
      request;

    const systemPrompt = buildSystemPrompt(roundType);

    // Build initial user message: file list only (AI reads content via tool calls)
    const fileListSection = this.buildFileListSection(workspaceContext);
    const fullUserMessage = fileListSection
      ? `${fileListSection}\n\n---\n\nUser Request:\n${userMessage}`
      : userMessage;

    // Track files read during main agent tool calls — pass to sub-agents as resolved context
    const resolvedFiles: Array<{ path: string; content: string }> = [];
    let toolCallCount = 0;

    const makeToolHandler = (): ((toolCall: ToolCall) => Promise<ToolResult>) => {
      return async (toolCall: ToolCall): Promise<ToolResult> => {
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
          resolvedFiles.push({ path: toolCall.filePath, content: result.content });
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

    // Step 1: Main agent initial response (with tool calls for file reading)
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

    // Step 2: Sub agents verify in parallel (skip if none selected or same as main)
    const uniqueSubAgents = subAgents.filter((a) => a !== mainAgent);
    let subAgentVerifications: SubAgentVerification[] = [];

    if (uniqueSubAgents.length > 0) {
      const verificationSystemPrompt = buildSubAgentVerificationPrompt(
        roundType,
        mainAgentResponse,
      );

      onProgress({
        type: 'sub_agents_start',
        agentNames: uniqueSubAgents,
      });

      // Build prior user turns as context for sub-agents
      const priorUserTurns = conversationHistory
        .filter((t) => t.role === 'user')
        .map((t, i) => `[User request ${i + 1}]: ${t.content}`)
        .join('\n');

      // Include files the main agent read via tool calls so sub-agents have the same context
      const resolvedFilesSection = resolvedFiles.length > 0
        ? `[FILES READ BY PRIMARY AGENT]\n\n${resolvedFiles
            .map((f) => `FILE: ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
            .join('\n\n')}\n\n[END FILES]`
        : '';

      const baseMessage = priorUserTurns
        ? `Prior user requests for context:\n${priorUserTurns}\n\nCurrent request:\n${fullUserMessage}`
        : `Please verify the primary agent's response for the following request:\n\n${fullUserMessage}`;

      const subAgentUserMessage = resolvedFilesSection
        ? `${resolvedFilesSection}\n\n${baseMessage}`
        : baseMessage;

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
      onProgress({ type: 'reflection_start', agentName: mainAgent });

      const reflectionUserMessage = buildReflectionPrompt(
        mainAgentResponse,
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

    // Step 4: Parse file changes from the final response
    const fileChanges = parseFileChanges(reflectedResponse);

    const hasUsage = totalUsage.inputTokens > 0 || totalUsage.outputTokens > 0;

    return {
      mainAgentResponse,
      subAgentVerifications,
      reflectedResponse,
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
  ): string {
    if (workspaceContext.files.length === 0) {
      return '';
    }

    const fileList = workspaceContext.files.map((f) => f.path).join('\n');
    const activeNote = workspaceContext.activeFilePath
      ? `Currently active file: ${workspaceContext.activeFilePath}\n\n`
      : '';

    return `[WORKSPACE FILES]\n${activeNote}${fileList}\n[END WORKSPACE FILES]\n\nUse the read_file tool to read any file you need.`;
  }
}

export type ProgressEvent =
  | { type: 'main_agent_start'; agentName: AgentName }
  | { type: 'main_agent_chunk'; agentName: AgentName; chunk: string }
  | { type: 'main_agent_done'; agentName: AgentName }
  | { type: 'tool_read'; agentName: AgentName; filePath: string }
  | { type: 'sub_agents_start'; agentNames: AgentName[] }
  | { type: 'sub_agent_feedback'; agentName: AgentName; feedback: string }
  | { type: 'sub_agents_done'; agentNames: AgentName[] }
  | { type: 'reflection_start'; agentName: AgentName }
  | { type: 'reflection_chunk'; agentName: AgentName; chunk: string }
  | { type: 'reflection_done'; agentName: AgentName };

export type { AgentResponse, FileChange };
