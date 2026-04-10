import * as https from 'https';
import type * as http from 'http';
import { AgentName } from '../types';
import type { ConversationTurn, ModelTier, TokenUsage, ToolCall, ToolResult } from '../types';
import { ProviderError } from '../errors';

export interface ApiKeyProviderOptions {
  anthropicApiKey?: string;
  openaiApiKey?: string;
  googleApiKey?: string;
  deepseekApiKey?: string;
  modelTier?: ModelTier;
}

export interface LLMRequestOptions {
  systemPrompt: string;
  userMessage: string;
  conversationHistory?: ConversationTurn[];
  onChunk?: (chunk: string) => void;
  onToolCall?: (toolCall: ToolCall) => Promise<ToolResult>;
  cancellationToken?: { isCancellationRequested: boolean; onCancellationRequested: (cb: () => void) => { dispose: () => void } };
}

/** Thrown when an in-flight request is cancelled (e.g. panel closed). */
class CancellationError extends Error {
  constructor() {
    super('Request cancelled');
    this.name = 'CancellationError';
  }
}

/** Re-exported for backwards compatibility with AgentRunner imports */
export class ApiKeyProviderError extends ProviderError {
  constructor(message: string, statusCode?: number, cause?: unknown) {
    super(message, statusCode, cause);
    this.name = 'ApiKeyProviderError';
  }
}

// ── Tool definitions (one per provider format) ────────────────────────────────

const READ_FILE_TOOL_ANTHROPIC = {
  name: 'read_file',
  description: 'Read the content of a file in the workspace by its relative path.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path to the file from workspace root.' },
    },
    required: ['path'],
  },
};

const RUN_COMMAND_TOOL_ANTHROPIC = {
  name: 'run_command',
  description: 'Run a shell command in the workspace root. The user will be prompted to approve before it runs. Use this when you need command output to complete your task (e.g. build verification, dependency audit). For post-response suggestions, use RUN: syntax instead.',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute in the workspace root.' },
    },
    required: ['command'],
  },
};

const WRITE_FILE_TOOL_ANTHROPIC = {
  name: 'write_file',
  description: 'Write a file to the workspace. Use this to create new files or overwrite existing ones. Always write the complete file content — never partial content.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path from workspace root (e.g. src/utils/helper.ts).' },
      content: { type: 'string', description: 'Complete file content to write.' },
    },
    required: ['path', 'content'],
  },
};

const DELETE_FILE_TOOL_ANTHROPIC = {
  name: 'delete_file',
  description: 'Stage a file for deletion from the workspace. The deletion will be shown to the user for review before being applied.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path from workspace root of the file to delete.' },
    },
    required: ['path'],
  },
};

const READ_FILE_TOOL_OPENAI = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read the content of a file in the workspace by its relative path.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to the file from workspace root.' },
      },
      required: ['path'],
    },
  },
};

const RUN_COMMAND_TOOL_OPENAI = {
  type: 'function',
  function: {
    name: 'run_command',
    description: 'Run a shell command in the workspace root. The user will be prompted to approve before it runs. Use this when you need command output to complete your task (e.g. build verification, dependency audit). For post-response suggestions, use RUN: syntax instead.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute in the workspace root.' },
      },
      required: ['command'],
    },
  },
};

const WRITE_FILE_TOOL_OPENAI = {
  type: 'function',
  function: {
    name: 'write_file',
    description: 'Write a file to the workspace. Use this to create new files or overwrite existing ones. Always write the complete file content — never partial content.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path from workspace root (e.g. src/utils/helper.ts).' },
        content: { type: 'string', description: 'Complete file content to write.' },
      },
      required: ['path', 'content'],
    },
  },
};

const DELETE_FILE_TOOL_OPENAI = {
  type: 'function',
  function: {
    name: 'delete_file',
    description: 'Stage a file for deletion from the workspace. The deletion will be shown to the user for review before being applied.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path from workspace root of the file to delete.' },
      },
      required: ['path'],
    },
  },
};

const READ_FILE_TOOL_GEMINI = {
  name: 'read_file',
  description: 'Read the content of a file in the workspace by its relative path.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path to the file from workspace root.' },
    },
    required: ['path'],
  },
};

const RUN_COMMAND_TOOL_GEMINI = {
  name: 'run_command',
  description: 'Run a shell command in the workspace root. The user will be prompted to approve before it runs. Use this when you need command output to complete your task (e.g. build verification, dependency audit). For post-response suggestions, use RUN: syntax instead.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute in the workspace root.' },
    },
    required: ['command'],
  },
};

const WRITE_FILE_TOOL_GEMINI = {
  name: 'write_file',
  description: 'Write a file to the workspace. Use this to create new files or overwrite existing ones. Always write the complete file content — never partial content.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path from workspace root (e.g. src/utils/helper.ts).' },
      content: { type: 'string', description: 'Complete file content to write.' },
    },
    required: ['path', 'content'],
  },
};

const DELETE_FILE_TOOL_GEMINI = {
  name: 'delete_file',
  description: 'Stage a file for deletion from the workspace. The deletion will be shown to the user for review before being applied.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path from workspace root of the file to delete.' },
    },
    required: ['path'],
  },
};

// ── Models ────────────────────────────────────────────────────────────────────

const MODELS: Record<ModelTier, Record<'claude' | 'openai' | 'gemini' | 'deepseek', string>> = {
  heavy: {
    claude: 'claude-sonnet-4-6',
    openai: 'gpt-4o',
    gemini: 'gemini-1.5-pro',
    deepseek: 'deepseek-coder',
  },
  light: {
    claude: 'claude-haiku-4-5-20251001',
    openai: 'gpt-4o-mini',
    gemini: 'gemini-1.5-flash',
    deepseek: 'deepseek-chat',
  },
};

const REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOKENS = 16_384;

/** Maximum response body size to read (10 MB). Prevents OOM from runaway responses. */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

interface AnthropicResponseBody {
  content?: Array<{ type: string; text: string; id?: string; name?: string; input?: Record<string, unknown> }>;
  stop_reason?: string;
  error?: { message: string; type?: string };
  usage?: { input_tokens: number; output_tokens: number };
}

interface OpenAIResponseBody {
  choices?: Array<{
    message?: {
      content?: string;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    };
    finish_reason?: string;
  }>;
  error?: { message: string; type?: string };
  usage?: { prompt_tokens: number; completion_tokens: number };
}

interface GeminiResponseBody {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; functionCall?: { name: string; args: Record<string, unknown> } }> };
    finishReason?: string;
  }>;
  error?: { message: string; status?: string };
  usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number };
}

export interface ApiKeyResponse {
  content: string;
  usage?: TokenUsage;
}

export class ApiKeyProvider {
  constructor(private readonly options: ApiKeyProviderOptions) {}

  private get models() {
    return MODELS[this.options.modelTier ?? 'heavy'];
  }

  async sendRequest(
    agentName: AgentName,
    requestOptions: LLMRequestOptions,
  ): Promise<ApiKeyResponse> {
    const streaming = Boolean(requestOptions.onChunk);
    switch (agentName) {
      case AgentName.CLAUDE:
        return streaming ? this.sendClaudeStreamRequest(requestOptions) : this.sendClaudeRequest(requestOptions);
      case AgentName.GPT:
        return streaming ? this.sendOpenAIStreamRequest(requestOptions) : this.sendOpenAIRequest(requestOptions);
      case AgentName.GEMINI:
        return streaming ? this.sendGeminiStreamRequest(requestOptions) : this.sendGeminiRequest(requestOptions);
      case AgentName.DEEPSEEK:
        return streaming ? this.sendDeepSeekStreamRequest(requestOptions) : this.sendDeepSeekRequest(requestOptions);
      case AgentName.COPILOT:
        throw new ApiKeyProviderError(
          'Copilot agent cannot be used with API key provider. Use CopilotProvider instead.',
        );
      default: {
        const exhaustiveCheck: never = agentName;
        throw new ApiKeyProviderError(`Unknown agent: ${String(exhaustiveCheck)}`);
      }
    }
  }

  hasKeyForAgent(agentName: AgentName): boolean {
    switch (agentName) {
      case AgentName.CLAUDE:
        return Boolean(this.options.anthropicApiKey);
      case AgentName.GPT:
        return Boolean(this.options.openaiApiKey);
      case AgentName.GEMINI:
        return Boolean(this.options.googleApiKey);
      case AgentName.DEEPSEEK:
        return Boolean(this.options.deepseekApiKey);
      case AgentName.COPILOT:
        return false;
      default:
        return false;
    }
  }

