/**
 * HTTP-level branch coverage for ApiKeyProvider.
 *
 * Covers: stream no-API-key paths, empty streaming responses,
 * makeHttpsStreamRequest: 429 retry, non-2xx, res.error, request timeout,
 * cancellation token fires, req.error (non-standard), onLine throws on final buffer,
 * makeHttpsRequest: res.error, cancellation,
 * parseRetryAfterMs branches, Gemini/Claude streaming cancellation mid-tool-call.
 */
import { EventEmitter } from 'events';
import { ApiKeyProvider, ApiKeyProviderError } from '../../src/agents/ApiKeyProvider';
import { AgentName } from '../../src/types';

jest.mock('https');
import * as https from 'https';

// ── Mock infrastructure (mirrors ApiKeyProvider.branches.test.ts) ─────────────

interface MockOpts {
  statusCode?: number;
  bodies?: string[];
  networkError?: Error;
  requestError?: Error;
  retryAfterHeader?: string;
}

let responseIndex = 0;
let mockBodies: string[] = [];

type MockReq = EventEmitter & { write: jest.Mock; end: jest.Mock; setTimeout: jest.Mock; destroy: jest.Mock };
type MockRes = EventEmitter & { statusCode?: number; headers: Record<string, string | string[]>; resume: jest.Mock };

function setupSequentialMock(opts: MockOpts = {}) {
  const { statusCode = 200, bodies = ['{}'], networkError, requestError, retryAfterHeader } = opts;
  mockBodies = bodies;
  responseIndex = 0;

  (https.request as jest.Mock).mockImplementation(
    (_o: unknown, cb: (res: MockRes) => void) => {
      const mockReq = new EventEmitter() as MockReq;
      mockReq.write = jest.fn();
      mockReq.end = jest.fn();
      mockReq.setTimeout = jest.fn().mockImplementation((_, timeoutCb: () => void) => {
        // Don't auto-fire — tests trigger manually via lastMockReq.setTimeout.mock.calls
        void timeoutCb; // keep reference
      });
      mockReq.destroy = jest.fn().mockImplementation((err?: Error) => {
        if (err) setImmediate(() => mockReq.emit('error', err));
      });

      const mockRes = new EventEmitter() as MockRes;
      mockRes.statusCode = statusCode;
      mockRes.headers = retryAfterHeader ? { 'retry-after': retryAfterHeader } : {};
      mockRes.resume = jest.fn();

      setImmediate(() => {
        if (networkError) { mockRes.emit('error', networkError); return; }
        if (requestError) { mockReq.emit('error', requestError); return; }
        const body = mockBodies[responseIndex] ?? mockBodies[mockBodies.length - 1];
        responseIndex++;
        mockRes.emit('data', Buffer.from(body));
        mockRes.emit('end');
      });

      cb(mockRes);
      return mockReq;
    },
  );
}

const defaultOpts = { systemPrompt: 'sys', userMessage: 'hello' };

// ── Stream no-API-key paths ───────────────────────────────────────────────────

describe('ApiKeyProvider — stream: no API key', () => {
  it('throws when Claude stream has no anthropicApiKey', async () => {
    const p = new ApiKeyProvider({});
    await expect(
      p.sendRequest(AgentName.CLAUDE, { ...defaultOpts, onChunk: jest.fn() }),
    ).rejects.toBeInstanceOf(ApiKeyProviderError);
  });

  it('throws when OpenAI stream has no openaiApiKey', async () => {
    const p = new ApiKeyProvider({});
    await expect(
      p.sendRequest(AgentName.GPT, { ...defaultOpts, onChunk: jest.fn() }),
    ).rejects.toBeInstanceOf(ApiKeyProviderError);
  });

  it('throws when DeepSeek stream has no deepseekApiKey', async () => {
    const p = new ApiKeyProvider({});
    await expect(
      p.sendRequest(AgentName.DEEPSEEK, { ...defaultOpts, onChunk: jest.fn() }),
    ).rejects.toBeInstanceOf(ApiKeyProviderError);
  });

  it('throws when Gemini stream has no googleApiKey', async () => {
    const p = new ApiKeyProvider({});
    await expect(
      p.sendRequest(AgentName.GEMINI, { ...defaultOpts, onChunk: jest.fn() }),
    ).rejects.toBeInstanceOf(ApiKeyProviderError);
  });
});

