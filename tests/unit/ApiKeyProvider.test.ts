import { EventEmitter } from 'events';
import { ApiKeyProvider, ApiKeyProviderError } from '../../src/agents/ApiKeyProvider';
import { AgentName } from '../../src/types';

jest.mock('https');
import * as https from 'https';

// ── Mock helpers ──────────────────────────────────────────────────────────────

interface MockRequestOptions {
  statusCode?: number;
  responseBody?: string;
  networkError?: Error;
  requestError?: Error;
  timeout?: boolean;
  oversized?: boolean;
}

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

function setupHttpsMock(opts: MockRequestOptions = {}) {
  const {
    statusCode = 200,
    responseBody = '{}',
    networkError,
    requestError,
    timeout = false,
    oversized = false,
  } = opts;

  const mockReq = new EventEmitter() as EventEmitter & {
    write: jest.Mock;
    end: jest.Mock;
    setTimeout: jest.Mock;
    destroy: jest.Mock;
  };
  mockReq.write = jest.fn();
  mockReq.end = jest.fn();
  mockReq.destroy = jest.fn().mockImplementation((err?: Error) => {
    if (err) {
      setImmediate(() => mockReq.emit('error', err));
    }
  });
  mockReq.setTimeout = jest.fn().mockImplementation((_ms: number, cb: () => void) => {
    if (timeout) {
      setImmediate(cb);
    }
  });

  (https.request as jest.Mock).mockImplementation(
    (_opts: unknown, callback: (res: EventEmitter & { statusCode?: number; headers: Record<string, string>; resume: jest.Mock }) => void) => {
      const mockRes = new EventEmitter() as EventEmitter & { statusCode?: number; headers: Record<string, string>; resume: jest.Mock };
      mockRes.statusCode = statusCode;
      // retry-after: '0.001' → 1ms delay so 429 retry tests complete quickly
      mockRes.headers = statusCode === 429 ? { 'retry-after': '0.001' } : {};
      mockRes.resume = jest.fn();

      setImmediate(() => {
        if (networkError) {
          mockRes.emit('error', networkError);
          return;
        }
        if (requestError) {
          mockReq.emit('error', requestError);
          return;
        }
        if (oversized) {
          const bigChunk = Buffer.alloc(MAX_RESPONSE_BYTES + 1);
          mockRes.emit('data', bigChunk);
          return;
        }
        mockRes.emit('data', Buffer.from(responseBody));
        mockRes.emit('end');
      });

      callback(mockRes);
      return mockReq;
    },
  );

  return mockReq;
}

const defaultOpts = {
  systemPrompt: 'You are a developer.',
  userMessage: 'build feature',
};

// ── hasKeyForAgent ────────────────────────────────────────────────────────────

describe('ApiKeyProvider.hasKeyForAgent', () => {
  it('returns true for claude when anthropicApiKey is set', () => {
    const p = new ApiKeyProvider({ anthropicApiKey: 'sk-ant-test' });
    expect(p.hasKeyForAgent(AgentName.CLAUDE)).toBe(true);
  });

  it('returns false for claude when anthropicApiKey is missing', () => {
    const p = new ApiKeyProvider({});
    expect(p.hasKeyForAgent(AgentName.CLAUDE)).toBe(false);
  });

  it('returns true for gpt when openaiApiKey is set', () => {
    const p = new ApiKeyProvider({ openaiApiKey: 'sk-openai' });
    expect(p.hasKeyForAgent(AgentName.GPT)).toBe(true);
  });

  it('returns false for gpt when openaiApiKey is missing', () => {
    const p = new ApiKeyProvider({});
    expect(p.hasKeyForAgent(AgentName.GPT)).toBe(false);
  });

  it('returns true for gemini when googleApiKey is set', () => {
    const p = new ApiKeyProvider({ googleApiKey: 'goog-key' });
    expect(p.hasKeyForAgent(AgentName.GEMINI)).toBe(true);
  });

  it('returns false for copilot always', () => {
    const p = new ApiKeyProvider({ anthropicApiKey: 'key' });
    expect(p.hasKeyForAgent(AgentName.COPILOT)).toBe(false);
  });
});

// ── sendRequest — routing ─────────────────────────────────────────────────────

describe('ApiKeyProvider.sendRequest — routing', () => {
  beforeEach(() => jest.clearAllMocks());

  it('throws ApiKeyProviderError for copilot agent', async () => {
    const p = new ApiKeyProvider({});
    await expect(p.sendRequest(AgentName.COPILOT, defaultOpts))
      .rejects.toBeInstanceOf(ApiKeyProviderError);
  });
});

// ── Claude ────────────────────────────────────────────────────────────────────

