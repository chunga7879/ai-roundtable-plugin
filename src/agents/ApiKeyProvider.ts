import * as https from 'https';
import type * as http from 'http';
import { AgentName } from '../types';
import type { ConversationTurn } from '../types';
import { ProviderError } from '../errors';

export interface ApiKeyProviderOptions {
  anthropicApiKey?: string;
  openaiApiKey?: string;
  googleApiKey?: string;
  deepseekApiKey?: string;
}

export interface LLMRequestOptions {
  systemPrompt: string;
  userMessage: string;
  maxTokens: number;
  conversationHistory?: ConversationTurn[];
}

/** Re-exported for backwards compatibility with AgentRunner imports */
export class ApiKeyProviderError extends ProviderError {
  constructor(message: string, statusCode?: number, cause?: unknown) {
    super(message, statusCode, cause);
    this.name = 'ApiKeyProviderError';
  }
}

const CLAUDE_MODEL = 'claude-sonnet-4-6';
const OPENAI_MODEL = 'gpt-4o';
const GEMINI_MODEL = 'gemini-1.5-pro';
const DEEPSEEK_MODEL = 'deepseek-coder';

const REQUEST_TIMEOUT_MS = 120_000;

/** Maximum response body size to read (10 MB). Prevents OOM from runaway responses. */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

interface AnthropicResponseBody {
  content?: Array<{ type: string; text: string }>;
  error?: { message: string; type?: string };
}

interface OpenAIResponseBody {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message: string; type?: string };
}

interface GeminiResponseBody {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
  error?: { message: string; status?: string };
}

export class ApiKeyProvider {
  constructor(private readonly options: ApiKeyProviderOptions) {}

