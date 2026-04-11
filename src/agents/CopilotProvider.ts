import * as vscode from 'vscode';
import type { AgentName, ConversationTurn, ModelTier, ToolCall, ToolResult } from '../types';
import { ProviderError } from '../errors';

export interface LLMRequestOptions {
  systemPrompt: string;
  userMessage: string;
  conversationHistory?: ConversationTurn[];
  onChunk?: (chunk: string) => void;
  onToolCall?: (toolCall: ToolCall) => Promise<ToolResult>;
}

/** Re-exported for backwards compatibility with AgentRunner imports */
export class CopilotProviderError extends ProviderError {
  constructor(message: string, cause?: unknown) {
    super(message, undefined, cause);
    this.name = 'CopilotProviderError';
  }
}

/**
 * Parses raw XML tool call text produced by some Copilot models instead of
 * native LanguageModelToolCallPart, e.g.:
 *   <function_calls><invoke name="read_file"><parameter name="path">src/foo.ts</parameter></invoke></function_calls>
 *   <function_calls><invoke name="run_command"><parameter name="command">npm run build</parameter></invoke></function_calls>
 *   <function_calls><invoke name="write_file"><parameter name="path">src/foo.ts</parameter><parameter name="content">...</parameter></invoke></function_calls>
 */
function extractXmlToolCalls(text: string): Array<{ name: 'read_file'; path: string } | { name: 'run_command'; command: string } | { name: 'write_file'; path: string; content: string } | { name: 'delete_file'; path: string }> {
  const calls: Array<{ name: 'read_file'; path: string } | { name: 'run_command'; command: string } | { name: 'write_file'; path: string; content: string } | { name: 'delete_file'; path: string }> = [];
  const invokeRe = /<invoke\s+name="(read_file|run_command|write_file|delete_file)">([\s\S]*?)<\/invoke>/g;
  let m: RegExpExecArray | null;
  while ((m = invokeRe.exec(text)) !== null) {
    const toolName = m[1];
    const body = m[2];
    if (toolName === 'read_file') {
      const paramMatch = /<parameter\s+name="path">([^<]+)<\/parameter>/.exec(body);
      if (paramMatch) {calls.push({ name: 'read_file', path: paramMatch[1].trim() });}
    } else if (toolName === 'run_command') {
      const paramMatch = /<parameter\s+name="command">([^<]+)<\/parameter>/.exec(body);
      if (paramMatch) {calls.push({ name: 'run_command', command: paramMatch[1].trim() });}
    } else if (toolName === 'write_file') {
      const pathMatch = /<parameter\s+name="path">([^<]+)<\/parameter>/.exec(body);
      const contentMatch = /<parameter\s+name="content">([\s\S]*?)<\/parameter>/.exec(body);
      if (pathMatch && contentMatch) {calls.push({ name: 'write_file', path: pathMatch[1].trim(), content: contentMatch[1] });}
    } else if (toolName === 'delete_file') {
      const paramMatch = /<parameter\s+name="path">([^<]+)<\/parameter>/.exec(body);
      if (paramMatch) {calls.push({ name: 'delete_file', path: paramMatch[1].trim() });}
    }
  }
  return calls;
}

const COPILOT_HEAVY_FAMILIES: readonly string[] = ['gpt-4o', 'gpt-4', 'claude', 'gemini'];
const COPILOT_LIGHT_FAMILIES: readonly string[] = ['gpt-4o-mini', 'gpt-4o', 'claude', 'gemini'];

/** How long (ms) to wait for Copilot model selection before giving up. */
const MODEL_SELECTION_TIMEOUT_MS = 30_000;

export class CopilotProvider {
  private cachedModel: vscode.LanguageModelChat | undefined;
  private preferredFamily: string | undefined;
  private modelTier: ModelTier = 'heavy';

  setPreferredFamily(family: string | undefined): void {
    if (this.preferredFamily !== family) {
      this.preferredFamily = family;
      this.cachedModel = undefined;
    }
  }

  setModelTier(tier: ModelTier): void {
    if (this.modelTier !== tier) {
      this.modelTier = tier;
      this.cachedModel = undefined;
    }
  }

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

