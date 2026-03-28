import * as vscode from 'vscode';
import type { AgentName } from '../types';
import { ProviderError } from '../errors';

export interface LLMRequestOptions {
  systemPrompt: string;
  userMessage: string;
  maxTokens?: number;
}

/** Re-exported for backwards compatibility with AgentRunner imports */
export class CopilotProviderError extends ProviderError {
  constructor(message: string, cause?: unknown) {
    super(message, undefined, cause);
    this.name = 'CopilotProviderError';
  }
}

const COPILOT_MODEL_FAMILIES: readonly string[] = [
  'gpt-4o',
  'gpt-4',
  'claude',
  'gemini',
];

/** How long (ms) to wait for Copilot model selection before giving up. */
const MODEL_SELECTION_TIMEOUT_MS = 30_000;

export class CopilotProvider {
  private cachedModel: vscode.LanguageModelChat | undefined;

  async isAvailable(): Promise<boolean> {
    try {
      const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
      return models.length > 0;
    } catch {
      return false;
    }
  }

  private async selectModel(): Promise<vscode.LanguageModelChat> {
    if (this.cachedModel) {
      return this.cachedModel;
    }

    const selectWithTimeout = <T>(thenable: Thenable<T>): Promise<T> => {
      let timerId: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<T>((_, reject) => {
        timerId = setTimeout(
          () =>
            reject(
              new CopilotProviderError(
                `Copilot model selection timed out after ${MODEL_SELECTION_TIMEOUT_MS / 1000}s`,
              ),
            ),
          MODEL_SELECTION_TIMEOUT_MS,
        );
      });
      return Promise.race([
        Promise.resolve(thenable).finally(() => clearTimeout(timerId)),
        timeoutPromise,
      ]);
    };

    // Try preferred model families in order
    for (const family of COPILOT_MODEL_FAMILIES) {
      let models: vscode.LanguageModelChat[];
      try {
        models = await selectWithTimeout(
          vscode.lm.selectChatModels({ vendor: 'copilot', family }),
        );
      } catch (err) {
        if (err instanceof CopilotProviderError) {
          throw err;
        }
        // selectChatModels may throw if the API is unavailable — continue to next family
        continue;
      }
      if (models.length > 0) {
        this.cachedModel = models[0];
        return this.cachedModel;
      }
    }

    // Fallback: any copilot model
    let anyModels: vscode.LanguageModelChat[];
    try {
      anyModels = await selectWithTimeout(
        vscode.lm.selectChatModels({ vendor: 'copilot' }),
      );
    } catch (err) {
      throw new CopilotProviderError(
        'Failed to query available Copilot language models.',
        err,
      );
    }

    if (anyModels.length === 0) {
      throw new CopilotProviderError(
        'No GitHub Copilot language models are available. ' +
          'Ensure GitHub Copilot is installed and you are signed in.',
      );
    }

    this.cachedModel = anyModels[0];
    return this.cachedModel;
  }

  async sendRequest(
    options: LLMRequestOptions,
    agentName: AgentName,
    cancellationToken: vscode.CancellationToken,
  ): Promise<string> {
    const model = await this.selectModel();

    const messages: vscode.LanguageModelChatMessage[] = [
      vscode.LanguageModelChatMessage.User(
        `${options.systemPrompt}\n\n---\n\n${options.userMessage}`,
      ),
    ];

    let response: vscode.LanguageModelChatResponse;
    try {
      response = await model.sendRequest(messages, {}, cancellationToken);
    } catch (err) {
      if (err instanceof vscode.CancellationError) {
        throw err;
      }
      // Invalidate the cached model so the next request re-selects a healthy one
      this.invalidateModelCache();
      throw new CopilotProviderError(
        `Copilot request failed for agent ${agentName}: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }

    const chunks: string[] = [];
    try {
      for await (const chunk of response.text) {
        if (cancellationToken.isCancellationRequested) {
          throw new vscode.CancellationError();
        }
        chunks.push(chunk);
      }
    } catch (err) {
      if (err instanceof vscode.CancellationError) {
        throw err;
      }
      throw new CopilotProviderError(
        `Failed to read Copilot response stream for agent ${agentName}: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }

    const result = chunks.join('');
    if (result.trim().length === 0) {
      throw new CopilotProviderError(
        `Copilot returned an empty response for agent ${agentName}.`,
      );
    }

    return result;
  }

  invalidateModelCache(): void {
    this.cachedModel = undefined;
  }
}
