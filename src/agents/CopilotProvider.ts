import * as vscode from 'vscode';
import type { AgentName } from '../types';

export interface LLMRequestOptions {
  systemPrompt: string;
  userMessage: string;
  maxTokens?: number;
}

export class CopilotProviderError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'CopilotProviderError';
  }
}

const COPILOT_MODEL_FAMILIES: readonly string[] = [
  'gpt-4o',
  'gpt-4',
  'claude',
  'gemini',
];

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

    // Try preferred model families in order
    for (const family of COPILOT_MODEL_FAMILIES) {
      const models = await vscode.lm.selectChatModels({
        vendor: 'copilot',
        family,
      });
      if (models.length > 0) {
        this.cachedModel = models[0];
        return this.cachedModel;
      }
    }

    // Fallback: any copilot model
    const anyModels = await vscode.lm.selectChatModels({ vendor: 'copilot' });
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

    return chunks.join('');
  }

  invalidateModelCache(): void {
    this.cachedModel = undefined;
  }
}