    // If user specified a preferred family, try it first
    if (this.preferredFamily) {
      try {
        const models = await selectWithTimeout(
          vscode.lm.selectChatModels({ vendor: 'copilot', family: this.preferredFamily }),
        );
        if (models.length > 0) {
          this.cachedModel = models[0];
          return this.cachedModel;
        }
        // Preferred family not available — fall through to auto selection
      } catch (err) {
        if (err instanceof CopilotProviderError) {
          throw err;
        }
      }
    }

    // Auto selection: try preferred model families in order
    const familyList = this.modelTier === 'light' ? COPILOT_LIGHT_FAMILIES : COPILOT_HEAVY_FAMILIES;
    for (const family of familyList) {
      let models: vscode.LanguageModelChat[];
      try {
        models = await selectWithTimeout(
          vscode.lm.selectChatModels({ vendor: 'copilot', family }),
        );
      } catch (err) {
        if (err instanceof CopilotProviderError) {
          throw err;
        }
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
    const messages = this.buildMessages(options);

    // Tool definitions for read_file, run_command, and write_file
    const tools: vscode.LanguageModelChatTool[] = options.onToolCall
      ? [
          {
            name: 'read_file',
            description: 'Read the content of a file in the workspace by its relative path.',
            inputSchema: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'Relative path to the file from workspace root.' },
              },
              required: ['path'],
            },
          },
          {
            name: 'run_command',
            description: 'Run a shell command in the workspace root. The user will be prompted to approve before it runs. Use this when you need command output to complete your task (e.g. build verification, dependency audit). For post-response suggestions, use VERIFY: syntax instead.',
            inputSchema: {
              type: 'object',
              properties: {
                command: { type: 'string', description: 'Shell command to execute in the workspace root.' },
              },
              required: ['command'],
            },
          },
          {
            name: 'write_file',
            description: 'Write a file to the workspace. Use this to create new files or overwrite existing ones. Always write the complete file content — never partial content.',
            inputSchema: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'Relative path from workspace root (e.g. src/utils/helper.ts).' },
                content: { type: 'string', description: 'Complete file content to write.' },
              },
              required: ['path', 'content'],
            },
          },
          {
            name: 'delete_file',
            description: 'Stage a file for deletion from the workspace. The deletion will be shown to the user for review before being applied.',
            inputSchema: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'Relative path from workspace root of the file to delete.' },
              },
              required: ['path'],
            },
          },
        ]
      : [];

    let finalText = '';

    // Agentic loop: keep calling until no more tool calls
    for (;;) {
      if (cancellationToken.isCancellationRequested) {
        throw new vscode.CancellationError();
      }

      let response: vscode.LanguageModelChatResponse;
      try {
        response = await this.awaitWithCancellation(
          model.sendRequest(messages, { tools }, cancellationToken),
          cancellationToken,
        );
      } catch (err) {
        if (err instanceof vscode.CancellationError) {throw err;}
        this.invalidateModelCache();
        throw new CopilotProviderError(
          `Copilot request failed for agent ${agentName}: ${err instanceof Error ? err.message : String(err)}`,
          err,
        );
      }

      const textChunks: string[] = [];
      const toolCallParts: vscode.LanguageModelToolCallPart[] = [];

      try {
        const iterator = response.stream[Symbol.asyncIterator]();
        for (;;) {
          const next = await this.awaitWithCancellation(iterator.next(), cancellationToken);
          if (next.done) {
            break;
          }
          const part = next.value;
          if (part instanceof vscode.LanguageModelTextPart) {
            textChunks.push(part.value);
            options.onChunk?.(part.value);
          } else if (part instanceof vscode.LanguageModelToolCallPart) {
            toolCallParts.push(part);
          }
        }
      } catch (err) {
        if (err instanceof vscode.CancellationError) {throw err;}
        throw new CopilotProviderError(
          `Failed to read Copilot response stream for agent ${agentName}: ${err instanceof Error ? err.message : String(err)}`,
          err,
        );
      }

      const rawText = textChunks.join('');

      // Some Copilot models output tool calls as XML text instead of LanguageModelToolCallPart.
      // Detect and execute them, then strip from the visible response.
      if (options.onToolCall && toolCallParts.length === 0 && rawText.includes('<function_calls>')) {
        const xmlCalls = extractXmlToolCalls(rawText);
        if (xmlCalls.length > 0) {
          if (cancellationToken.isCancellationRequested) {
            throw new vscode.CancellationError();
          }

          const cleanText = rawText.replace(/<function_calls>[\s\S]*?<\/function_calls>/g, '').trim();
          finalText += cleanText;

          const toolResultTexts: string[] = [];
          for (const call of xmlCalls) {
            if (call.name === 'run_command') {
              const result = await options.onToolCall({ id: call.command, name: 'run_command', command: call.command });
              toolResultTexts.push(`Command: ${call.command}\n${result.content}`);
            } else if (call.name === 'write_file') {
              const result = await options.onToolCall({ id: call.path, name: 'write_file', filePath: call.path, content: call.content });
              toolResultTexts.push(`write_file: ${call.path}\n${result.content}`);
            } else if (call.name === 'delete_file') {
              const result = await options.onToolCall({ id: call.path, name: 'delete_file', filePath: call.path });
              toolResultTexts.push(`delete_file: ${call.path}\n${result.content}`);
            } else {
              const result = await options.onToolCall({ id: call.path, name: 'read_file', filePath: call.path });
              toolResultTexts.push(`File: ${call.path}\n${result.content}`);
            }
          }
          // Feed results back as a user message and continue the loop
          messages.push(vscode.LanguageModelChatMessage.Assistant(cleanText || rawText));
          messages.push(vscode.LanguageModelChatMessage.User(
            `Tool results:\n${toolResultTexts.join('\n\n')}`
          ));
          continue;
        }
      }

      const text = rawText;
      finalText += text;

      // No tool calls → done
      if (toolCallParts.length === 0 || !options.onToolCall) {
        break;
      }

      if (cancellationToken.isCancellationRequested) {
        throw new vscode.CancellationError();
      }

      // Append assistant message with text + tool calls
      const assistantParts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];
      if (text) {assistantParts.push(new vscode.LanguageModelTextPart(text));}
      for (const tc of toolCallParts) {assistantParts.push(tc);}
      messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));

      // Execute tool calls and append results
      const resultParts: vscode.LanguageModelToolResultPart[] = [];
      for (const tc of toolCallParts) {
        const input = tc.input as Record<string, unknown>;
        const result = tc.name === 'run_command'
          ? await options.onToolCall({ id: tc.callId, name: 'run_command', command: typeof input['command'] === 'string' ? input['command'] : '' })
          : tc.name === 'write_file'
            ? await options.onToolCall({ id: tc.callId, name: 'write_file', filePath: typeof input['path'] === 'string' ? input['path'] : '', content: typeof input['content'] === 'string' ? input['content'] : '' })
            : tc.name === 'delete_file'
              ? await options.onToolCall({ id: tc.callId, name: 'delete_file', filePath: typeof input['path'] === 'string' ? input['path'] : '' })
              : await options.onToolCall({ id: tc.callId, name: 'read_file', filePath: typeof input['path'] === 'string' ? input['path'] : '' });
        resultParts.push(
          new vscode.LanguageModelToolResultPart(tc.callId, [
            new vscode.LanguageModelTextPart(result.content),
          ]),
        );
      }
      messages.push(vscode.LanguageModelChatMessage.User(resultParts));
    }

    if (finalText.trim().length === 0) {
      throw new CopilotProviderError(
        `Copilot returned an empty response for agent ${agentName}.`,
      );
    }

    return finalText;
  }

  private async awaitWithCancellation<T>(
    promise: Promise<T> | Thenable<T>,
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
      return await Promise.race([Promise.resolve(promise), cancellationPromise]);
    } finally {
      cancelDisposable?.dispose();
    }
  }

  private buildMessages(options: LLMRequestOptions): vscode.LanguageModelChatMessage[] {
    const history = options.conversationHistory ?? [];
    const messages: vscode.LanguageModelChatMessage[] = [];

    if (history.length === 0) {
      messages.push(
        vscode.LanguageModelChatMessage.User(
          `${options.systemPrompt}\n\n---\n\n${options.userMessage}`,
        ),
      );
    } else {
      for (let i = 0; i < history.length; i++) {
        const turn = history[i];
        if (turn.role === 'user') {
          const content = i === 0 ? `${options.systemPrompt}\n\n---\n\n${turn.content}` : turn.content;
          messages.push(vscode.LanguageModelChatMessage.User(content));
        } else {
          messages.push(vscode.LanguageModelChatMessage.Assistant(turn.content));
        }
      }
      messages.push(vscode.LanguageModelChatMessage.User(options.userMessage));
    }

    return messages;
  }

  invalidateModelCache(): void {
    this.cachedModel = undefined;
  }
}