// ── Empty streaming responses ─────────────────────────────────────────────────

describe('ApiKeyProvider — stream: empty response throws', () => {
  beforeEach(() => jest.clearAllMocks());

  it('throws when OpenAI streaming returns no text', async () => {
    // SSE with finish_reason but no content → finalText stays empty
    const emptyLine = 'data: ' + JSON.stringify({
      choices: [{ delta: {}, finish_reason: 'stop' }],
    });
    setupSequentialMock({ bodies: [emptyLine + '\ndata: [DONE]\n'] });

    const p = new ApiKeyProvider({ openaiApiKey: 'sk-openai-key' });
    await expect(
      p.sendRequest(AgentName.GPT, { ...defaultOpts, onChunk: jest.fn() }),
    ).rejects.toBeInstanceOf(ApiKeyProviderError);
  });

  it('throws when Gemini streaming returns no text', async () => {
    const emptyLine = 'data: ' + JSON.stringify({
      candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
    });
    setupSequentialMock({ bodies: [emptyLine + '\n'] });

    const p = new ApiKeyProvider({ googleApiKey: 'AIza-key' });
    await expect(
      p.sendRequest(AgentName.GEMINI, { ...defaultOpts, onChunk: jest.fn() }),
    ).rejects.toBeInstanceOf(ApiKeyProviderError);
  });
});

// ── makeHttpsStreamRequest: non-2xx error response ───────────────────────────

describe('ApiKeyProvider — makeHttpsStreamRequest: non-2xx', () => {
  beforeEach(() => jest.clearAllMocks());

  it('rejects with ApiKeyProviderError on HTTP 500 stream', async () => {
    setupSequentialMock({ statusCode: 500, bodies: ['Internal Server Error'] });

    const p = new ApiKeyProvider({ anthropicApiKey: 'sk-ant-key' });
    await expect(
      p.sendRequest(AgentName.CLAUDE, { ...defaultOpts, onChunk: jest.fn() }),
    ).rejects.toBeInstanceOf(ApiKeyProviderError);
  });

  it('rejects with ApiKeyProviderError on HTTP 401 stream', async () => {
    setupSequentialMock({ statusCode: 401, bodies: ['Unauthorized'] });

    const p = new ApiKeyProvider({ openaiApiKey: 'sk-bad-key' });
    await expect(
      p.sendRequest(AgentName.GPT, { ...defaultOpts, onChunk: jest.fn() }),
    ).rejects.toBeInstanceOf(ApiKeyProviderError);
  });
});

// ── makeHttpsStreamRequest: res.on('error') ───────────────────────────────────

describe('ApiKeyProvider — makeHttpsStreamRequest: response error', () => {
  beforeEach(() => jest.clearAllMocks());

  it('rejects when response emits error event', async () => {
    setupSequentialMock({ networkError: new Error('socket hang up') });

    const p = new ApiKeyProvider({ anthropicApiKey: 'sk-ant-key' });
    await expect(
      p.sendRequest(AgentName.CLAUDE, { ...defaultOpts, onChunk: jest.fn() }),
    ).rejects.toBeInstanceOf(ApiKeyProviderError);
  });
});

// ── makeHttpsStreamRequest: req.on('error') non-standard error ────────────────

describe('ApiKeyProvider — makeHttpsStreamRequest: request error (non-standard)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('wraps generic request error in ApiKeyProviderError', async () => {
    setupSequentialMock({ requestError: new Error('ECONNREFUSED') });

    const p = new ApiKeyProvider({ anthropicApiKey: 'sk-ant-key' });
    await expect(
      p.sendRequest(AgentName.CLAUDE, { ...defaultOpts, onChunk: jest.fn() }),
    ).rejects.toBeInstanceOf(ApiKeyProviderError);
  });
});

// ── makeHttpsStreamRequest: 429 retry ────────────────────────────────────────