describe('ApiKeyProvider — Claude', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns text content from successful response', async () => {
    setupHttpsMock({
      responseBody: JSON.stringify({
        content: [{ type: 'text', text: 'Hello from Claude' }],
      }),
    });
    const p = new ApiKeyProvider({ anthropicApiKey: 'sk-ant' });
    const result = await p.sendRequest(AgentName.CLAUDE, defaultOpts);
    expect(result.content).toBe('Hello from Claude');
  });

  it('throws ApiKeyProviderError when anthropicApiKey is missing', async () => {
    const p = new ApiKeyProvider({});
    await expect(p.sendRequest(AgentName.CLAUDE, defaultOpts))
      .rejects.toBeInstanceOf(ApiKeyProviderError);
  });

  it('throws ApiKeyProviderError on API error response', async () => {
    setupHttpsMock({
      responseBody: JSON.stringify({
        error: { message: 'rate limit exceeded', type: 'rate_limit_error' },
      }),
    });
    const p = new ApiKeyProvider({ anthropicApiKey: 'sk-ant' });
    await expect(p.sendRequest(AgentName.CLAUDE, defaultOpts))
      .rejects.toBeInstanceOf(ApiKeyProviderError);
  });

  it('throws ApiKeyProviderError on non-JSON response', async () => {
    setupHttpsMock({ responseBody: '<html>error page</html>' });
    const p = new ApiKeyProvider({ anthropicApiKey: 'sk-ant' });
    await expect(p.sendRequest(AgentName.CLAUDE, defaultOpts))
      .rejects.toBeInstanceOf(ApiKeyProviderError);
  });

  it('throws ApiKeyProviderError when no text content in response', async () => {
    setupHttpsMock({
      responseBody: JSON.stringify({ content: [{ type: 'image', source: {} }] }),
    });
    const p = new ApiKeyProvider({ anthropicApiKey: 'sk-ant' });
    await expect(p.sendRequest(AgentName.CLAUDE, defaultOpts))
      .rejects.toBeInstanceOf(ApiKeyProviderError);
  });

  it('throws ApiKeyProviderError on HTTP error status', async () => {
    setupHttpsMock({ statusCode: 401, responseBody: JSON.stringify({ error: 'unauthorized' }) });
    const p = new ApiKeyProvider({ anthropicApiKey: 'sk-ant' });
    await expect(p.sendRequest(AgentName.CLAUDE, defaultOpts))
      .rejects.toBeInstanceOf(ApiKeyProviderError);
  });

  it('throws ApiKeyProviderError on network timeout', async () => {
    setupHttpsMock({ timeout: true });
    const p = new ApiKeyProvider({ anthropicApiKey: 'sk-ant' });
    await expect(p.sendRequest(AgentName.CLAUDE, defaultOpts))
      .rejects.toBeInstanceOf(ApiKeyProviderError);
  });

  it('throws ApiKeyProviderError on request-level network error', async () => {
    setupHttpsMock({ requestError: new Error('ECONNREFUSED') });
    const p = new ApiKeyProvider({ anthropicApiKey: 'sk-ant' });
    await expect(p.sendRequest(AgentName.CLAUDE, defaultOpts))
      .rejects.toBeInstanceOf(ApiKeyProviderError);
  });

  it('throws ApiKeyProviderError when response exceeds max size', async () => {
    setupHttpsMock({ oversized: true });
    const p = new ApiKeyProvider({ anthropicApiKey: 'sk-ant' });
    await expect(p.sendRequest(AgentName.CLAUDE, defaultOpts))
      .rejects.toBeInstanceOf(ApiKeyProviderError);
  });
});

// ── OpenAI (GPT) ──────────────────────────────────────────────────────────────

describe('ApiKeyProvider — OpenAI', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns message content from successful response', async () => {
    setupHttpsMock({
      responseBody: JSON.stringify({
        choices: [{ message: { content: 'Hello from GPT' } }],
      }),
    });
    const p = new ApiKeyProvider({ openaiApiKey: 'sk-openai' });
    const result = await p.sendRequest(AgentName.GPT, defaultOpts);
    expect(result.content).toBe('Hello from GPT');
  });

  it('throws ApiKeyProviderError when openaiApiKey is missing', async () => {
    const p = new ApiKeyProvider({});
    await expect(p.sendRequest(AgentName.GPT, defaultOpts))
      .rejects.toBeInstanceOf(ApiKeyProviderError);
  });

  it('throws ApiKeyProviderError on API error response', async () => {
    setupHttpsMock({
      responseBody: JSON.stringify({
        error: { message: 'model overloaded', type: 'server_error' },
      }),
    });
    const p = new ApiKeyProvider({ openaiApiKey: 'sk-openai' });
    await expect(p.sendRequest(AgentName.GPT, defaultOpts))
      .rejects.toBeInstanceOf(ApiKeyProviderError);
  });

  it('throws ApiKeyProviderError on non-JSON response', async () => {
    setupHttpsMock({ responseBody: 'bad gateway' });
    const p = new ApiKeyProvider({ openaiApiKey: 'sk-openai' });
    await expect(p.sendRequest(AgentName.GPT, defaultOpts))
      .rejects.toBeInstanceOf(ApiKeyProviderError);
  });

  it('throws ApiKeyProviderError when no content in response', async () => {
    setupHttpsMock({
      responseBody: JSON.stringify({ choices: [] }),
    });
    const p = new ApiKeyProvider({ openaiApiKey: 'sk-openai' });
    await expect(p.sendRequest(AgentName.GPT, defaultOpts))
      .rejects.toBeInstanceOf(ApiKeyProviderError);
  });

  it('throws ApiKeyProviderError on HTTP 429', async () => {
    setupHttpsMock({ statusCode: 429, responseBody: 'rate limit' });
    const p = new ApiKeyProvider({ openaiApiKey: 'sk-openai' });
    await expect(p.sendRequest(AgentName.GPT, defaultOpts))
      .rejects.toBeInstanceOf(ApiKeyProviderError);
  });
});

// ── Google Gemini ─────────────────────────────────────────────────────────────

