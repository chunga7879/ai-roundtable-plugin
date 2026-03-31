import * as vscode from 'vscode';
import type {
  AgentName,
  AgentResponse,
  ConversationTurn,
  FileChange,
  RoundRequest,
  RoundResult,
  SubAgentVerification,
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
}

interface CallAgentOptions {
  systemPrompt: string;
  userMessage: string;
  conversationHistory?: ConversationTurn[];
}

export class AgentRunner {
  private readonly copilotProvider: CopilotProvider;
  private readonly apiKeyProvider: ApiKeyProvider;
  private readonly providerMode: ProviderMode;

  constructor(deps: AgentRunnerDependencies) {
    this.copilotProvider = deps.copilotProvider;
    this.apiKeyProvider = deps.apiKeyProvider;
    this.providerMode = deps.providerMode;
  }

  async runRound(
    request: RoundRequest,
    cancellationToken: vscode.CancellationToken,
    onProgress: (event: ProgressEvent) => void,
  ): Promise<RoundResult> {
    const { roundType, mainAgent, subAgents, userMessage, workspaceContext, conversationHistory } =
      request;

    const systemPrompt = buildSystemPrompt(roundType);

    const contextSection = this.buildContextSection(workspaceContext);
    const fullUserMessage = contextSection
      ? `${contextSection}\n\n---\n\nUser Request:\n${userMessage}`
      : userMessage;

    // Step 1: Main agent initial response
    onProgress({ type: 'main_agent_start', agentName: mainAgent });

    const mainAgentResponse = await this.callAgent(
      mainAgent,
      { systemPrompt, userMessage: fullUserMessage, conversationHistory },
      cancellationToken,
    );

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

      const subAgentUserMessage = priorUserTurns
        ? `Prior user requests for context:\n${priorUserTurns}\n\nCurrent request:\n${fullUserMessage}`
        : `Please verify the primary agent's response for the following request:\n\n${fullUserMessage}`;

      const verificationPromises = uniqueSubAgents.map(async (agentName) => {
        try {
          const feedback = await this.callAgent(
            agentName,
            {
              systemPrompt: verificationSystemPrompt,
              userMessage: subAgentUserMessage,
            },
            cancellationToken,
          );
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

      reflectedResponse = await this.callAgent(
        mainAgent,
        {
          systemPrompt,
          userMessage: reflectionUserMessage,
        },
        cancellationToken,
      );

      if (cancellationToken.isCancellationRequested) {
        throw new vscode.CancellationError();
      }

      onProgress({ type: 'reflection_done', agentName: mainAgent });
    } else {
      reflectedResponse = mainAgentResponse;
    }

    // Step 4: Parse file changes from the final response
    const fileChanges = parseFileChanges(reflectedResponse);

    return {
      mainAgentResponse,
      subAgentVerifications,
      reflectedResponse,
      fileChanges,
    };
  }

  private async callAgent(
    agentName: AgentName,
    options: CallAgentOptions,
    cancellationToken: vscode.CancellationToken,
  ): Promise<string> {
    try {
      if (this.providerMode === ProviderMode.COPILOT) {
        return await this.copilotProvider.sendRequest(
          options,
          agentName,
          cancellationToken,
        );
      }

      // API key mode — route to the appropriate provider
      if (!this.apiKeyProvider.hasKeyForAgent(agentName)) {
        throw new AgentRunnerError(
          `No API key configured for ${agentName}. Please run "AI Roundtable: Configure Provider".`,
        );
      }

      return await this.apiKeyProvider.sendRequest(agentName, options);
    } catch (err) {
      if (err instanceof vscode.CancellationError) {
        throw err;
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

  private buildContextSection(
    workspaceContext: RoundRequest['workspaceContext'],
  ): string {
    if (workspaceContext.files.length === 0) {
      return '';
    }

    const fileSections = workspaceContext.files
      .map(
        (f) =>
          `FILE: ${f.path} (${f.language})\n\`\`\`${f.language}\n${f.content}\n\`\`\``,
      )
      .join('\n\n');

    const activeNote = workspaceContext.activeFilePath
      ? `\nCurrently active file: ${workspaceContext.activeFilePath}`
      : '';

    return `[WORKSPACE CONTEXT]${activeNote}\n\n${fileSections}\n\n[END WORKSPACE CONTEXT]`;
  }
}

export type ProgressEvent =
  | { type: 'main_agent_start'; agentName: AgentName }
  | { type: 'main_agent_done'; agentName: AgentName }
  | { type: 'sub_agents_start'; agentNames: AgentName[] }
  | { type: 'sub_agent_feedback'; agentName: AgentName; feedback: string }
  | { type: 'sub_agents_done'; agentNames: AgentName[] }
  | { type: 'reflection_start'; agentName: AgentName }
  | { type: 'reflection_done'; agentName: AgentName };

export type { AgentResponse, FileChange };