  private async sendClaudeRequest(options: LLMRequestOptions): Promise<ApiKeyResponse> {
    const apiKey = this.options.anthropicApiKey;
    if (!apiKey) {
      throw new ApiKeyProviderError(
        'Anthropic API key is not configured. Please run "AI Roundtable: Configure Provider".',
      );
    }

    const history = options.conversationHistory ?? [];
    const messages: Array<{ role: string; content: unknown }> = [
      ...history.map((turn) => ({ role: turn.role, content: turn.content })),
      { role: 'user', content: options.userMessage },
    ];

    const tools = options.onToolCall ? [READ_FILE_TOOL_ANTHROPIC, RUN_COMMAND_TOOL_ANTHROPIC, WRITE_FILE_TOOL_ANTHROPIC, DELETE_FILE_TOOL_ANTHROPIC] : undefined;
    const totalUsage = { inputTokens: 0, outputTokens: 0 };
    let finalText = '';

    for (;;) {
      const body = JSON.stringify({
        model: this.models.claude,
        max_tokens: DEFAULT_MAX_TOKENS,
        system: [{ type: 'text', text: options.systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages,
        ...(tools ? { tools } : {}),
      });

      const responseText = await this.makeHttpsRequest({
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'prompt-caching-2024-07-31',
          'Content-Length': Buffer.byteLength(body).toString(),
        },
        body,
        agentLabel: AgentName.CLAUDE,
        cancellationToken: options.cancellationToken,
      });

      let parsed: AnthropicResponseBody;
      try {
        parsed = JSON.parse(responseText) as AnthropicResponseBody;
      } catch {
        throw new ApiKeyProviderError(`Anthropic API returned non-JSON response (${responseText.length} bytes).`);
      }

      if (parsed.error) {
        throw new ApiKeyProviderError(`Anthropic API error (${parsed.error.type ?? 'unknown'}): ${parsed.error.message}`);
      }

      if (parsed.usage) {
        totalUsage.inputTokens += parsed.usage.input_tokens;
        totalUsage.outputTokens += parsed.usage.output_tokens;
      }

      const textBlock = parsed.content?.find((c) => c.type === 'text');
      if (textBlock) {finalText += textBlock.text;}

      const toolUseBlocks = parsed.content?.filter((c) => c.type === 'tool_use') ?? [];
      if (toolUseBlocks.length === 0 || !options.onToolCall || parsed.stop_reason !== 'tool_use') {
        break;
      }

      if (options.cancellationToken?.isCancellationRequested) {
        throw new CancellationError();
      }

      // Append assistant message with full content
      messages.push({ role: 'assistant', content: parsed.content });

      // Execute tool calls and build tool_result message
      const toolResults: Array<{ type: string; tool_use_id: string; content: string }> = [];
      for (const block of toolUseBlocks) {
        const result = block.name === 'run_command'
          ? await options.onToolCall({ id: block.id ?? '', name: 'run_command', command: typeof block.input?.['command'] === 'string' ? block.input['command'] : '' })
          : block.name === 'write_file'
            ? await options.onToolCall({ id: block.id ?? '', name: 'write_file', filePath: typeof block.input?.['path'] === 'string' ? block.input['path'] : '', content: typeof block.input?.['content'] === 'string' ? block.input['content'] : '' })
            : block.name === 'delete_file'
              ? await options.onToolCall({ id: block.id ?? '', name: 'delete_file', filePath: typeof block.input?.['path'] === 'string' ? block.input['path'] : '' })
              : await options.onToolCall({ id: block.id ?? '', name: 'read_file', filePath: typeof block.input?.['path'] === 'string' ? block.input['path'] : '' });
        toolResults.push({ type: 'tool_result', tool_use_id: block.id ?? '', content: result.content });
      }
      messages.push({ role: 'user', content: toolResults });
    }

    if (!finalText.trim()) {
      throw new ApiKeyProviderError('Anthropic API returned no text content in response.');
    }

    return {
      content: finalText,
      usage: totalUsage.inputTokens > 0 ? totalUsage : undefined,
    };
  }

  private async sendOpenAIRequest(options: LLMRequestOptions): Promise<ApiKeyResponse> {
    return this.sendOpenAICompatibleRequest(options, {
      apiKey: this.options.openaiApiKey,
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      model: this.models.openai,
      agentLabel: AgentName.GPT,
      errorPrefix: 'OpenAI',
    });
  }

  private async sendDeepSeekRequest(options: LLMRequestOptions): Promise<ApiKeyResponse> {
    return this.sendOpenAICompatibleRequest(options, {
      apiKey: this.options.deepseekApiKey,
      hostname: 'api.deepseek.com',
      path: '/v1/chat/completions',
      model: this.models.deepseek,
      agentLabel: AgentName.DEEPSEEK,
      errorPrefix: 'DeepSeek',
    });
  }

  private async sendOpenAICompatibleRequest(
    options: LLMRequestOptions,
    params: { apiKey: string | undefined; hostname: string; path: string; model: string; agentLabel: AgentName; errorPrefix: string },
  ): Promise<ApiKeyResponse> {
    if (!params.apiKey) {
      throw new ApiKeyProviderError(
        `${params.errorPrefix} API key is not configured. Please run "AI Roundtable: Configure Provider".`,
      );
    }

    const history = options.conversationHistory ?? [];
    const messages: Array<Record<string, unknown>> = [
      { role: 'system', content: options.systemPrompt },
      ...history.map((turn) => ({ role: turn.role, content: turn.content })),
      { role: 'user', content: options.userMessage },
    ];

    const tools = options.onToolCall ? [READ_FILE_TOOL_OPENAI, RUN_COMMAND_TOOL_OPENAI, WRITE_FILE_TOOL_OPENAI, DELETE_FILE_TOOL_OPENAI] : undefined;
    const totalUsage = { inputTokens: 0, outputTokens: 0 };
    let finalText = '';

    for (;;) {
      const body = JSON.stringify({
        model: params.model,
        max_tokens: DEFAULT_MAX_TOKENS,
        messages,
        ...(tools ? { tools, tool_choice: 'auto' } : {}),
      });

      const responseText = await this.makeHttpsRequest({
        hostname: params.hostname,
        path: params.path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${params.apiKey}`,
          'Content-Length': Buffer.byteLength(body).toString(),
        },
        body,
        agentLabel: params.agentLabel,
        cancellationToken: options.cancellationToken,
      });

      let parsed: OpenAIResponseBody;
      try {
        parsed = JSON.parse(responseText) as OpenAIResponseBody;
      } catch {
        throw new ApiKeyProviderError(`${params.errorPrefix} API returned non-JSON response (${responseText.length} bytes).`);
      }

      if (parsed.error) {
        throw new ApiKeyProviderError(`${params.errorPrefix} API error (${parsed.error.type ?? 'unknown'}): ${parsed.error.message}`);
      }

      if (parsed.usage) {
        totalUsage.inputTokens += parsed.usage.prompt_tokens;
        totalUsage.outputTokens += parsed.usage.completion_tokens;
      }

      const message = parsed.choices?.[0]?.message;
      const finishReason = parsed.choices?.[0]?.finish_reason;
      if (message?.content) {finalText += message.content;}

      const toolCalls = message?.tool_calls;
      if (!toolCalls?.length || !options.onToolCall || finishReason !== 'tool_calls') {
        break;
      }

      if (options.cancellationToken?.isCancellationRequested) {
        throw new CancellationError();
      }

      // Append assistant message with tool calls
      messages.push({ role: 'assistant', content: message?.content ?? null, tool_calls: toolCalls });

      // Execute each tool call and append results
      for (const tc of toolCalls) {
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch {
          args = {};
        }
        const result = tc.function.name === 'run_command'
          ? await options.onToolCall({ id: tc.id, name: 'run_command', command: typeof args['command'] === 'string' ? args['command'] : '' })
          : tc.function.name === 'write_file'
            ? await options.onToolCall({ id: tc.id, name: 'write_file', filePath: typeof args['path'] === 'string' ? args['path'] : '', content: typeof args['content'] === 'string' ? args['content'] : '' })
            : tc.function.name === 'delete_file'
              ? await options.onToolCall({ id: tc.id, name: 'delete_file', filePath: typeof args['path'] === 'string' ? args['path'] : '' })
              : await options.onToolCall({ id: tc.id, name: 'read_file', filePath: typeof args['path'] === 'string' ? args['path'] : '' });
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result.content });
      }
    }

    if (!finalText.trim()) {
      throw new ApiKeyProviderError(`${params.errorPrefix} API returned no content in response.`);
    }

    return {
      content: finalText,
      usage: totalUsage.inputTokens > 0 ? totalUsage : undefined,
    };
  }

  private async sendGeminiRequest(options: LLMRequestOptions): Promise<ApiKeyResponse> {
    const apiKey = this.options.googleApiKey;
    if (!apiKey) {
      throw new ApiKeyProviderError(
        'Google API key is not configured. Please run "AI Roundtable: Configure Provider".',
      );
    }

    const history = options.conversationHistory ?? [];
    const contents: Array<Record<string, unknown>> = [
      ...history.map((turn) => ({
        role: turn.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: turn.content }],
      })),
      { role: 'user', parts: [{ text: options.userMessage }] },
    ];

    const tools = options.onToolCall
      ? [{ functionDeclarations: [READ_FILE_TOOL_GEMINI, RUN_COMMAND_TOOL_GEMINI, WRITE_FILE_TOOL_GEMINI, DELETE_FILE_TOOL_GEMINI] }]
      : undefined;
    const totalUsage = { inputTokens: 0, outputTokens: 0 };
    let finalText = '';

    for (;;) {
      const body = JSON.stringify({
        system_instruction: { parts: [{ text: options.systemPrompt }] },
        contents,
        generationConfig: { maxOutputTokens: DEFAULT_MAX_TOKENS },
        ...(tools ? { tools } : {}),
      });

      const responseText = await this.makeHttpsRequest({
        hostname: 'generativelanguage.googleapis.com',
        path: `/v1beta/models/${this.models.gemini}:generateContent`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
          'Content-Length': Buffer.byteLength(body).toString(),
        },
        body,
        agentLabel: AgentName.GEMINI,
        cancellationToken: options.cancellationToken,
      });

      let parsed: GeminiResponseBody;
      try {
        parsed = JSON.parse(responseText) as GeminiResponseBody;
      } catch {
        throw new ApiKeyProviderError(`Google Gemini API returned non-JSON response (${responseText.length} bytes).`);
      }

      if (parsed.error) {
        throw new ApiKeyProviderError(`Google Gemini API error (${parsed.error.status ?? 'unknown'}): ${parsed.error.message}`);
      }

      if (parsed.usageMetadata) {
        totalUsage.inputTokens += parsed.usageMetadata.promptTokenCount;
        totalUsage.outputTokens += parsed.usageMetadata.candidatesTokenCount;
      }

      const parts = parsed.candidates?.[0]?.content?.parts ?? [];
      const textPart = parts.find((p) => p.text !== undefined);
      if (textPart?.text) {finalText += textPart.text;}

      const functionCalls = parts.filter((p) => p.functionCall !== undefined);
      const finishReason = parsed.candidates?.[0]?.finishReason;
      if (!functionCalls.length || !options.onToolCall || finishReason !== 'STOP') {
        break;
      }

      if (options.cancellationToken?.isCancellationRequested) {
        throw new CancellationError();
      }

      // Append model message with function calls
      contents.push({ role: 'model', parts: parts });

      // Execute tool calls and append function responses
      const responseParts: Array<Record<string, unknown>> = [];
      for (const part of functionCalls) {
        const fc = part.functionCall;
        if (!fc) {
          continue;
        }
        const result = fc.name === 'run_command'
          ? await options.onToolCall({ id: fc.name, name: 'run_command', command: typeof fc.args['command'] === 'string' ? fc.args['command'] : '' })
          : fc.name === 'write_file'
            ? await options.onToolCall({ id: fc.name, name: 'write_file', filePath: typeof fc.args['path'] === 'string' ? fc.args['path'] : '', content: typeof fc.args['content'] === 'string' ? fc.args['content'] : '' })
            : fc.name === 'delete_file'
              ? await options.onToolCall({ id: fc.name, name: 'delete_file', filePath: typeof fc.args['path'] === 'string' ? fc.args['path'] : '' })
              : await options.onToolCall({ id: fc.name, name: 'read_file', filePath: typeof fc.args['path'] === 'string' ? fc.args['path'] : '' });
        responseParts.push({ functionResponse: { name: fc.name, response: { content: result.content } } });
      }
      contents.push({ role: 'user', parts: responseParts });
    }

    if (!finalText.trim()) {
      throw new ApiKeyProviderError('Google Gemini API returned no text content in response.');
    }

    return {
      content: finalText,
      usage: totalUsage.inputTokens > 0 ? totalUsage : undefined,
    };
  }

  private async sendClaudeStreamRequest(options: LLMRequestOptions): Promise<ApiKeyResponse> {
    const apiKey = this.options.anthropicApiKey;
    if (!apiKey) {
      throw new ApiKeyProviderError(
        'Anthropic API key is not configured. Please run "AI Roundtable: Configure Provider".',
      );
    }

    const tools = options.onToolCall ? [READ_FILE_TOOL_ANTHROPIC, RUN_COMMAND_TOOL_ANTHROPIC, WRITE_FILE_TOOL_ANTHROPIC, DELETE_FILE_TOOL_ANTHROPIC] : undefined;
    const history = options.conversationHistory ?? [];
    const messages: Array<{ role: string; content: unknown }> = [
      ...history.map((turn) => ({ role: turn.role, content: turn.content })),
      { role: 'user', content: options.userMessage },
    ];

    let inputTokens = 0;
    let outputTokens = 0;
    let finalText = '';

    for (;;) {
      const body = JSON.stringify({
        model: this.models.claude,
        max_tokens: DEFAULT_MAX_TOKENS,
        stream: true,
        system: [{ type: 'text', text: options.systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages,
        ...(tools ? { tools } : {}),
      });

      const contentChunks: string[] = [];
      let stopReason = '';
      // index → { id, name, accumulated input JSON }
      const toolBlocks = new Map<number, { id: string; name: string; inputJson: string }>();

      await this.makeHttpsStreamRequest({
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'prompt-caching-2024-07-31',
          'Content-Length': Buffer.byteLength(body).toString(),
        },
        body,
        agentLabel: AgentName.CLAUDE,
        cancellationToken: options.cancellationToken,
        onLine: (line) => {
          if (!line.startsWith('data: ')) {return;}
          const data = line.slice(6);
          if (data === '[DONE]') {return;}
          try {
            const parsed = JSON.parse(data) as Record<string, unknown>;
            const type = parsed['type'] as string | undefined;

            if (type === 'message_start') {
              const msg = parsed['message'] as Record<string, unknown> | undefined;
              const usage = msg?.['usage'] as Record<string, unknown> | undefined;
              inputTokens += (usage?.['input_tokens'] as number) ?? 0;
            } else if (type === 'content_block_start') {
              const index = parsed['index'] as number;
              const block = parsed['content_block'] as Record<string, unknown> | undefined;
              if (block?.['type'] === 'tool_use') {
                toolBlocks.set(index, {
                  id: (block['id'] as string) ?? '',
                  name: (block['name'] as string) ?? '',
                  inputJson: '',
                });
              }
            } else if (type === 'content_block_delta') {
              const index = parsed['index'] as number;
              const delta = parsed['delta'] as Record<string, unknown> | undefined;
              const deltaType = delta?.['type'] as string | undefined;
              if (deltaType === 'text_delta' && typeof delta?.['text'] === 'string') {
                contentChunks.push(delta['text']);
                options.onChunk?.(delta['text']);
              } else if (deltaType === 'input_json_delta' && typeof delta?.['partial_json'] === 'string') {
                const block = toolBlocks.get(index);
                if (block) {block.inputJson += delta['partial_json'];}
              }
            } else if (type === 'message_delta') {
              const delta = parsed['delta'] as Record<string, unknown> | undefined;
              stopReason = (delta?.['stop_reason'] as string) ?? stopReason;
              const usage = parsed['usage'] as Record<string, unknown> | undefined;
              outputTokens += (usage?.['output_tokens'] as number) ?? 0;
            }
          } catch { /* ignore malformed SSE lines */ }
        },
      });

      const text = contentChunks.join('');
      finalText += text;

      if (stopReason !== 'tool_use' || !options.onToolCall || toolBlocks.size === 0) {
        break;
      }

      if (options.cancellationToken?.isCancellationRequested) {
        throw new CancellationError();
      }

      // Append assistant message with text + tool_use blocks
      const assistantContent: Array<Record<string, unknown>> = [];
      if (text) {assistantContent.push({ type: 'text', text });}
      for (const [, block] of toolBlocks) {
        let input: Record<string, unknown> = {};
        try { input = JSON.parse(block.inputJson) as Record<string, unknown>; } catch { /* use empty */ }
        assistantContent.push({ type: 'tool_use', id: block.id, name: block.name, input });
      }
      messages.push({ role: 'assistant', content: assistantContent });

      // Execute tool calls and collect results
      const toolResults: Array<{ type: string; tool_use_id: string; content: string }> = [];
      for (const [, block] of toolBlocks) {
        let input: Record<string, unknown> = {};
        try { input = JSON.parse(block.inputJson) as Record<string, unknown>; } catch { /* use empty */ }
        const result = block.name === 'run_command'
          ? await options.onToolCall({ id: block.id, name: 'run_command', command: typeof input['command'] === 'string' ? input['command'] : '' })
          : block.name === 'write_file'
            ? await options.onToolCall({ id: block.id, name: 'write_file', filePath: typeof input['path'] === 'string' ? input['path'] : '', content: typeof input['content'] === 'string' ? input['content'] : '' })
            : block.name === 'delete_file'
              ? await options.onToolCall({ id: block.id, name: 'delete_file', filePath: typeof input['path'] === 'string' ? input['path'] : '' })
              : await options.onToolCall({ id: block.id, name: 'read_file', filePath: typeof input['path'] === 'string' ? input['path'] : '' });
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result.content });
      }
      messages.push({ role: 'user', content: toolResults });
    }

    if (!finalText.trim()) {
      throw new ApiKeyProviderError('Anthropic API returned an empty streaming response.');
    }
    return {
      content: finalText,
      usage: inputTokens || outputTokens ? { inputTokens, outputTokens } : undefined,
    };
  }

  private async sendOpenAIStreamRequest(options: LLMRequestOptions): Promise<ApiKeyResponse> {
    const apiKey = this.options.openaiApiKey;
    if (!apiKey) {
      throw new ApiKeyProviderError(
        'OpenAI API key is not configured. Please run "AI Roundtable: Configure Provider".',
      );
    }
    return this.sendOpenAICompatibleStreamRequest(options, {
      apiKey,
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      model: this.models.openai,
      agentLabel: AgentName.GPT,
      errorPrefix: 'OpenAI',
    });
  }

  private async sendDeepSeekStreamRequest(options: LLMRequestOptions): Promise<ApiKeyResponse> {
    const apiKey = this.options.deepseekApiKey;
    if (!apiKey) {
      throw new ApiKeyProviderError(
        'DeepSeek API key is not configured. Please run "AI Roundtable: Configure Provider".',
      );
    }
    return this.sendOpenAICompatibleStreamRequest(options, {
      apiKey,
      hostname: 'api.deepseek.com',
      path: '/v1/chat/completions',
      model: this.models.deepseek,
      agentLabel: AgentName.DEEPSEEK,
      errorPrefix: 'DeepSeek',
    });
  }

  private async sendOpenAICompatibleStreamRequest(
    options: LLMRequestOptions,
    params: { apiKey: string; hostname: string; path: string; model: string; agentLabel: AgentName; errorPrefix: string },
  ): Promise<ApiKeyResponse> {
    const tools = options.onToolCall ? [READ_FILE_TOOL_OPENAI, RUN_COMMAND_TOOL_OPENAI, WRITE_FILE_TOOL_OPENAI, DELETE_FILE_TOOL_OPENAI] : undefined;
    const history = options.conversationHistory ?? [];
    const messages: Array<Record<string, unknown>> = [
      { role: 'system', content: options.systemPrompt },
      ...history.map((turn) => ({ role: turn.role, content: turn.content })),
      { role: 'user', content: options.userMessage },
    ];

    let inputTokens = 0;
    let outputTokens = 0;
    let finalText = '';

    for (;;) {
      const body = JSON.stringify({
        model: params.model,
        max_tokens: DEFAULT_MAX_TOKENS,
        stream: true,
        stream_options: { include_usage: true },
        messages,
        ...(tools ? { tools, tool_choice: 'auto' } : {}),
      });

      const contentChunks: string[] = [];
      let finishReason = '';
      // index → { id, name, accumulated arguments JSON }
      const toolCalls = new Map<number, { id: string; name: string; argsJson: string }>();

      await this.makeHttpsStreamRequest({
        hostname: params.hostname,
        path: params.path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${params.apiKey}`,
          'Content-Length': Buffer.byteLength(body).toString(),
        },
        body,
        agentLabel: params.agentLabel,
        cancellationToken: options.cancellationToken,
        onLine: (line) => {
          if (!line.startsWith('data: ')) {return;}
          const data = line.slice(6);
          if (data === '[DONE]') {return;}
          try {
            const parsed = JSON.parse(data) as Record<string, unknown>;
            const choices = parsed['choices'] as Array<Record<string, unknown>> | undefined;
            const choice = choices?.[0];
            const delta = choice?.['delta'] as Record<string, unknown> | undefined;
            const fr = choice?.['finish_reason'] as string | undefined;
            if (fr) {finishReason = fr;}

            if (typeof delta?.['content'] === 'string' && delta['content']) {
              contentChunks.push(delta['content']);
              options.onChunk?.(delta['content']);
            }

            const tcDeltas = delta?.['tool_calls'] as Array<Record<string, unknown>> | undefined;
            if (tcDeltas) {
              for (const tc of tcDeltas) {
                const index = tc['index'] as number;
                if (!toolCalls.has(index)) {
                  toolCalls.set(index, { id: '', name: '', argsJson: '' });
                }
                const existing = toolCalls.get(index);
                if (!existing) {
                  continue;
                }
                if (tc['id']) {existing.id = tc['id'] as string;}
                const fn = tc['function'] as Record<string, unknown> | undefined;
                if (fn?.['name']) {existing.name = fn['name'] as string;}
                if (fn?.['arguments']) {existing.argsJson += fn['arguments'] as string;}
              }
            }

            const usage = parsed['usage'] as Record<string, unknown> | undefined;
            if (usage) {
              inputTokens = (usage['prompt_tokens'] as number) ?? 0;
              outputTokens = (usage['completion_tokens'] as number) ?? 0;
            }
          } catch { /* ignore malformed SSE lines */ }
        },
      });

      const text = contentChunks.join('');
      finalText += text;

      if (finishReason !== 'tool_calls' || !options.onToolCall || toolCalls.size === 0) {
        break;
      }

      if (options.cancellationToken?.isCancellationRequested) {
        throw new CancellationError();
      }

      // Append assistant message with tool calls
      const tcArray = Array.from(toolCalls.values()).map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.argsJson },
      }));
      messages.push({ role: 'assistant', content: text || null, tool_calls: tcArray });

      // Execute tool calls and append results
      for (const tc of toolCalls.values()) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(tc.argsJson) as Record<string, unknown>; } catch { /* use empty */ }
        const result = tc.name === 'run_command'
          ? await options.onToolCall({ id: tc.id, name: 'run_command', command: typeof args['command'] === 'string' ? args['command'] : '' })
          : tc.name === 'write_file'
            ? await options.onToolCall({ id: tc.id, name: 'write_file', filePath: typeof args['path'] === 'string' ? args['path'] : '', content: typeof args['content'] === 'string' ? args['content'] : '' })
            : tc.name === 'delete_file'
              ? await options.onToolCall({ id: tc.id, name: 'delete_file', filePath: typeof args['path'] === 'string' ? args['path'] : '' })
              : await options.onToolCall({ id: tc.id, name: 'read_file', filePath: typeof args['path'] === 'string' ? args['path'] : '' });
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result.content });
      }
    }

    if (!finalText.trim()) {
      throw new ApiKeyProviderError(`${params.errorPrefix} API returned an empty streaming response.`);
    }
    return {
      content: finalText,
      usage: inputTokens || outputTokens ? { inputTokens, outputTokens } : undefined,
    };
  }

  private async sendGeminiStreamRequest(options: LLMRequestOptions): Promise<ApiKeyResponse> {
    const apiKey = this.options.googleApiKey;
    if (!apiKey) {
      throw new ApiKeyProviderError(
        'Google API key is not configured. Please run "AI Roundtable: Configure Provider".',
      );
    }

    const tools = options.onToolCall ? [{ functionDeclarations: [READ_FILE_TOOL_GEMINI, RUN_COMMAND_TOOL_GEMINI, WRITE_FILE_TOOL_GEMINI, DELETE_FILE_TOOL_GEMINI] }] : undefined;
    const history = options.conversationHistory ?? [];
    const contents: Array<Record<string, unknown>> = [
      ...history.map((turn) => ({
        role: turn.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: turn.content }],
      })),
      { role: 'user', parts: [{ text: options.userMessage }] },
    ];

    let inputTokens = 0;
    let outputTokens = 0;
    let finalText = '';

    for (;;) {
      const body = JSON.stringify({
        system_instruction: { parts: [{ text: options.systemPrompt }] },
        contents,
        generationConfig: { maxOutputTokens: DEFAULT_MAX_TOKENS },
        ...(tools ? { tools } : {}),
      });

      const contentChunks: string[] = [];
      const functionCallParts: Array<Record<string, unknown>> = [];

      await this.makeHttpsStreamRequest({
        hostname: 'generativelanguage.googleapis.com',
        path: `/v1beta/models/${this.models.gemini}:streamGenerateContent?alt=sse`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
          'Content-Length': Buffer.byteLength(body).toString(),
        },
        body,
        agentLabel: AgentName.GEMINI,
        cancellationToken: options.cancellationToken,
        onLine: (line) => {
          if (!line.startsWith('data: ')) {return;}
          const data = line.slice(6);
          try {
            const parsed = JSON.parse(data) as Record<string, unknown>;
            if (parsed['error']) {
              const err = parsed['error'] as Record<string, unknown>;
              const status = typeof err['status'] === 'string' ? err['status'] : 'unknown';
              const message = typeof err['message'] === 'string' ? err['message'] : 'Unknown error';
              throw new ApiKeyProviderError(
                `Google Gemini API error (${status}): ${message}`,
              );
            }
            const candidates = parsed['candidates'] as Array<Record<string, unknown>> | undefined;
            const parts = (candidates?.[0]?.['content'] as Record<string, unknown> | undefined)?.['parts'] as Array<Record<string, unknown>> | undefined;
            if (parts) {
              for (const part of parts) {
                if (typeof part['text'] === 'string' && part['text']) {
                  contentChunks.push(part['text']);
                  options.onChunk?.(part['text']);
                }
                if (part['functionCall']) {
                  functionCallParts.push(part);
                }
              }
            }
            const usageMeta = parsed['usageMetadata'] as Record<string, unknown> | undefined;
            if (usageMeta) {
              inputTokens = (usageMeta['promptTokenCount'] as number) ?? inputTokens;
              outputTokens = (usageMeta['candidatesTokenCount'] as number) ?? outputTokens;
            }
          } catch (err) {
            if (err instanceof ApiKeyProviderError) {throw err;}
            /* ignore malformed SSE lines */
          }
        },
      });

      const text = contentChunks.join('');
      finalText += text;

      if (!functionCallParts.length || !options.onToolCall) {
        break;
      }

      if (options.cancellationToken?.isCancellationRequested) {
        throw new CancellationError();
      }

      // Append model turn with text + function calls
      const modelParts: Array<Record<string, unknown>> = [];
      if (text) {modelParts.push({ text });}
      modelParts.push(...functionCallParts);
      contents.push({ role: 'model', parts: modelParts });

      // Execute tool calls and collect function responses
      const responseParts: Array<Record<string, unknown>> = [];
      for (const part of functionCallParts) {
        const fc = part['functionCall'] as { name: string; args: Record<string, unknown> };
        const result = fc.name === 'run_command'
          ? await options.onToolCall({ id: fc.name, name: 'run_command', command: typeof fc.args['command'] === 'string' ? fc.args['command'] : '' })
          : fc.name === 'write_file'
            ? await options.onToolCall({ id: fc.name, name: 'write_file', filePath: typeof fc.args['path'] === 'string' ? fc.args['path'] : '', content: typeof fc.args['content'] === 'string' ? fc.args['content'] : '' })
            : fc.name === 'delete_file'
              ? await options.onToolCall({ id: fc.name, name: 'delete_file', filePath: typeof fc.args['path'] === 'string' ? fc.args['path'] : '' })
              : await options.onToolCall({ id: fc.name, name: 'read_file', filePath: typeof fc.args['path'] === 'string' ? fc.args['path'] : '' });
        responseParts.push({ functionResponse: { name: fc.name, response: { content: result.content } } });
      }
      contents.push({ role: 'user', parts: responseParts });
    }

    if (!finalText.trim()) {
      throw new ApiKeyProviderError('Google Gemini API returned an empty streaming response.');
    }
    return {
      content: finalText,
      usage: inputTokens || outputTokens ? { inputTokens, outputTokens } : undefined,
    };
  }

  private makeHttpsStreamRequest(
    params: {
      hostname: string;
      path: string;
      method: string;
      headers: Record<string, string>;
      body: string;
      agentLabel: AgentName;
      onLine: (line: string) => void;
      cancellationToken?: LLMRequestOptions['cancellationToken'];
    },
    retriesLeft = 2,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: params.hostname,
          path: params.path,
          method: params.method,
          headers: params.headers,
        },
        (res: http.IncomingMessage) => {
          // Rate-limited — drain response, wait, then retry (safe: onLine not yet called)
          if (res.statusCode === 429 && retriesLeft > 0) {
            res.resume();
            const delayMs = this.parseRetryAfterMs(res.headers['retry-after']);
            setTimeout(() => {
              this.makeHttpsStreamRequest(params, retriesLeft - 1).then(resolve, reject);
            }, delayMs);
            return;
          }

          if (res.statusCode !== undefined && (res.statusCode < 200 || res.statusCode >= 300)) {
            const errorChunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => errorChunks.push(chunk));
            res.on('end', () => {
              const snippet = Buffer.concat(errorChunks).toString('utf-8').slice(0, 300);
              reject(
                new ApiKeyProviderError(
                  `${params.agentLabel} API request failed with HTTP ${res.statusCode}: ${snippet}`,
                  res.statusCode,
                ),
              );
            });
            return;
          }

          let buffer = '';

          res.on('data', (chunk: Buffer) => {
            buffer += chunk.toString('utf-8');
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
              try {
                params.onLine(line);
              } catch (err) {
                reject(err);
              }
            }
          });

          res.on('end', () => {
            if (buffer) {
              try {
                params.onLine(buffer);
              } catch (err) {
                reject(err);
                return;
              }
            }
            resolve();
          });

          res.on('error', (err: Error) => {
            reject(
              new ApiKeyProviderError(
                `Network error reading stream from ${params.hostname}: ${err.message}`,
                undefined,
                err,
              ),
            );
          });
        },
      );

      req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        req.destroy(
          new ApiKeyProviderError(
            `Stream request to ${params.hostname} timed out after ${REQUEST_TIMEOUT_MS / 1000}s`,
          ),
        );
      });

      // Abort the request immediately if the cancellation token fires
      const cancelDisposable = params.cancellationToken?.onCancellationRequested(() => {
        req.destroy(new CancellationError());
      });
      const disposeCancellation = () => {
        cancelDisposable?.dispose();
      };
      req.on('close', disposeCancellation);

      req.on('error', (err: Error) => {
        disposeCancellation();
        if (err instanceof CancellationError || err instanceof ApiKeyProviderError) {
          reject(err);
        } else {
          reject(
            new ApiKeyProviderError(
              `Network error connecting to ${params.hostname}: ${err.message}`,
              undefined,
              err,
            ),
          );
        }
      });

      req.write(params.body);
      req.end();
    });
  }

  private makeHttpsRequest(
    params: {
      hostname: string;
      path: string;
      method: string;
      headers: Record<string, string>;
      body: string;
      agentLabel: AgentName;
      cancellationToken?: LLMRequestOptions['cancellationToken'];
    },
    retriesLeft = 2,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: params.hostname,
          path: params.path,
          method: params.method,
          headers: params.headers,
        },
        (res: http.IncomingMessage) => {
          // Rate-limited — drain response, wait, then retry
          if (res.statusCode === 429 && retriesLeft > 0) {
            res.resume();
            const delayMs = this.parseRetryAfterMs(res.headers['retry-after']);
            setTimeout(() => {
              this.makeHttpsRequest(params, retriesLeft - 1).then(resolve, reject);
            }, delayMs);
            return;
          }

          const chunks: Buffer[] = [];
          let totalBytes = 0;

          res.on('data', (chunk: Buffer) => {
            totalBytes += chunk.length;
            if (totalBytes > MAX_RESPONSE_BYTES) {
              req.destroy(
                new ApiKeyProviderError(
                  `Response from ${params.hostname} exceeded maximum size of ${MAX_RESPONSE_BYTES} bytes.`,
                ),
              );
              return;
            }
            chunks.push(chunk);
          });

          res.on('end', () => {
            disposeCancellation();
            const responseText = Buffer.concat(chunks).toString('utf-8');

            if (
              res.statusCode !== undefined &&
              (res.statusCode < 200 || res.statusCode >= 300)
            ) {
              const snippet = responseText.slice(0, 300);
              reject(
                new ApiKeyProviderError(
                  `${params.agentLabel} API request failed with HTTP ${res.statusCode}: ${snippet}`,
                  res.statusCode,
                ),
              );
              return;
            }

            resolve(responseText);
          });

          res.on('error', (err: Error) => {
            disposeCancellation();
            reject(
              new ApiKeyProviderError(
                `Network error reading response from ${params.hostname}: ${err.message}`,
                undefined,
                err,
              ),
            );
          });
        },
      );

      req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        req.destroy(
          new ApiKeyProviderError(
            `Request to ${params.hostname} timed out after ${REQUEST_TIMEOUT_MS / 1000}s`,
          ),
        );
      });

      const cancelDisposable = params.cancellationToken?.onCancellationRequested(() => {
        req.destroy(new CancellationError());
      });
      const disposeCancellation = () => {
        cancelDisposable?.dispose();
      };
      req.on('close', disposeCancellation);

      req.on('error', (err: Error) => {
        disposeCancellation();
        if (err instanceof CancellationError || err instanceof ApiKeyProviderError) {
          reject(err);
        } else {
          reject(
            new ApiKeyProviderError(
              `Network error connecting to ${params.hostname}: ${err.message}`,
              undefined,
              err,
            ),
          );
        }
      });

      req.write(params.body);
      req.end();
    });
  }

  /** Parses Retry-After header value (seconds) into milliseconds. Defaults to 60s. */
  private parseRetryAfterMs(retryAfter: string | string[] | undefined): number {
    const DEFAULT_MS = 60_000;
    if (!retryAfter) {
      return DEFAULT_MS;
    }
    const val = Array.isArray(retryAfter) ? retryAfter[0] : retryAfter;
    const seconds = Number(val);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_MS;
  }
}