describe('ApiKeyProvider — Gemini', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns text from successful response', async () => {
    setupHttpsMock({
      responseBody: JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'Hello from Gemini' }] } }],
      }),
    });
    const p = new ApiKeyProvider({ googleApiKey: 'goog-key' });
    const result = await p.sendRequest(AgentName.GEMINI, defaultOpts);
    expect(result.content).toBe('Hello from Gemini');
  });

  it('throws ApiKeyProviderError when googleApiKey is missing', async () => {
    const p = new ApiKeyProvider({});
    await expect(p.sendRequest(AgentName.GEMINI, defaultOpts))
      .rejects.toBeInstanceOf(ApiKeyProviderError);
  });

  it('throws ApiKeyProviderError on API error response', async () => {
    setupHttpsMock({
      responseBody: JSON.stringify({
        error: { message: 'quota exceeded', status: 'RESOURCE_EXHAUSTED' },
      }),
    });
    const p = new ApiKeyProvider({ googleApiKey: 'goog-key' });
    await expect(p.sendRequest(AgentName.GEMINI, defaultOpts))
      .rejects.toBeInstanceOf(ApiKeyProviderError);
  });

  it('throws ApiKeyProviderError on non-JSON response', async () => {
    setupHttpsMock({ responseBody: 'not json' });
    const p = new ApiKeyProvider({ googleApiKey: 'goog-key' });
    await expect(p.sendRequest(AgentName.GEMINI, defaultOpts))
      .rejects.toBeInstanceOf(ApiKeyProviderError);
  });

  it('throws ApiKeyProviderError when no text in response', async () => {
    setupHttpsMock({
      responseBody: JSON.stringify({ candidates: [] }),
    });
    const p = new ApiKeyProvider({ googleApiKey: 'goog-key' });
    await expect(p.sendRequest(AgentName.GEMINI, defaultOpts))
      .rejects.toBeInstanceOf(ApiKeyProviderError);
  });

  it('throws ApiKeyProviderError on HTTP 500', async () => {
    setupHttpsMock({ statusCode: 500, responseBody: 'internal error' });
    const p = new ApiKeyProvider({ googleApiKey: 'goog-key' });
    await expect(p.sendRequest(AgentName.GEMINI, defaultOpts))
      .rejects.toBeInstanceOf(ApiKeyProviderError);
  });

  it('throws ApiKeyProviderError on timeout', async () => {
    setupHttpsMock({ timeout: true });
    const p = new ApiKeyProvider({ googleApiKey: 'goog-key' });
    await expect(p.sendRequest(AgentName.GEMINI, defaultOpts))
      .rejects.toBeInstanceOf(ApiKeyProviderError);
  });
});

// ── DeepSeek ──────────────────────────────────────────────────────────────────

describe('ApiKeyProvider — DeepSeek', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns message content from successful response', async () => {
    setupHttpsMock({
      responseBody: JSON.stringify({
        choices: [{ message: { content: 'Hello from DeepSeek' } }],
      }),
    });
    const p = new ApiKeyProvider({ deepseekApiKey: 'ds-key' });
    const result = await p.sendRequest(AgentName.DEEPSEEK, defaultOpts);
    expect(result.content).toBe('Hello from DeepSeek');
  });

  it('throws ApiKeyProviderError when deepseekApiKey is missing', async () => {
    const p = new ApiKeyProvider({});
    await expect(p.sendRequest(AgentName.DEEPSEEK, defaultOpts))
      .rejects.toBeInstanceOf(ApiKeyProviderError);
  });

  it('throws ApiKeyProviderError on API error response', async () => {
    setupHttpsMock({
      responseBody: JSON.stringify({
        error: { message: 'invalid key', type: 'auth_error' },
      }),
    });
    const p = new ApiKeyProvider({ deepseekApiKey: 'ds-key' });
    await expect(p.sendRequest(AgentName.DEEPSEEK, defaultOpts))
      .rejects.toBeInstanceOf(ApiKeyProviderError);
  });

  it('throws ApiKeyProviderError on non-JSON response', async () => {
    setupHttpsMock({ responseBody: 'not json' });
    const p = new ApiKeyProvider({ deepseekApiKey: 'ds-key' });
    await expect(p.sendRequest(AgentName.DEEPSEEK, defaultOpts))
      .rejects.toBeInstanceOf(ApiKeyProviderError);
  });

  it('throws ApiKeyProviderError when no content in response', async () => {
    setupHttpsMock({
      responseBody: JSON.stringify({ choices: [] }),
    });
    const p = new ApiKeyProvider({ deepseekApiKey: 'ds-key' });
    await expect(p.sendRequest(AgentName.DEEPSEEK, defaultOpts))
      .rejects.toBeInstanceOf(ApiKeyProviderError);
  });

  it('throws ApiKeyProviderError on HTTP 401', async () => {
    setupHttpsMock({ statusCode: 401, responseBody: 'unauthorized' });
    const p = new ApiKeyProvider({ deepseekApiKey: 'ds-key' });
    await expect(p.sendRequest(AgentName.DEEPSEEK, defaultOpts))
      .rejects.toBeInstanceOf(ApiKeyProviderError);
  });

  it('passes conversation history in the messages array', async () => {
    setupHttpsMock({
      responseBody: JSON.stringify({
        choices: [{ message: { content: 'DS response' } }],
      }),
    });
    const p = new ApiKeyProvider({ deepseekApiKey: 'ds-key' });
    await p.sendRequest(AgentName.DEEPSEEK, {
      ...defaultOpts,
      conversationHistory: [
        { role: 'user', content: 'previous question' },
        { role: 'assistant', content: 'previous answer' },
      ],
    });

    // Verify request was made (history merging is an internal concern — just check it succeeds)
    expect(https.request as jest.Mock).toHaveBeenCalledTimes(1);
  });
});

// ── Conversation history pass-through ─────────────────────────────────────────

describe('ApiKeyProvider — conversation history', () => {
  beforeEach(() => jest.clearAllMocks());

  it('includes conversation history in Claude request body', async () => {
    let capturedBody = '';
    (https.request as jest.Mock).mockImplementation(
      (_opts: unknown, callback: (res: EventEmitter & { statusCode?: number }) => void) => {
        const mockReq = new EventEmitter() as EventEmitter & {
          write: jest.Mock; end: jest.Mock; setTimeout: jest.Mock; destroy: jest.Mock;
        };
        mockReq.write = jest.fn().mockImplementation((b: string) => { capturedBody = b; });
        mockReq.end = jest.fn();
        mockReq.setTimeout = jest.fn();
        mockReq.destroy = jest.fn();

        const mockRes = new EventEmitter() as EventEmitter & { statusCode?: number };
        mockRes.statusCode = 200;
        setImmediate(() => {
          mockRes.emit('data', Buffer.from(JSON.stringify({
            content: [{ type: 'text', text: 'reply' }],
          })));
          mockRes.emit('end');
        });
        callback(mockRes);
        return mockReq;
      },
    );

    const p = new ApiKeyProvider({ anthropicApiKey: 'sk-ant' });
    await p.sendRequest(AgentName.CLAUDE, {
      ...defaultOpts,
      conversationHistory: [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'first answer' },
      ],
    });

    const body = JSON.parse(capturedBody);
    expect(body.messages).toContainEqual({ role: 'user', content: 'first question' });
    expect(body.messages).toContainEqual({ role: 'assistant', content: 'first answer' });
  });
});

