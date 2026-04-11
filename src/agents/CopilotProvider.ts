import * as vscode from 'vscode';
import type { AgentName, ConversationTurn, ModelTier, ToolCall, ToolResult } from '../types';
import { ProviderError } from '../errors';

export interface LLMRequestOptions {
  systemPrompt: string;
  userMessage: string;
  conversationHistory?: ConversationTurn[];
  onChunk?: (chunk: string) => void;
  onToolCall?: (toolCall: ToolCall) => Promise<ToolResult>;
  enabledTools?: ToolCall['name'][];
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
/** Safety cap for agentic tool-call loops to avoid infinite retries. */
const MAX_TOOL_LOOP_TURNS = 12;
/** Break when the same all-error tool-call batch repeats this many times. */
const MAX_REPEATED_ERROR_BATCHES = 2;

type XmlToolCall = ReturnType<typeof extractXmlToolCalls>[number];

interface ToolLoopGuardState {
  lastErrorBatchSignature: string | undefined;
  repeatedErrorBatchCount: number;
}

interface ParsedCopilotResponse {
  rawText: string;
  toolCallParts: vscode.LanguageModelToolCallPart[];
}

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
    const enabledToolNames = this.resolveEnabledTools(options);
    const enabledToolSet = new Set(enabledToolNames);

    // Tool definitions for read_file, run_command, and write_file
    const tools: vscode.LanguageModelChatTool[] = enabledToolNames.map((name) => this.buildToolDefinition(name));

    let finalText = '';
    let loopTurn = 0;
    let loopGuardState: ToolLoopGuardState = {
      lastErrorBatchSignature: undefined,
      repeatedErrorBatchCount: 0,
    };