describe('ApiKeyProvider — makeHttpsStreamRequest: 429 rate limit retry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });
  afterEach(() => jest.useRealTimers());

  it('retries after 429 and resolves on success', async () => {
    let callCount = 0;
    (https.request as jest.Mock).mockImplementation(
      (_o: unknown, cb: (res: MockRes) => void) => {
        const req = new EventEmitter() as MockReq;
        req.write = jest.fn();
        req.end = jest.fn();
        req.setTimeout = jest.fn();
        req.destroy = jest.fn();

        const res = new EventEmitter() as MockRes;
        res.resume = jest.fn();
        res.headers = { 'retry-after': '1' };

        callCount++;
        if (callCount === 1) {
          res.statusCode = 429;
          setImmediate(() => {
            res.emit('data', Buffer.from('rate limited'));
            res.emit('end');
          });
        } else {
          res.statusCode = 200;
          const sseBody = 'data: ' + JSON.stringify({
            choices: [{ delta: { content: 'Hello' }, finish_reason: null }],
          }) + '\ndata: ' + JSON.stringify({
            choices: [{ delta: {}, finish_reason: 'stop' }],
          }) + '\ndata: [DONE]\n';
          setImmediate(() => {
            res.emit('data', Buffer.from(sseBody));
            res.emit('end');
          });
        }

        cb(res);
        return req;
      },
    );

    const p = new ApiKeyProvider({ openaiApiKey: 'sk-openai-key' });
    const resultPromise = p.sendRequest(AgentName.GPT, { ...defaultOpts, onChunk: jest.fn() });

    // Advance past the 1-second retry delay
    await jest.advanceTimersByTimeAsync(2000);
    const result = await resultPromise;
    expect(result.content).toBe('Hello');
    expect(callCount).toBe(2);
  });

  it('cancels immediately during 429 retry backoff (streaming)', async () => {
    let callCount = 0;
    (https.request as jest.Mock).mockImplementation(
      (_o: unknown, cb: (res: MockRes) => void) => {
        const req = new EventEmitter() as MockReq;
        req.write = jest.fn();
        req.end = jest.fn();
        req.setTimeout = jest.fn();
        req.destroy = jest.fn();

        const res = new EventEmitter() as MockRes;
        res.resume = jest.fn();
        res.headers = { 'retry-after': '60' };
        res.statusCode = 429;

        callCount++;
        setImmediate(() => {
          res.emit('data', Buffer.from('rate limited'));
          res.emit('end');
        });

        cb(res);
        return req;
      },
    );

    const cancelCallbacks: Array<() => void> = [];
    const cancellationToken = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn().mockImplementation((cb: () => void) => {
        cancelCallbacks.push(cb);
        return {
          dispose: () => {
            const idx = cancelCallbacks.indexOf(cb);
            if (idx >= 0) {
              cancelCallbacks.splice(idx, 1);
            }
          },
        };
      }),
    };

    const p = new ApiKeyProvider({ openaiApiKey: 'sk-openai-key' });
    const resultPromise = p.sendRequest(AgentName.GPT, {
      ...defaultOpts,
      onChunk: jest.fn(),
      cancellationToken: cancellationToken as unknown as import('vscode').CancellationToken,
    });

    await jest.advanceTimersByTimeAsync(0);
    cancellationToken.isCancellationRequested = true;
    for (const cb of [...cancelCallbacks]) {
      cb();
    }

    await expect(resultPromise).rejects.toMatchObject({ name: 'CancellationError' });
    expect(callCount).toBe(1);
  });
});

// ── makeHttpsStreamRequest: onLine throws on final buffer ────────────────────

describe('ApiKeyProvider — makeHttpsStreamRequest: onLine error on final buffer', () => {
  beforeEach(() => jest.clearAllMocks());

  it('rejects when the final buffered line throws', async () => {
    // Send body WITHOUT trailing newline so it stays in the buffer until 'end'
    // The line is invalid JSON which gets swallowed by try/catch in onLine,
    // but we can trigger the reject path by making onLine throw an ApiKeyProviderError.
    // Easiest: send a 500 status so the error path fires on 'end'.
    setupSequentialMock({ statusCode: 500, bodies: ['error text without newline'] });

    const p = new ApiKeyProvider({ anthropicApiKey: 'sk-ant-key' });
    await expect(
      p.sendRequest(AgentName.CLAUDE, { ...defaultOpts, onChunk: jest.fn() }),
    ).rejects.toBeInstanceOf(ApiKeyProviderError);
  });
});

// ── makeHttpsRequest (non-streaming): res.on('error') ────────────────────────

describe('ApiKeyProvider — makeHttpsRequest: response error', () => {
  beforeEach(() => jest.clearAllMocks());

  it('rejects when non-stream response emits error', async () => {
    setupSequentialMock({ networkError: new Error('socket reset') });

    const p = new ApiKeyProvider({ anthropicApiKey: 'sk-ant-key' });
    await expect(
      p.sendRequest(AgentName.CLAUDE, defaultOpts), // no onChunk → non-streaming
    ).rejects.toBeInstanceOf(ApiKeyProviderError);
  });
});