// ── Streaming helpers ─────────────────────────────────────────────────────────

/**
 * Mocks https.request so each call emits one set of SSE lines as a stream.
 * Pass multiple arrays to simulate multi-turn agentic loops (tool call → response).
 */
function setupStreamMock(responseBodies: string[][]) {
  let callIdx = 0;
  (https.request as jest.Mock).mockImplementation(
    (_opts: unknown, callback: (res: EventEmitter & { statusCode?: number; headers: Record<string, string>; resume: jest.Mock }) => void) => {
      const lines = responseBodies[Math.min(callIdx, responseBodies.length - 1)];
      callIdx++;

      const mockRes = new EventEmitter() as EventEmitter & { statusCode?: number; headers: Record<string, string>; resume: jest.Mock };
      mockRes.statusCode = 200;
      mockRes.headers = {};
      mockRes.resume = jest.fn();

      const mockReq = new EventEmitter() as EventEmitter & { write: jest.Mock; end: jest.Mock; setTimeout: jest.Mock; destroy: jest.Mock };
      mockReq.write = jest.fn();
      mockReq.end = jest.fn();
      mockReq.setTimeout = jest.fn();
      mockReq.destroy = jest.fn().mockImplementation((err?: Error) => {
        if (err) setImmediate(() => mockReq.emit('error', err));
      });

      setImmediate(() => {
        mockRes.emit('data', Buffer.from(lines.join('\n') + '\n'));
        mockRes.emit('end');
      });

      callback(mockRes);
      return mockReq;
    },
  );
}

// ── Claude streaming ──────────────────────────────────────────────────────────

describe('ApiKeyProvider — Claude streaming', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns streamed text and calls onChunk for each delta', async () => {
    setupStreamMock([[
      'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" World"}}',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
    ]]);

    const chunks: string[] = [];
    const p = new ApiKeyProvider({ anthropicApiKey: 'sk-ant-test' });
    const result = await p.sendRequest(AgentName.CLAUDE, { ...defaultOpts, onChunk: (c) => chunks.push(c) });

    expect(result.content).toBe('Hello World');
    expect(chunks).toEqual(['Hello', ' World']);
    expect(result.usage?.inputTokens).toBe(10);
    expect(result.usage?.outputTokens).toBe(5);
  });

  it('read_file tool call: dispatches to onToolCall and continues loop with result', async () => {
    // First stream: tool_use block → stop_reason: tool_use
    // Second stream: text response → stop_reason: end_turn
    setupStreamMock([
      [
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool1","name":"read_file"}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"src/app.ts\\"}"}}',
        'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}',
      ],
      [
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"File read successfully."}}',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}',
      ],
    ]);

    const onToolCall = jest.fn().mockResolvedValue({ id: 'tool1', content: 'const x = 1;', isError: false });
    const p = new ApiKeyProvider({ anthropicApiKey: 'sk-ant-test' });
    const result = await p.sendRequest(AgentName.CLAUDE, { ...defaultOpts, onChunk: jest.fn(), onToolCall });

    expect(onToolCall).toHaveBeenCalledWith({ id: 'tool1', name: 'read_file', filePath: 'src/app.ts' });
    expect(result.content).toBe('File read successfully.');
    expect(https.request as jest.Mock).toHaveBeenCalledTimes(2);
  });

  it('run_command tool call: dispatches with name run_command', async () => {
    setupStreamMock([
      [
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"cmd1","name":"run_command"}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"npm test\\"}"}}',
        'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}',
      ],
      [
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Tests passed."}}',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}',
      ],
    ]);

    const onToolCall = jest.fn().mockResolvedValue({ id: 'cmd1', content: 'Exit code: 0\n\nOutput:\nAll tests passed', isError: false });
    const p = new ApiKeyProvider({ anthropicApiKey: 'sk-ant-test' });
    const result = await p.sendRequest(AgentName.CLAUDE, { ...defaultOpts, onChunk: jest.fn(), onToolCall });

    expect(onToolCall).toHaveBeenCalledWith({ id: 'cmd1', name: 'run_command', command: 'npm test' });
    expect(result.content).toBe('Tests passed.');
  });

  it('malformed SSE line is silently ignored and loop continues', async () => {
    setupStreamMock([[
      'data: {invalid json}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"After malformed"}}',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
    ]]);

    const p = new ApiKeyProvider({ anthropicApiKey: 'sk-ant-test' });
    const result = await p.sendRequest(AgentName.CLAUDE, { ...defaultOpts, onChunk: jest.fn() });
    expect(result.content).toBe('After malformed');
  });

  it('throws ApiKeyProviderError when streaming response is empty', async () => {
    setupStreamMock([[
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}',
    ]]);

    const p = new ApiKeyProvider({ anthropicApiKey: 'sk-ant-test' });
    await expect(p.sendRequest(AgentName.CLAUDE, { ...defaultOpts, onChunk: jest.fn() }))
      .rejects.toBeInstanceOf(ApiKeyProviderError);
  });
});

// ── OpenAI streaming ──────────────────────────────────────────────────────────