  async sendRequest(
    agentName: AgentName,
    requestOptions: LLMRequestOptions,
  ): Promise<string> {
    switch (agentName) {
      case AgentName.CLAUDE:
        return this.sendClaudeRequest(requestOptions);
      case AgentName.GPT:
        return this.sendOpenAIRequest(requestOptions);
      case AgentName.GEMINI:
        return this.sendGeminiRequest(requestOptions);
      case AgentName.DEEPSEEK:
        return this.sendDeepSeekRequest(requestOptions);
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

  private async sendClaudeRequest(options: LLMRequestOptions): Promise<string> {
    const apiKey = this.options.anthropicApiKey;
    if (!apiKey) {
      throw new ApiKeyProviderError(
        'Anthropic API key is not configured. Please run "AI Roundtable: Configure Provider".',
      );
    }

    const history = options.conversationHistory ?? [];
    const body = JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: options.maxTokens,
      system: options.systemPrompt,
      messages: [
        ...history.map((turn) => ({ role: turn.role, content: turn.content })),
        { role: 'user', content: options.userMessage },
      ],
    });

    const responseText = await this.makeHttpsRequest({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body).toString(),
      },
      body,
      agentLabel: AgentName.CLAUDE,
    });

    let parsed: AnthropicResponseBody;
    try {
      parsed = JSON.parse(responseText) as AnthropicResponseBody;
    } catch {
      throw new ApiKeyProviderError(
        `Anthropic API returned non-JSON response (${responseText.length} bytes).`,
      );
    }

    if (parsed.error) {
      // Include error type but never the API key
      throw new ApiKeyProviderError(
        `Anthropic API error (${parsed.error.type ?? 'unknown'}): ${parsed.error.message}`,
      );
    }

    const textContent = parsed.content?.find((c) => c.type === 'text');
    if (!textContent) {
      throw new ApiKeyProviderError(
        'Anthropic API returned no text content in response.',
      );
    }

    return textContent.text;
  }

  private async sendOpenAIRequest(options: LLMRequestOptions): Promise<string> {
    const apiKey = this.options.openaiApiKey;
    if (!apiKey) {
      throw new ApiKeyProviderError(
        'OpenAI API key is not configured. Please run "AI Roundtable: Configure Provider".',
      );
    }

    const history = options.conversationHistory ?? [];
    const body = JSON.stringify({
      model: OPENAI_MODEL,
      max_tokens: options.maxTokens,
      messages: [
        { role: 'system', content: options.systemPrompt },
        ...history.map((turn) => ({ role: turn.role, content: turn.content })),
        { role: 'user', content: options.userMessage },
      ],
    });

    const responseText = await this.makeHttpsRequest({
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body).toString(),
      },
      body,
      agentLabel: AgentName.GPT,
    });

    let parsed: OpenAIResponseBody;
    try {
      parsed = JSON.parse(responseText) as OpenAIResponseBody;
    } catch {
      throw new ApiKeyProviderError(
        `OpenAI API returned non-JSON response (${responseText.length} bytes).`,
      );
    }

    if (parsed.error) {
      throw new ApiKeyProviderError(
        `OpenAI API error (${parsed.error.type ?? 'unknown'}): ${parsed.error.message}`,
      );
    }

    const content = parsed.choices?.[0]?.message?.content;
    if (content === undefined || content === null) {
      throw new ApiKeyProviderError(
        'OpenAI API returned no content in response.',
      );
    }

    return content;
  }

  private async sendDeepSeekRequest(options: LLMRequestOptions): Promise<string> {
    const apiKey = this.options.deepseekApiKey;
    if (!apiKey) {
      throw new ApiKeyProviderError(
        'DeepSeek API key is not configured. Please run "AI Roundtable: Configure Provider".',
      );
    }

    const history = options.conversationHistory ?? [];
    const body = JSON.stringify({
      model: DEEPSEEK_MODEL,
      max_tokens: options.maxTokens,
      messages: [
        { role: 'system', content: options.systemPrompt },
        ...history.map((turn) => ({ role: turn.role, content: turn.content })),
        { role: 'user', content: options.userMessage },
      ],
    });

    const responseText = await this.makeHttpsRequest({
      hostname: 'api.deepseek.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body).toString(),
      },
      body,
      agentLabel: AgentName.DEEPSEEK,
    });

    let parsed: OpenAIResponseBody;
    try {
      parsed = JSON.parse(responseText) as OpenAIResponseBody;
    } catch {
      throw new ApiKeyProviderError(
        `DeepSeek API returned non-JSON response (${responseText.length} bytes).`,
      );
    }

    if (parsed.error) {
      throw new ApiKeyProviderError(
        `DeepSeek API error (${parsed.error.type ?? 'unknown'}): ${parsed.error.message}`,
      );
    }

    const content = parsed.choices?.[0]?.message?.content;
    if (content === undefined || content === null) {
      throw new ApiKeyProviderError('DeepSeek API returned no content in response.');
    }

    return content;
  }

  private async sendGeminiRequest(
    options: LLMRequestOptions,
  ): Promise<string> {
    const apiKey = this.options.googleApiKey;
    if (!apiKey) {
      throw new ApiKeyProviderError(
        'Google API key is not configured. Please run "AI Roundtable: Configure Provider".',
      );
    }

    const history = options.conversationHistory ?? [];
    const body = JSON.stringify({
      system_instruction: {
        parts: [{ text: options.systemPrompt }],
      },
      contents: [
        ...history.map((turn) => ({
          role: turn.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: turn.content }],
        })),
        {
          role: 'user',
          parts: [{ text: options.userMessage }],
        },
      ],
      generationConfig: {
        maxOutputTokens: options.maxTokens,
      },
    });

    // Note: apiKey is placed in query param as per Google API convention — never logged
    const path = `/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

    const responseText = await this.makeHttpsRequest({
      hostname: 'generativelanguage.googleapis.com',
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body).toString(),
      },
      body,
      agentLabel: AgentName.GEMINI,
    });

    let parsed: GeminiResponseBody;
    try {
      parsed = JSON.parse(responseText) as GeminiResponseBody;
    } catch {
      throw new ApiKeyProviderError(
        `Google Gemini API returned non-JSON response (${responseText.length} bytes).`,
      );
    }

    if (parsed.error) {
      throw new ApiKeyProviderError(
        `Google Gemini API error (${parsed.error.status ?? 'unknown'}): ${parsed.error.message}`,
      );
    }

    const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text === undefined) {
      throw new ApiKeyProviderError(
        'Google Gemini API returned no text content in response.',
      );
    }

    return text;
  }

  private makeHttpsRequest(params: {
    hostname: string;
    path: string;
    method: string;
    headers: Record<string, string>;
    body: string;
    agentLabel: AgentName;
  }): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: params.hostname,
          path: params.path,
          method: params.method,
          headers: params.headers,
        },
        (res: http.IncomingMessage) => {
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
            const responseText = Buffer.concat(chunks).toString('utf-8');

            if (
              res.statusCode !== undefined &&
              (res.statusCode < 200 || res.statusCode >= 300)
            ) {
              // Truncate body to avoid leaking verbose API error payloads into logs
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

      req.on('error', (err: Error) => {
        if (err instanceof ApiKeyProviderError) {
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
}
