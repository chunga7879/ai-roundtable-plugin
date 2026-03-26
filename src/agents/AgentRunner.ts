import * as vscode from 'vscode';
import type {
  AgentName,
  AgentResponse,
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
  ROUND_MAX_TOKENS,
} from '../prompts/roundPrompts';
import type { CopilotProvider } from './CopilotProvider';
import { CopilotProviderError } from './CopilotProvider';
import type { ApiKeyProvider } from './ApiKeyProvider';
import { ApiKeyProviderError } from './ApiKeyProvider';
import { parseFileChanges } from '../workspace/WorkspaceWriter';

export class AgentRunnerError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AgentRunnerError';
  }
}

interface AgentRunnerDependencies {
  copilotProvider: CopilotProvider;
  apiKeyProvider: ApiKeyProvider;
  providerMode: ProviderMode;
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
    const { roundType, mainAgent, subAgents, userMessage, workspaceContext } =
      request;

    const systemPrompt = buildSystemPrompt(roundType);
    const maxTokens = ROUND_MAX_TOKENS[roundType];

    const contextSection = this.buildContextSection(workspaceContext);
    const fullUserMessage = contextSection
      ? `${contextSection}\n\n---\n\nUser Request:\n${userMessage}`
      : userMessage;

    // Step 1: Main agent initial response
    onProgress({ type: 'main_agent_start', agentName: mainAgent });

    const mainAgentResponse = await this.callAgent(
      mainAgent,
      { systemPrompt, userMessage: fullUserMessage, maxTokens },
      cancellationToken,
    );

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

      const verificationPromises = uniqueSubAgents.map(async (agentName) => {
        try {
          const feedback = await this.callAgent(
            agentName,
            {
              systemPrompt: verificationSystemPrompt,
              userMessage: `Please verify the primary agent's response for the following request:\n\n${fullUserMessage}`,
              maxTokens: Math.min(maxTokens, 4096),
            },
            cancellationToken,
          );
          return { agentName, feedback };
        } catch (err) {
          if (err instanceof vscode.CancellationError) {
            throw err;
          }
          // Graceful degradation: log but don't fail the whole round if a sub-agent fails
          const errorMessage =
            err instanceof Error ? err.message : String(err);
          return {
            agentName,
            feedback: `[Verification unavailable: ${errorMessage}]`,
          };
        }
      });

      subAgentVerifications = await Promise.all(verificationPromises);

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
          maxTokens,
        },
        cancellationToken,
      );

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
    options: { systemPrompt: string; userMessage: string; maxTokens: number },
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
        `Unexpected error from agent ${agentName}: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
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
  | { type: 'sub_agents_done'; agentNames: AgentName[] }
  | { type: 'reflection_start'; agentName: AgentName }
  | { type: 'reflection_done'; agentName: AgentName };

export type { AgentResponse, FileChange };