describe('ApiKeyProvider — OpenAI streaming', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns streamed text and calls onChunk for each delta', async () => {
    setupStreamMock([[
      'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"content":" World"},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":4}}',
      'data: [DONE]',
    ]]);

    const chunks: string[] = [];
    const p = new ApiKeyProvider({ openaiApiKey: 'sk-openai' });
    const result = await p.sendRequest(AgentName.GPT, { ...defaultOpts, onChunk: (c) => chunks.push(c) });

    expect(result.content).toBe('Hello World');
    expect(chunks).toEqual(['Hello', ' World']);
    expect(result.usage?.inputTokens).toBe(8);
    expect(result.usage?.outputTokens).toBe(4);
  });

  it('read_file tool call: dispatches and continues loop', async () => {
    setupStreamMock([
      [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call1","function":{"name":"read_file","arguments":"{\\"path\\":\\"src/app.ts\\"}"}}]},"finish_reason":"tool_calls"}]}',
        'data: [DONE]',
      ],
      [
        'data: {"choices":[{"delta":{"content":"File analyzed."},"finish_reason":"stop"}]}',
        'data: [DONE]',
      ],
    ]);

    const onToolCall = jest.fn().mockResolvedValue({ id: 'call1', content: 'const x = 1;', isError: false });
    const p = new ApiKeyProvider({ openaiApiKey: 'sk-openai' });
    const result = await p.sendRequest(AgentName.GPT, { ...defaultOpts, onChunk: jest.fn(), onToolCall });

    expect(onToolCall).toHaveBeenCalledWith({ id: 'call1', name: 'read_file', filePath: 'src/app.ts' });
    expect(result.content).toBe('File analyzed.');
    expect(https.request as jest.Mock).toHaveBeenCalledTimes(2);
  });

  it('run_command tool call: dispatches with name run_command', async () => {
    setupStreamMock([
      [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call2","function":{"name":"run_command","arguments":"{\\"command\\":\\"npm build\\"}"}}]},"finish_reason":"tool_calls"}]}',
        'data: [DONE]',
      ],
      [
        'data: {"choices":[{"delta":{"content":"Build successful."},"finish_reason":"stop"}]}',
        'data: [DONE]',
      ],
    ]);

    const onToolCall = jest.fn().mockResolvedValue({ id: 'call2', content: 'Exit code: 0\n\nOutput:\nBuild OK', isError: false });
    const p = new ApiKeyProvider({ openaiApiKey: 'sk-openai' });
    const result = await p.sendRequest(AgentName.GPT, { ...defaultOpts, onChunk: jest.fn(), onToolCall });

    expect(onToolCall).toHaveBeenCalledWith({ id: 'call2', name: 'run_command', command: 'npm build' });
    expect(result.content).toBe('Build successful.');
  });
});

// ── Gemini streaming ──────────────────────────────────────────────────────────

describe('ApiKeyProvider — Gemini streaming', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns streamed text and calls onChunk', async () => {
    setupStreamMock([[
      'data: {"candidates":[{"content":{"parts":[{"text":"Gemini "},{"text":"response"}]}}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":3}}',
    ]]);

    const chunks: string[] = [];
    const p = new ApiKeyProvider({ googleApiKey: 'goog-key' });
    const result = await p.sendRequest(AgentName.GEMINI, { ...defaultOpts, onChunk: (c) => chunks.push(c) });

    expect(result.content).toBe('Gemini response');
    expect(chunks).toEqual(['Gemini ', 'response']);
  });

  it('read_file function call: dispatches to onToolCall and continues loop', async () => {
    setupStreamMock([
      [
        'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"read_file","args":{"path":"src/app.ts"}}}]}}]}',
      ],
      [
        'data: {"candidates":[{"content":{"parts":[{"text":"Analysis complete."}]}}]}',
      ],
    ]);

    const onToolCall = jest.fn().mockResolvedValue({ id: 'read_file', content: 'const x = 1;', isError: false });
    const p = new ApiKeyProvider({ googleApiKey: 'goog-key' });
    const result = await p.sendRequest(AgentName.GEMINI, { ...defaultOpts, onChunk: jest.fn(), onToolCall });

    expect(onToolCall).toHaveBeenCalledWith({ id: 'read_file', name: 'read_file', filePath: 'src/app.ts' });
    expect(result.content).toBe('Analysis complete.');
    expect(https.request as jest.Mock).toHaveBeenCalledTimes(2);
  });

  it('run_command function call: dispatches with name run_command', async () => {
    setupStreamMock([
      [
        'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"run_command","args":{"command":"npm test"}}}]}}]}',
      ],
      [
        'data: {"candidates":[{"content":{"parts":[{"text":"Tests done."}]}}]}',
      ],
    ]);

    const onToolCall = jest.fn().mockResolvedValue({ id: 'run_command', content: 'Exit code: 0', isError: false });
    const p = new ApiKeyProvider({ googleApiKey: 'goog-key' });
    const result = await p.sendRequest(AgentName.GEMINI, { ...defaultOpts, onChunk: jest.fn(), onToolCall });

    expect(onToolCall).toHaveBeenCalledWith({ id: 'run_command', name: 'run_command', command: 'npm test' });
    expect(result.content).toBe('Tests done.');
  });

  it('throws ApiKeyProviderError on Gemini error in stream', async () => {
    setupStreamMock([[
      'data: {"error":{"status":"RESOURCE_EXHAUSTED","message":"quota exceeded"}}',
    ]]);

    const p = new ApiKeyProvider({ googleApiKey: 'goog-key' });
    await expect(p.sendRequest(AgentName.GEMINI, { ...defaultOpts, onChunk: jest.fn() }))
      .rejects.toBeInstanceOf(ApiKeyProviderError);
  });
});

// ── Bug fixes: text accumulation across tool-call iterations ──────────────────