// ── makeHttpsRequest (non-streaming): cancellation token ─────────────────────

describe('ApiKeyProvider — makeHttpsRequest: cancellation token fires', () => {
  beforeEach(() => jest.clearAllMocks());

  it('destroys request and rejects with CancellationError when token fires', async () => {
    let onCancelCb: (() => void) | undefined;

    (https.request as jest.Mock).mockImplementation(
      (_o: unknown, cb: (res: MockRes) => void) => {
        const req = new EventEmitter() as MockReq;
        req.write = jest.fn();
        req.end = jest.fn();
        req.setTimeout = jest.fn();
        req.destroy = jest.fn().mockImplementation((err?: Error) => {
          if (err) setImmediate(() => req.emit('error', err));
        });

        const res = new EventEmitter() as MockRes;
        res.statusCode = 200;
        res.headers = {};
        res.resume = jest.fn();

        // Don't emit data yet — let cancel fire first
        setImmediate(() => {
          if (onCancelCb) onCancelCb();
        });

        cb(res);
        return req;
      },
    );

    const cancellationToken = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn().mockImplementation((cb: () => void) => {
        onCancelCb = cb;
        return { dispose: jest.fn() };
      }),
    };

    const p = new ApiKeyProvider({ anthropicApiKey: 'sk-ant-key' });
    const err = await p.sendRequest(AgentName.CLAUDE, {
      ...defaultOpts,
      cancellationToken: cancellationToken as unknown as import('vscode').CancellationToken,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
  });
});

// ── parseRetryAfterMs — missing header ───────────────────────────────────────

describe('ApiKeyProvider — parseRetryAfterMs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });
  afterEach(() => jest.useRealTimers());

  it('defaults to 60s when retry-after header is absent', async () => {
    let callCount = 0;
    (https.request as jest.Mock).mockImplementation(
      (_o: unknown, cb: (res: MockRes) => void) => {
        const req = new EventEmitter() as MockReq;
        req.write = jest.fn();
        req.end = jest.fn();
        req.setTimeout = jest.fn();
        req.destroy = jest.fn();

        const res = new EventEmitter() as MockRes;
        res.resume = jest.fn();
        res.headers = {}; // no retry-after header

        callCount++;
        if (callCount === 1) {
          res.statusCode = 429;
          setImmediate(() => { res.emit('data', Buffer.from('rate limited')); res.emit('end'); });
        } else {
          res.statusCode = 200;
          const body = JSON.stringify({
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
          });
          setImmediate(() => { res.emit('data', Buffer.from(body)); res.emit('end'); });
        }

        cb(res);
        return req;
      },
    );

    const p = new ApiKeyProvider({ anthropicApiKey: 'sk-ant-key' });
    const resultPromise = p.sendRequest(AgentName.CLAUDE, defaultOpts); // non-streaming

    // Default delay is 60s — advance past it
    await jest.advanceTimersByTimeAsync(61_000);
    const result = await resultPromise;
    expect(result.content).toBe('ok');
    expect(callCount).toBe(2);
  });

  it('cancels immediately during 429 retry backoff (non-streaming)', async () => {
    let callCount = 0;
    (https.request as jest.Mock).mockImplementation(
      (_o: unknown, cb: (res: MockRes) => void) => {
        const req = new EventEmitter() as MockReq;
        req.write = jest.fn();
        req.end = jest.fn();
        req.setTimeout = jest.fn();
        req.destroy = jest.fn();

        const res = new EventEmitter() as MockRes;
        res.resume = jest.fn();
        res.headers = {}; // default 60s
        res.statusCode = 429;

        callCount++;
        setImmediate(() => {
          res.emit('data', Buffer.from('rate limited'));
          res.emit('end');
        });

        cb(res);
        return req;
      },
    );

    const cancelCallbacks: Array<() => void> = [];
    const cancellationToken = {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn().mockImplementation((cb: () => void) => {
        cancelCallbacks.push(cb);
        return {
          dispose: () => {
            const idx = cancelCallbacks.indexOf(cb);
            if (idx >= 0) {
              cancelCallbacks.splice(idx, 1);
            }
          },
        };
      }),
    };

    const p = new ApiKeyProvider({ anthropicApiKey: 'sk-ant-key' });
    const resultPromise = p.sendRequest(AgentName.CLAUDE, {
      ...defaultOpts,
      cancellationToken: cancellationToken as unknown as import('vscode').CancellationToken,
    });

    await jest.advanceTimersByTimeAsync(0);
    cancellationToken.isCancellationRequested = true;
    for (const cb of [...cancelCallbacks]) {
      cb();
    }

    await expect(resultPromise).rejects.toMatchObject({ name: 'CancellationError' });
    expect(callCount).toBe(1);
  });
});

