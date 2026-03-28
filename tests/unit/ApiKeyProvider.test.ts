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
    (_opts: unknown, callback: (res: EventEmitter & { statusCode?: number }) => void) => {
      const mockRes = new EventEmitter() as EventEmitter & { statusCode?: number };
      mockRes.statusCode = statusCode;

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
  maxTokens: 1000,
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
    expect(result).toBe('Hello from Claude');
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
    expect(result).toBe('Hello from GPT');
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
    expect(result).toBe('Hello from Gemini');
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