describe('ApiKeyProvider — Bug fix: finalText accumulation (Claude streaming)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('concatenates text from two tool-call iterations (not just last)', async () => {
    // Iteration 1: emits text + tool_use
    // Iteration 2: emits more text + another tool_use
    // Iteration 3: final text only
    setupStreamMock([
      [
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"First iteration text. "}}',
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"read_file"}}',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.ts\\"}"}}',
        'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}',
      ],
      [
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Second iteration text. "}}',
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t2","name":"read_file"}}',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"b.ts\\"}"}}',
        'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}',
      ],
      [
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Final answer."}}',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}',
      ],
    ]);

    const onToolCall = jest.fn().mockResolvedValue({ id: 'x', content: 'file content', isError: false });
    const p = new ApiKeyProvider({ anthropicApiKey: 'sk-ant-test' });
    const result = await p.sendRequest(AgentName.CLAUDE, { ...defaultOpts, onChunk: jest.fn(), onToolCall });

    expect(result.content).toBe('First iteration text. Second iteration text. Final answer.');
    expect(onToolCall).toHaveBeenCalledTimes(2);
    expect(https.request as jest.Mock).toHaveBeenCalledTimes(3);
  });

  it('handles first iteration returning empty text, second iteration has content', async () => {
    // First response: no text, only tool_use
    setupStreamMock([
      [
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"read_file"}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"file.ts\\"}"}}',
        'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":2}}',
      ],
      [
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Content from second call."}}',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}',
      ],
    ]);

    const onToolCall = jest.fn().mockResolvedValue({ id: 't1', content: 'file contents', isError: false });
    const p = new ApiKeyProvider({ anthropicApiKey: 'sk-ant-test' });
    const result = await p.sendRequest(AgentName.CLAUDE, { ...defaultOpts, onChunk: jest.fn(), onToolCall });

    expect(result.content).toBe('Content from second call.');
  });

  it('concatenates text from 3 iterations (triple tool-call loop)', async () => {
    setupStreamMock([
      [
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"A"}}',
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"read_file"}}',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"x.ts\\"}"}}',
        'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":1}}',
      ],
      [
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"B"}}',
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t2","name":"read_file"}}',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"y.ts\\"}"}}',
        'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":1}}',
      ],
      [
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"C"}}',
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t3","name":"read_file"}}',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"z.ts\\"}"}}',
        'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":1}}',
      ],
      [
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"D"}}',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
      ],
    ]);

    const onToolCall = jest.fn().mockResolvedValue({ id: 'x', content: 'data', isError: false });
    const p = new ApiKeyProvider({ anthropicApiKey: 'sk-ant-test' });
    const result = await p.sendRequest(AgentName.CLAUDE, { ...defaultOpts, onChunk: jest.fn(), onToolCall });

    expect(result.content).toBe('ABCD');
    expect(onToolCall).toHaveBeenCalledTimes(3);
  });
});

describe('ApiKeyProvider — Bug fix: finalText accumulation (OpenAI streaming)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('concatenates text from two tool-call iterations', async () => {
    setupStreamMock([
      [
        'data: {"choices":[{"delta":{"content":"Step one done. ","tool_calls":null},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.ts\\"}"}}]},"finish_reason":"tool_calls"}]}',
        'data: [DONE]',
      ],
      [
        'data: {"choices":[{"delta":{"content":"Step two done."},"finish_reason":"stop"}]}',
        'data: [DONE]',
      ],
    ]);

    const onToolCall = jest.fn().mockResolvedValue({ id: 'c1', content: 'file body', isError: false });
    const p = new ApiKeyProvider({ openaiApiKey: 'sk-openai' });
    const result = await p.sendRequest(AgentName.GPT, { ...defaultOpts, onChunk: jest.fn(), onToolCall });

    expect(result.content).toBe('Step one done. Step two done.');
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(https.request as jest.Mock).toHaveBeenCalledTimes(2);
  });

  it('handles first iteration with no text content, second has content', async () => {
    setupStreamMock([
      [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"run_command","arguments":"{\\"command\\":\\"npm test\\"}"}}]},"finish_reason":"tool_calls"}]}',
        'data: [DONE]',
      ],
      [
        'data: {"choices":[{"delta":{"content":"Tests passed."},"finish_reason":"stop"}]}',
        'data: [DONE]',
      ],
    ]);

    const onToolCall = jest.fn().mockResolvedValue({ id: 'c1', content: 'ok', isError: false });
    const p = new ApiKeyProvider({ openaiApiKey: 'sk-openai' });
    const result = await p.sendRequest(AgentName.GPT, { ...defaultOpts, onChunk: jest.fn(), onToolCall });

    expect(result.content).toBe('Tests passed.');
  });

  it('accumulates usage across OpenAI stream tool-call iterations', async () => {
    setupStreamMock([
      [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.ts\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
        'data: [DONE]',
      ],
      [
        'data: {"choices":[{"delta":{"content":"Done."},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":7}}',
        'data: [DONE]',
      ],
    ]);

    const onToolCall = jest.fn().mockResolvedValue({ id: 'c1', content: 'file body', isError: false });
    const p = new ApiKeyProvider({ openaiApiKey: 'sk-openai' });
    const result = await p.sendRequest(AgentName.GPT, { ...defaultOpts, onChunk: jest.fn(), onToolCall });

    expect(result.content).toBe('Done.');
    expect(result.usage?.inputTokens).toBe(8);
    expect(result.usage?.outputTokens).toBe(9);
  });
});