    // Agentic loop: keep calling until no more tool calls
    for (;;) {
      loopTurn++;
      this.assertToolLoopLimit(loopTurn, agentName);
      if (cancellationToken.isCancellationRequested) {
        throw new vscode.CancellationError();
      }

      const response = await this.requestFromModel(model, messages, tools, cancellationToken, agentName);
      const { rawText, toolCallParts } = await this.readResponseParts(
        response,
        options.onChunk,
        cancellationToken,
        agentName,
      );

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

          const xmlToolCalls = xmlCalls.map((call) => this.mapXmlToolCall(call));
          const xmlResults = await this.executeToolBatch(xmlToolCalls, options, enabledToolSet);
          loopGuardState = this.applyToolLoopGuard(xmlToolCalls, xmlResults, loopGuardState, agentName);
          const toolResultTexts = xmlCalls.map((call, i) => this.formatXmlToolResult(call, xmlResults[i]));
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
      const nativeToolCalls = toolCallParts.map((tc) => this.mapNativeToolCall(tc));
      const nativeResults = await this.executeToolBatch(nativeToolCalls, options, enabledToolSet);
      loopGuardState = this.applyToolLoopGuard(nativeToolCalls, nativeResults, loopGuardState, agentName);
      for (let i = 0; i < toolCallParts.length; i++) {
        const tc = toolCallParts[i];
        const result = nativeResults[i];
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

  private assertToolLoopLimit(loopTurn: number, agentName: AgentName): void {
    if (loopTurn > MAX_TOOL_LOOP_TURNS) {
      throw new CopilotProviderError(
        `Copilot tool-call loop exceeded ${MAX_TOOL_LOOP_TURNS} turns for agent ${agentName}. ` +
        'Stopping to prevent an infinite reflection loop.',
      );
    }
  }

  private async requestFromModel(
    model: vscode.LanguageModelChat,
    messages: vscode.LanguageModelChatMessage[],
    tools: vscode.LanguageModelChatTool[],
    cancellationToken: vscode.CancellationToken,
    agentName: AgentName,
  ): Promise<vscode.LanguageModelChatResponse> {
    try {
      return await this.awaitWithCancellation(
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
  }

  private async readResponseParts(
    response: vscode.LanguageModelChatResponse,
    onChunk: ((chunk: string) => void) | undefined,
    cancellationToken: vscode.CancellationToken,
    agentName: AgentName,
  ): Promise<ParsedCopilotResponse> {
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
          onChunk?.(part.value);
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

    return {
      rawText: textChunks.join(''),
      toolCallParts,
    };
  }

  private mapXmlToolCall(call: XmlToolCall): ToolCall {
    switch (call.name) {
      case 'run_command':
        return { id: call.command, name: 'run_command', command: call.command };
      case 'write_file':
        return { id: call.path, name: 'write_file', filePath: call.path, content: call.content };
      case 'delete_file':
        return { id: call.path, name: 'delete_file', filePath: call.path };
      case 'read_file':
      default:
        return { id: call.path, name: 'read_file', filePath: call.path };
    }
  }

  private formatXmlToolResult(call: XmlToolCall, result: ToolResult): string {
    switch (call.name) {
      case 'run_command':
        return `Command: ${call.command}\n${result.content}`;
      case 'write_file':
        return `write_file: ${call.path}\n${result.content}`;
      case 'delete_file':
        return `delete_file: ${call.path}\n${result.content}`;
      case 'read_file':
      default:
        return `File: ${call.path}\n${result.content}`;
    }
  }

  private mapNativeToolCall(tc: vscode.LanguageModelToolCallPart): ToolCall {
    const input = tc.input as Record<string, unknown>;
    if (tc.name === 'run_command') {
      return { id: tc.callId, name: 'run_command', command: typeof input['command'] === 'string' ? input['command'] : '' };
    }
    if (tc.name === 'write_file') {
      return {
        id: tc.callId,
        name: 'write_file',
        filePath: typeof input['path'] === 'string' ? input['path'] : '',
        content: typeof input['content'] === 'string' ? input['content'] : '',
      };
    }
    if (tc.name === 'delete_file') {
      return { id: tc.callId, name: 'delete_file', filePath: typeof input['path'] === 'string' ? input['path'] : '' };
    }
    return { id: tc.callId, name: 'read_file', filePath: typeof input['path'] === 'string' ? input['path'] : '' };
  }

  private async executeToolBatch(
    toolCalls: ToolCall[],
    options: LLMRequestOptions,
    enabledToolSet: Set<ToolCall['name']>,
  ): Promise<ToolResult[]> {
    const results: ToolResult[] = [];
    for (const toolCall of toolCalls) {
      results.push(await this.executeToolCall(toolCall, options, enabledToolSet));
    }
    return results;
  }

  private applyToolLoopGuard(
    batchToolCalls: ToolCall[],
    batchResults: ToolResult[],
    state: ToolLoopGuardState,
    agentName: AgentName,
  ): ToolLoopGuardState {
    const batchSignatures = batchToolCalls.map((toolCall) => this.getToolCallSignature(toolCall));
    const next = this.updateToolLoopGuard(
      batchSignatures,
      batchResults,
      state.lastErrorBatchSignature,
      state.repeatedErrorBatchCount,
      agentName,
    );
    return {
      lastErrorBatchSignature: next.lastErrorBatchSignature,
      repeatedErrorBatchCount: next.repeatedErrorBatchCount,
    };
  }

  private resolveEnabledTools(options: LLMRequestOptions): ToolCall['name'][] {
    if (!options.onToolCall) {
      return [];
    }
    const allTools: ToolCall['name'][] = ['read_file', 'run_command', 'write_file', 'delete_file'];
    if (!options.enabledTools || options.enabledTools.length === 0) {
      return allTools;
    }
    const allowed = new Set<ToolCall['name']>(allTools);
    const filtered = options.enabledTools.filter((name): name is ToolCall['name'] => allowed.has(name));
    return filtered.length > 0 ? filtered : allTools;
  }

  private buildToolDefinition(name: ToolCall['name']): vscode.LanguageModelChatTool {
    if (name === 'read_file') {
      return {
        name: 'read_file',
        description: 'Read the content of a file in the workspace by its relative path.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path to the file from workspace root.' },
          },
          required: ['path'],
        },
      };
    }
    if (name === 'run_command') {
      return {
        name: 'run_command',
        description: 'Run a shell command in the workspace root. The user will be prompted to approve before it runs. Use this when you need command output to complete your task (e.g. build verification, dependency audit). For post-response suggestions, use VERIFY: syntax instead.',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command to execute in the workspace root.' },
          },
          required: ['command'],
        },
      };
    }
    if (name === 'write_file') {
      return {
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
      };
    }
    return {
      name: 'delete_file',
      description: 'Stage a file for deletion from the workspace. The deletion will be shown to the user for review before being applied.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path from workspace root of the file to delete.' },
        },
        required: ['path'],
      },
    };
  }

  private async executeToolCall(
    toolCall: ToolCall,
    options: LLMRequestOptions,
    enabledToolSet: Set<ToolCall['name']>,
  ): Promise<ToolResult> {
    if (!options.onToolCall) {
      return { id: toolCall.id, content: 'Tool execution is not available in this context.', isError: true };
    }
    if (!enabledToolSet.has(toolCall.name)) {
      return {
        id: toolCall.id,
        content: `Tool "${toolCall.name}" is not enabled in this phase.`,
        isError: true,
      };
    }
    return options.onToolCall(toolCall);
  }

  private getToolCallSignature(toolCall: ToolCall): string {
    switch (toolCall.name) {
      case 'read_file':
        return `read_file:${toolCall.filePath}`;
      case 'run_command':
        return `run_command:${toolCall.command}`;
      case 'write_file':
        return `write_file:${toolCall.filePath}:${toolCall.content.length}`;
      case 'delete_file':
        return `delete_file:${toolCall.filePath}`;
      default:
        {
          const unreachable: never = toolCall;
          return String(unreachable);
        }
    }
  }

  private updateToolLoopGuard(
    batchSignatures: string[],
    batchResults: ToolResult[],
    previousErrorBatchSignature: string | undefined,
    previousRepeatCount: number,
    agentName: AgentName,
  ): { lastErrorBatchSignature: string | undefined; repeatedErrorBatchCount: number } {
    if (batchSignatures.length === 0 || batchResults.length === 0) {
      return { lastErrorBatchSignature: undefined, repeatedErrorBatchCount: 0 };
    }
    const allErrors = batchResults.every((r) => r.isError);
    if (!allErrors) {
      return { lastErrorBatchSignature: undefined, repeatedErrorBatchCount: 0 };
    }

    const signature = batchSignatures.join('||');
    const repeatedCount = signature === previousErrorBatchSignature
      ? previousRepeatCount + 1
      : 1;

    if (repeatedCount >= MAX_REPEATED_ERROR_BATCHES) {
      throw new CopilotProviderError(
        `Copilot repeatedly produced the same failing tool calls for agent ${agentName}. ` +
        'Stopping to prevent an infinite reflection loop.',
      );
    }

    return {
      lastErrorBatchSignature: signature,
      repeatedErrorBatchCount: repeatedCount,
    };
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