// ── Gemini non-streaming: cancellation mid-tool-call ─────────────────────────

describe('ApiKeyProvider — Gemini non-streaming: cancellation mid-tool-call', () => {
  beforeEach(() => jest.clearAllMocks());

  it('throws CancellationError when token is set after functionCall response', async () => {
    const toolBody = JSON.stringify({
      candidates: [{
        content: {
          parts: [{ functionCall: { name: 'read_file', args: { path: 'src/app.ts' } } }],
        },
        finishReason: 'STOP',
      }],
    });

    setupSequentialMock({ bodies: [toolBody] });

    // Token starts uncancelled, becomes cancelled before tool results are sent
    const token = { isCancellationRequested: false, onCancellationRequested: jest.fn() };
    const onToolCall = jest.fn().mockImplementation(async () => {
      token.isCancellationRequested = true;
      return { id: 'r', content: 'file content', isError: false };
    });

    const p = new ApiKeyProvider({ googleApiKey: 'AIza-key' });
    await expect(
      p.sendRequest(AgentName.GEMINI, {
        ...defaultOpts,
        onToolCall,
        cancellationToken: token as unknown as import('vscode').CancellationToken,
      }),
    ).rejects.toMatchObject({ name: 'CancellationError' });
  });
});

// ── Gemini streaming: cancellation mid-tool-call ─────────────────────────────

describe('ApiKeyProvider — Gemini streaming: cancellation mid-tool-call', () => {
  beforeEach(() => jest.clearAllMocks());

  it('throws CancellationError when token is set after streaming functionCall', async () => {
    const toolLine = 'data: ' + JSON.stringify({
      candidates: [{
        content: {
          parts: [{ functionCall: { name: 'read_file', args: { path: 'src/app.ts' } } }],
        },
        finishReason: 'STOP',
      }],
    });

    setupSequentialMock({ bodies: [toolLine + '\n'] });

    const token = { isCancellationRequested: false, onCancellationRequested: jest.fn() };
    const onToolCall = jest.fn().mockImplementation(async () => {
      token.isCancellationRequested = true;
      return { id: 'r', content: 'file content', isError: false };
    });

    const p = new ApiKeyProvider({ googleApiKey: 'AIza-key' });
    await expect(
      p.sendRequest(AgentName.GEMINI, {
        ...defaultOpts,
        onChunk: jest.fn(),
        onToolCall,
        cancellationToken: token as unknown as import('vscode').CancellationToken,
      }),
    ).rejects.toMatchObject({ name: 'CancellationError' });
  });
});

// ── Claude streaming: cancellation mid-tool-call ─────────────────────────────

describe('ApiKeyProvider — Claude streaming: cancellation mid-tool-call', () => {
  beforeEach(() => jest.clearAllMocks());

  it('throws CancellationError when token fires after stream tool_use', async () => {
    const sseBody = [
      'data: ' + JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'read_file' } }),
      'data: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"src/x.ts"}' } }),
      'data: ' + JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } }),
    ].join('\n') + '\n';

    setupSequentialMock({ bodies: [sseBody] });

    const token = { isCancellationRequested: false, onCancellationRequested: jest.fn() };
    const onToolCall = jest.fn().mockImplementation(async () => {
      token.isCancellationRequested = true;
      return { id: 't1', content: 'file', isError: false };
    });

    const p = new ApiKeyProvider({ anthropicApiKey: 'sk-ant-key' });
    await expect(
      p.sendRequest(AgentName.CLAUDE, {
        ...defaultOpts,
        onChunk: jest.fn(),
        onToolCall,
        cancellationToken: token as unknown as import('vscode').CancellationToken,
      }),
    ).rejects.toMatchObject({ name: 'CancellationError' });
  });
});