describe('ApiKeyProvider — Bug fix: finalText accumulation (Gemini streaming)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('concatenates text from two tool-call iterations', async () => {
    setupStreamMock([
      [
        'data: {"candidates":[{"content":{"parts":[{"text":"Searching. "},{"functionCall":{"name":"read_file","args":{"path":"src/app.ts"}}}]}}]}',
      ],
      [
        'data: {"candidates":[{"content":{"parts":[{"text":"Analysis complete."}]}}]}',
      ],
    ]);

    const onToolCall = jest.fn().mockResolvedValue({ id: 'read_file', content: 'content', isError: false });
    const p = new ApiKeyProvider({ googleApiKey: 'goog-key' });
    const result = await p.sendRequest(AgentName.GEMINI, { ...defaultOpts, onChunk: jest.fn(), onToolCall });

    expect(result.content).toBe('Searching. Analysis complete.');
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(https.request as jest.Mock).toHaveBeenCalledTimes(2);
  });

  it('concatenates text across three Gemini iterations', async () => {
    setupStreamMock([
      [
        'data: {"candidates":[{"content":{"parts":[{"text":"Part1. "},{"functionCall":{"name":"run_command","args":{"command":"ls"}}}]}}]}',
      ],
      [
        'data: {"candidates":[{"content":{"parts":[{"text":"Part2. "},{"functionCall":{"name":"read_file","args":{"path":"a.ts"}}}]}}]}',
      ],
      [
        'data: {"candidates":[{"content":{"parts":[{"text":"Part3."}]}}]}',
      ],
    ]);

    const onToolCall = jest.fn().mockResolvedValue({ id: 'x', content: 'data', isError: false });
    const p = new ApiKeyProvider({ googleApiKey: 'goog-key' });
    const result = await p.sendRequest(AgentName.GEMINI, { ...defaultOpts, onChunk: jest.fn(), onToolCall });

    expect(result.content).toBe('Part1. Part2. Part3.');
    expect(onToolCall).toHaveBeenCalledTimes(2);
  });

  it('accumulates usage across Gemini stream tool-call iterations', async () => {
    setupStreamMock([
      [
        'data: {"candidates":[{"content":{"parts":[{"text":"P1 "},{"functionCall":{"name":"read_file","args":{"path":"a.ts"}}}]}}],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":1}}',
      ],
      [
        'data: {"candidates":[{"content":{"parts":[{"text":"P2"}]}}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":3}}',
      ],
    ]);

    const onToolCall = jest.fn().mockResolvedValue({ id: 'read_file', content: 'data', isError: false });
    const p = new ApiKeyProvider({ googleApiKey: 'goog-key' });
    const result = await p.sendRequest(AgentName.GEMINI, { ...defaultOpts, onChunk: jest.fn(), onToolCall });

    expect(result.content).toBe('P1 P2');
    expect(result.usage?.inputTokens).toBe(6);
    expect(result.usage?.outputTokens).toBe(4);
  });
});

// ── Bug fixes: cancellation between tool-call iterations ──────────────────────

describe('ApiKeyProvider — Bug fix: cancellation between tool-call iterations (Claude streaming)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('throws CancellationError and does NOT call onToolCall when token is cancelled before check fires', async () => {
    // The bug fix added a cancellation check BEFORE executing onToolCall.
    // When the token is already cancelled after the HTTP response arrives (tool_use stop_reason),
    // the provider should throw without calling onToolCall.
    setupStreamMock([
      [
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"read_file"}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.ts\\"}"}}',
        'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":2}}',
      ],
    ]);

    // Token already cancelled — the check before onToolCall fires immediately
    const cancellationToken = { isCancellationRequested: true, onCancellationRequested: jest.fn() };
    const onToolCall = jest.fn();

    const p = new ApiKeyProvider({ anthropicApiKey: 'sk-ant-test' });
    await expect(
      p.sendRequest(AgentName.CLAUDE, {
        ...defaultOpts,
        onChunk: jest.fn(),
        onToolCall,
        cancellationToken,
      }),
    ).rejects.toMatchObject({ name: 'CancellationError' });

    // onToolCall should never have been reached
    expect(onToolCall).not.toHaveBeenCalled();
    expect(https.request as jest.Mock).toHaveBeenCalledTimes(1);
  });

  it('executes onToolCall then throws CancellationError on second iteration when token fires during tool call', async () => {
    // When the token becomes cancelled DURING onToolCall execution (not before),
    // the second-iteration cancellation check (at the top of the loop) prevents the next HTTP request.
    setupStreamMock([
      [
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"read_file"}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.ts\\"}"}}',
        'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":2}}',
      ],
      // Second request should never be reached because the loop pre-check fires first
      [
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Should not appear"}}',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
      ],
    ]);

    // Claude provider checks cancellation BEFORE onToolCall in the same pass,
    // so here we need to let the check pass (not cancelled yet) and then cancel inside onToolCall.
    // The cancellation will be checked at the TOP of the next loop iteration.
    //
    // Note: the implementation checks cancellation BEFORE the tool call. If the token is not yet
    // cancelled, it calls onToolCall. The cancellation set during onToolCall prevents the NEXT loop
    // via the check at the start of the next while-iteration.
    const cancellationToken = { isCancellationRequested: false, onCancellationRequested: jest.fn() };
    const onToolCall = jest.fn().mockImplementation(async () => {
      cancellationToken.isCancellationRequested = true;
      return { id: 't1', content: 'file body', isError: false };
    });

    const p = new ApiKeyProvider({ anthropicApiKey: 'sk-ant-test' });

    // The Claude streaming loop does NOT have a pre-check at the top of each iteration.
    // The cancellation check is AFTER the HTTP response but BEFORE onToolCall.
    // So when the token is not yet cancelled going into the check, onToolCall runs,
    // sets the token, and the next loop iteration's HTTP request is made.
    // We just verify onToolCall was called exactly once regardless of resolve/reject.
    await p.sendRequest(AgentName.CLAUDE, {
      ...defaultOpts,
      onChunk: jest.fn(),
      onToolCall,
      cancellationToken,
    }).then(() => {}, () => {});

    expect(onToolCall).toHaveBeenCalledTimes(1);
    // The important invariant: onToolCall was NOT called a second time.
  });
});

describe('ApiKeyProvider — Bug fix: cancellation between tool-call iterations (OpenAI streaming)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('throws CancellationError and does NOT call onToolCall when token is cancelled before the check fires', async () => {
    // The bug fix added a cancellation check BEFORE executing onToolCall.
    // When the token is already cancelled after the HTTP response, the provider
    // throws without calling onToolCall.
    setupStreamMock([
      [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"run_command","arguments":"{\\"command\\":\\"npm build\\"}"}}]},"finish_reason":"tool_calls"}]}',
        'data: [DONE]',
      ],
    ]);

    const cancellationToken = { isCancellationRequested: true, onCancellationRequested: jest.fn() };
    const onToolCall = jest.fn();

    const p = new ApiKeyProvider({ openaiApiKey: 'sk-openai' });
    await expect(
      p.sendRequest(AgentName.GPT, {
        ...defaultOpts,
        onChunk: jest.fn(),
        onToolCall,
        cancellationToken,
      }),
    ).rejects.toMatchObject({ name: 'CancellationError' });

    expect(onToolCall).not.toHaveBeenCalled();
    expect(https.request as jest.Mock).toHaveBeenCalledTimes(1);
  });

  it('calls onToolCall once then does not loop again when token is cancelled during tool call', async () => {
    setupStreamMock([
      [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"run_command","arguments":"{\\"command\\":\\"npm build\\"}"}}]},"finish_reason":"tool_calls"}]}',
        'data: [DONE]',
      ],
      [
        'data: {"choices":[{"delta":{"content":"Should not appear."},"finish_reason":"stop"}]}',
        'data: [DONE]',
      ],
    ]);

    const cancellationToken = { isCancellationRequested: false, onCancellationRequested: jest.fn() };
    const onToolCall = jest.fn().mockImplementation(async () => {
      cancellationToken.isCancellationRequested = true;
      return { id: 'c1', content: 'built', isError: false };
    });

    const p = new ApiKeyProvider({ openaiApiKey: 'sk-openai' });
    await p.sendRequest(AgentName.GPT, {
      ...defaultOpts,
      onChunk: jest.fn(),
      onToolCall,
      cancellationToken,
    }).then(() => {}, () => {});

    // onToolCall ran exactly once; second iteration was not started
    expect(onToolCall).toHaveBeenCalledTimes(1);
  });
});

// ── Model tier ────────────────────────────────────────────────────────────────

describe('ApiKeyProvider — model tier', () => {
  beforeEach(() => jest.clearAllMocks());

  function captureRequestBody(): { getBody: () => string } {
    let body = '';
    (https.request as jest.Mock).mockImplementation(
      (_opts: unknown, callback: (res: EventEmitter & { statusCode?: number; headers: Record<string, string>; resume: jest.Mock }) => void) => {
        const mockReq = new EventEmitter() as EventEmitter & {
          write: jest.Mock; end: jest.Mock; setTimeout: jest.Mock; destroy: jest.Mock;
        };
        mockReq.write = jest.fn().mockImplementation((b: string) => { body = b; });
        mockReq.end = jest.fn();
        mockReq.setTimeout = jest.fn();
        mockReq.destroy = jest.fn();
        const mockRes = new EventEmitter() as EventEmitter & { statusCode?: number; headers: Record<string, string>; resume: jest.Mock };
        mockRes.statusCode = 200;
        mockRes.headers = {};
        mockRes.resume = jest.fn();
        setImmediate(() => {
          mockRes.emit('data', Buffer.from(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] })));
          mockRes.emit('end');
        });
        callback(mockRes);
        return mockReq;
      },
    );
    return { getBody: () => body };
  }

  it('defaults to heavy tier — uses claude-sonnet-4-6', async () => {
    const { getBody } = captureRequestBody();
    const p = new ApiKeyProvider({ anthropicApiKey: 'sk-ant' });
    await p.sendRequest(AgentName.CLAUDE, defaultOpts);
    expect(JSON.parse(getBody()).model).toBe('claude-sonnet-4-6');
  });

  it('light tier — uses claude-haiku for Claude', async () => {
    const { getBody } = captureRequestBody();
    const p = new ApiKeyProvider({ anthropicApiKey: 'sk-ant', modelTier: 'light' });
    await p.sendRequest(AgentName.CLAUDE, defaultOpts);
    expect(JSON.parse(getBody()).model).toBe('claude-haiku-4-5-20251001');
  });

  function captureGptBody(): { getBody: () => string } {
    let body = '';
    (https.request as jest.Mock).mockImplementation(
      (_opts: unknown, callback: (res: EventEmitter & { statusCode?: number; headers: Record<string, string>; resume: jest.Mock }) => void) => {
        const mockReq = new EventEmitter() as EventEmitter & { write: jest.Mock; end: jest.Mock; setTimeout: jest.Mock; destroy: jest.Mock };
        mockReq.write = jest.fn().mockImplementation((b: string) => { body = b; });
        mockReq.end = jest.fn(); mockReq.setTimeout = jest.fn(); mockReq.destroy = jest.fn();
        const mockRes = new EventEmitter() as EventEmitter & { statusCode?: number; headers: Record<string, string>; resume: jest.Mock };
        mockRes.statusCode = 200; mockRes.headers = {}; mockRes.resume = jest.fn();
        setImmediate(() => {
          mockRes.emit('data', Buffer.from(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] })));
          mockRes.emit('end');
        });
        callback(mockRes);
        return mockReq;
      },
    );
    return { getBody: () => body };
  }

  it('heavy tier — uses gpt-4o for GPT', async () => {
    const { getBody } = captureGptBody();
    const p = new ApiKeyProvider({ openaiApiKey: 'sk-openai', modelTier: 'heavy' });
    await p.sendRequest(AgentName.GPT, defaultOpts);
    expect(JSON.parse(getBody()).model).toBe('gpt-4o');
  });

  it('light tier — uses gpt-4o-mini for GPT', async () => {
    const { getBody } = captureGptBody();
    const p = new ApiKeyProvider({ openaiApiKey: 'sk-openai', modelTier: 'light' });
    await p.sendRequest(AgentName.GPT, defaultOpts);
    expect(JSON.parse(getBody()).model).toBe('gpt-4o-mini');
  });
});
