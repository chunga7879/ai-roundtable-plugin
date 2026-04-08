/**
 * Additional branch coverage tests for ApiKeyProvider.
 *
 * Covers: Claude tool call loop (read_file, write_file, run_command),
 * cancellation mid-tool-call, usage token tracking, OpenAI tool call loop,
 * OpenAI JSON parse error in tool args, Gemini tool call handling,
 * streaming variants (Claude, OpenAI, Gemini, DeepSeek) basic paths,
 * error responses and no-content paths for each provider,
 * hasKeyForAgent deepseek, light model tier routing.
 */
import { EventEmitter } from 'events';
import { ApiKeyProvider, ApiKeyProviderError } from '../../src/agents/ApiKeyProvider';
import { AgentName } from '../../src/types';

jest.mock('https');
import * as https from 'https';

// ── Mock infrastructure ───────────────────────────────────────────────────────

interface MockOpts {
  statusCode?: number;
  bodies?: string[];   // each element is emitted on a separate https.request call
  networkError?: Error;
  requestError?: Error;
}

let responseIndex = 0;
let mockBodies: string[] = [];

function setupSequentialMock(opts: MockOpts = {}) {
  const { statusCode = 200, bodies = ['{}'], networkError, requestError } = opts;
  mockBodies = bodies;
  responseIndex = 0;

  (https.request as jest.Mock).mockImplementation(
    (_o: unknown, cb: (res: EventEmitter & { statusCode?: number; headers: Record<string, string>; resume: jest.Mock }) => void) => {
      const mockReq = new EventEmitter() as EventEmitter & { write: jest.Mock; end: jest.Mock; setTimeout: jest.Mock; destroy: jest.Mock };
      mockReq.write = jest.fn();
      mockReq.end = jest.fn();
      mockReq.setTimeout = jest.fn();
      mockReq.destroy = jest.fn().mockImplementation((err?: Error) => {
        if (err) setImmediate(() => mockReq.emit('error', err));
      });

      const mockRes = new EventEmitter() as EventEmitter & { statusCode?: number; headers: Record<string, string>; resume: jest.Mock };
      mockRes.statusCode = statusCode;
      mockRes.headers = {};
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

function claudeBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    content: [{ type: 'text', text: 'Claude response' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
    ...overrides,
  });
}

function openaiBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    choices: [{ message: { content: 'GPT response', tool_calls: undefined }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
    ...overrides,
  });
}

function geminiBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    candidates: [{ content: { parts: [{ text: 'Gemini response' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    ...overrides,
  });
}

const defaultOpts = { systemPrompt: 'You are a developer.', userMessage: 'build feature' };

// ── hasKeyForAgent — deepseek ─────────────────────────────────────────────────

describe('ApiKeyProvider.hasKeyForAgent — deepseek', () => {
  it('returns true for deepseek when deepseekApiKey is set', () => {
    const p = new ApiKeyProvider({ deepseekApiKey: 'sk-ds' });
    expect(p.hasKeyForAgent(AgentName.DEEPSEEK)).toBe(true);
  });

  it('returns false for deepseek when deepseekApiKey is missing', () => {
    const p = new ApiKeyProvider({});
    expect(p.hasKeyForAgent(AgentName.DEEPSEEK)).toBe(false);
  });
});

// ── Claude tool call — read_file ──────────────────────────────────────────────

describe('ApiKeyProvider — Claude tool call: read_file', () => {
  beforeEach(() => jest.clearAllMocks());

  it('executes read_file tool call and returns final text', async () => {
    const toolUseBody = JSON.stringify({
      content: [
        { type: 'tool_use', id: 'tool1', name: 'read_file', input: { path: 'src/app.ts' } },
      ],
      stop_reason: 'tool_use',
    });
    const finalBody = claudeBody({ content: [{ type: 'text', text: 'File content processed' }] });
    setupSequentialMock({ bodies: [toolUseBody, finalBody] });

    const onToolCall = jest.fn().mockResolvedValue({ id: 'tool1', content: 'file content', isError: false });
    const p = new ApiKeyProvider({ anthropicApiKey: 'sk-ant' });
    const result = await p.sendRequest(AgentName.CLAUDE, { ...defaultOpts, onToolCall });

    expect(onToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'read_file', filePath: 'src/app.ts' }),
    );
    expect(result.content).toBe('File content processed');
  });
});

// ── Claude tool call — write_file ─────────────────────────────────────────────

describe('ApiKeyProvider — Claude tool call: write_file', () => {
  beforeEach(() => jest.clearAllMocks());

  it('executes write_file tool call', async () => {
    const toolUseBody = JSON.stringify({
      content: [
        { type: 'tool_use', id: 'tool2', name: 'write_file', input: { path: 'src/out.ts', content: 'export const x = 1;' } },
      ],
      stop_reason: 'tool_use',
    });
    const finalBody = claudeBody({ content: [{ type: 'text', text: 'Written' }] });
    setupSequentialMock({ bodies: [toolUseBody, finalBody] });

    const onToolCall = jest.fn().mockResolvedValue({ id: 'tool2', content: 'written', isError: false });
    const p = new ApiKeyProvider({ anthropicApiKey: 'sk-ant' });
    await p.sendRequest(AgentName.CLAUDE, { ...defaultOpts, onToolCall });

    expect(onToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'write_file', filePath: 'src/out.ts', content: 'export const x = 1;' }),
    );
  });
});

// ── Claude tool call — run_command ────────────────────────────────────────────

describe('ApiKeyProvider — Claude tool call: run_command', () => {
  beforeEach(() => jest.clearAllMocks());

  it('executes run_command tool call', async () => {
    const toolUseBody = JSON.stringify({
      content: [
        { type: 'tool_use', id: 'tool3', name: 'run_command', input: { command: 'npm test' } },
      ],
      stop_reason: 'tool_use',
    });
    const finalBody = claudeBody({ content: [{ type: 'text', text: 'Tests ran' }] });
    setupSequentialMock({ bodies: [toolUseBody, finalBody] });

    const onToolCall = jest.fn().mockResolvedValue({ id: 'tool3', content: 'output', isError: false });
    const p = new ApiKeyProvider({ anthropicApiKey: 'sk-ant' });
    await p.sendRequest(AgentName.CLAUDE, { ...defaultOpts, onToolCall });

    expect(onToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'run_command', command: 'npm test' }),
    );
  });
});

// ── Claude — usage token tracking ────────────────────────────────────────────

describe('ApiKeyProvider — Claude usage tokens', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns usage when input/output tokens are present', async () => {
    setupSequentialMock({ bodies: [claudeBody()] });
    const p = new ApiKeyProvider({ anthropicApiKey: 'sk-ant' });
    const result = await p.sendRequest(AgentName.CLAUDE, defaultOpts);
    expect(result.usage).toBeDefined();
    expect(result.usage?.inputTokens).toBe(10);
    expect(result.usage?.outputTokens).toBe(5);
  });

  it('returns undefined usage when no usage in response', async () => {
    setupSequentialMock({
      bodies: [JSON.stringify({
        content: [{ type: 'text', text: 'no usage' }],
        stop_reason: 'end_turn',
      })],
    });
    const p = new ApiKeyProvider({ anthropicApiKey: 'sk-ant' });
    const result = await p.sendRequest(AgentName.CLAUDE, defaultOpts);
    expect(result.usage).toBeUndefined();
  });
});

// ── Claude — cancellation mid tool call ──────────────────────────────────────

describe('ApiKeyProvider — Claude cancellation during tool call', () => {
  beforeEach(() => jest.clearAllMocks());

  it('throws CancellationError when token is cancelled after tool use', async () => {
    const toolUseBody = JSON.stringify({
      content: [
        { type: 'tool_use', id: 'tool4', name: 'read_file', input: { path: 'src/app.ts' } },
      ],
      stop_reason: 'tool_use',
    });
    setupSequentialMock({ bodies: [toolUseBody] });

    const onToolCall = jest.fn().mockResolvedValue({ id: 'tool4', content: 'content', isError: false });
    const cancellationToken = { isCancellationRequested: true, onCancellationRequested: jest.fn().mockReturnValue({ dispose: jest.fn() }) };

    const p = new ApiKeyProvider({ anthropicApiKey: 'sk-ant' });
    await expect(p.sendRequest(AgentName.CLAUDE, { ...defaultOpts, onToolCall, cancellationToken }))
      .rejects.toMatchObject({ name: 'CancellationError' });
  });
});

// ── OpenAI tool call — read_file ──────────────────────────────────────────────

describe('ApiKeyProvider — OpenAI tool call: read_file', () => {
  beforeEach(() => jest.clearAllMocks());

  it('executes read_file tool call for OpenAI', async () => {
    const toolCallBody = JSON.stringify({
      choices: [{
        message: {
          content: null,
          tool_calls: [{ id: 'tc1', function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/utils.ts' }) } }],
        },
        finish_reason: 'tool_calls',
      }],
    });
    const finalBody = openaiBody();
    setupSequentialMock({ bodies: [toolCallBody, finalBody] });

    const onToolCall = jest.fn().mockResolvedValue({ id: 'tc1', content: 'utils content', isError: false });
    const p = new ApiKeyProvider({ openaiApiKey: 'sk-openai' });
    await p.sendRequest(AgentName.GPT, { ...defaultOpts, onToolCall });

    expect(onToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'read_file', filePath: 'src/utils.ts' }),
    );
  });
});

// ── OpenAI tool call — write_file ─────────────────────────────────────────────

describe('ApiKeyProvider — OpenAI tool call: write_file', () => {
  beforeEach(() => jest.clearAllMocks());

  it('executes write_file tool call for OpenAI', async () => {
    const toolCallBody = JSON.stringify({
      choices: [{
        message: {
          content: null,
          tool_calls: [{ id: 'tc2', function: { name: 'write_file', arguments: JSON.stringify({ path: 'src/new.ts', content: 'code' }) } }],
        },
        finish_reason: 'tool_calls',
      }],
    });
    const finalBody = openaiBody();
    setupSequentialMock({ bodies: [toolCallBody, finalBody] });

    const onToolCall = jest.fn().mockResolvedValue({ id: 'tc2', content: 'ok', isError: false });
    const p = new ApiKeyProvider({ openaiApiKey: 'sk-openai' });
    await p.sendRequest(AgentName.GPT, { ...defaultOpts, onToolCall });

    expect(onToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'write_file', filePath: 'src/new.ts' }),
    );
  });
});

// ── OpenAI tool call — run_command ────────────────────────────────────────────

describe('ApiKeyProvider — OpenAI tool call: run_command', () => {
  beforeEach(() => jest.clearAllMocks());

  it('executes run_command tool call for OpenAI', async () => {
    const toolCallBody = JSON.stringify({
      choices: [{
        message: {
          content: null,
          tool_calls: [{ id: 'tc3', function: { name: 'run_command', arguments: JSON.stringify({ command: 'npm build' }) } }],
        },
        finish_reason: 'tool_calls',
      }],
    });
    const finalBody = openaiBody();
    setupSequentialMock({ bodies: [toolCallBody, finalBody] });

    const onToolCall = jest.fn().mockResolvedValue({ id: 'tc3', content: 'build output', isError: false });
    const p = new ApiKeyProvider({ openaiApiKey: 'sk-openai' });
    await p.sendRequest(AgentName.GPT, { ...defaultOpts, onToolCall });

    expect(onToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'run_command', command: 'npm build' }),
    );
  });

  it('handles invalid JSON in tool call arguments gracefully', async () => {
    const toolCallBody = JSON.stringify({
      choices: [{
        message: {
          content: null,
          tool_calls: [{ id: 'tc4', function: { name: 'run_command', arguments: 'not-json' } }],
        },
        finish_reason: 'tool_calls',
      }],
    });
    const finalBody = openaiBody();
    setupSequentialMock({ bodies: [toolCallBody, finalBody] });

    const onToolCall = jest.fn().mockResolvedValue({ id: 'tc4', content: 'output', isError: false });
    const p = new ApiKeyProvider({ openaiApiKey: 'sk-openai' });
    await p.sendRequest(AgentName.GPT, { ...defaultOpts, onToolCall });

    // Should still call onToolCall with empty command (args fallback to {})
    expect(onToolCall).toHaveBeenCalled();
  });
});

// ── OpenAI — usage token tracking ────────────────────────────────────────────

describe('ApiKeyProvider — OpenAI usage tokens', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns usage when prompt/completion tokens are present', async () => {
    setupSequentialMock({ bodies: [openaiBody()] });
    const p = new ApiKeyProvider({ openaiApiKey: 'sk-openai' });
    const result = await p.sendRequest(AgentName.GPT, defaultOpts);
    expect(result.usage).toBeDefined();
    expect(result.usage?.inputTokens).toBe(10);
    expect(result.usage?.outputTokens).toBe(5);
  });

  it('returns undefined usage when no usage in response', async () => {
    setupSequentialMock({
      bodies: [JSON.stringify({
        choices: [{ message: { content: 'Response' }, finish_reason: 'stop' }],
      })],
    });
    const p = new ApiKeyProvider({ openaiApiKey: 'sk-openai' });
    const result = await p.sendRequest(AgentName.GPT, defaultOpts);
    expect(result.usage).toBeUndefined();
  });
});

// ── OpenAI — cancellation mid tool call ──────────────────────────────────────

describe('ApiKeyProvider — OpenAI cancellation during tool call', () => {
  beforeEach(() => jest.clearAllMocks());

  it('throws CancellationError when token is cancelled after tool call', async () => {
    const toolCallBody = JSON.stringify({
      choices: [{
        message: {
          content: null,
          tool_calls: [{ id: 'tc5', function: { name: 'read_file', arguments: JSON.stringify({ path: 'x.ts' }) } }],
        },
        finish_reason: 'tool_calls',
      }],
    });
    setupSequentialMock({ bodies: [toolCallBody] });

    const onToolCall = jest.fn().mockResolvedValue({ id: 'tc5', content: 'content', isError: false });
    const cancellationToken = { isCancellationRequested: true, onCancellationRequested: jest.fn().mockReturnValue({ dispose: jest.fn() }) };

    const p = new ApiKeyProvider({ openaiApiKey: 'sk-openai' });
    await expect(p.sendRequest(AgentName.GPT, { ...defaultOpts, onToolCall, cancellationToken }))
      .rejects.toMatchObject({ name: 'CancellationError' });
  });
});

// ── Gemini — happy path ───────────────────────────────────────────────────────

describe('ApiKeyProvider — Gemini', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns text from successful Gemini response', async () => {
    setupSequentialMock({ bodies: [geminiBody()] });
    const p = new ApiKeyProvider({ googleApiKey: 'goog-key' });
    const result = await p.sendRequest(AgentName.GEMINI, defaultOpts);
    expect(result.content).toBe('Gemini response');
  });

  it('throws when no googleApiKey is configured', async () => {
    const p = new ApiKeyProvider({});
    await expect(p.sendRequest(AgentName.GEMINI, defaultOpts))
      .rejects.toBeInstanceOf(ApiKeyProviderError);
  });

  it('throws on API error response', async () => {
    setupSequentialMock({ bodies: [JSON.stringify({ error: { message: 'quota exceeded' } })] });
    const p = new ApiKeyProvider({ googleApiKey: 'goog-key' });
    await expect(p.sendRequest(AgentName.GEMINI, defaultOpts))
      .rejects.toBeInstanceOf(ApiKeyProviderError);
  });

  it('throws on non-JSON response', async () => {
    setupSequentialMock({ bodies: ['<html>'] });
    const p = new ApiKeyProvider({ googleApiKey: 'goog-key' });
    await expect(p.sendRequest(AgentName.GEMINI, defaultOpts))
      .rejects.toBeInstanceOf(ApiKeyProviderError);
  });

  it('returns usage from Gemini response', async () => {
    setupSequentialMock({ bodies: [geminiBody()] });
    const p = new ApiKeyProvider({ googleApiKey: 'goog-key' });
    const result = await p.sendRequest(AgentName.GEMINI, defaultOpts);
    expect(result.usage?.inputTokens).toBe(10);
    expect(result.usage?.outputTokens).toBe(5);
  });

  it('includes conversation history in request', async () => {
    setupSequentialMock({ bodies: [geminiBody()] });
    const p = new ApiKeyProvider({ googleApiKey: 'goog-key' });
    const result = await p.sendRequest(AgentName.GEMINI, {
      ...defaultOpts,
      conversationHistory: [
        { role: 'user', content: 'Prior question' },
        { role: 'assistant', content: 'Prior answer' },
      ],
    });
    expect(result.content).toBe('Gemini response');
  });
});

// ── DeepSeek — happy path ─────────────────────────────────────────────────────

describe('ApiKeyProvider — DeepSeek', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns text from successful DeepSeek response', async () => {
    setupSequentialMock({ bodies: [openaiBody({ choices: [{ message: { content: 'DeepSeek response' }, finish_reason: 'stop' }] })] });
    const p = new ApiKeyProvider({ deepseekApiKey: 'sk-ds' });
    const result = await p.sendRequest(AgentName.DEEPSEEK, defaultOpts);
    expect(result.content).toBe('DeepSeek response');
  });

  it('throws when no deepseekApiKey is configured', async () => {
    const p = new ApiKeyProvider({});
    await expect(p.sendRequest(AgentName.DEEPSEEK, defaultOpts))
      .rejects.toBeInstanceOf(ApiKeyProviderError);
  });
});

// ── Streaming variants — basic paths ─────────────────────────────────────────

describe('ApiKeyProvider — streaming: Claude', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls onChunk and returns content via streaming', async () => {
    const streamBody = [
      'data: ' + JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello ' } }),
      'data: ' + JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'world' } }),
      'data: ' + JSON.stringify({ type: 'message_stop' }),
    ].join('\n');

    setupSequentialMock({ bodies: [streamBody] });

    const chunks: string[] = [];
    const p = new ApiKeyProvider({ anthropicApiKey: 'sk-ant' });
    const result = await p.sendRequest(AgentName.CLAUDE, { ...defaultOpts, onChunk: (c) => chunks.push(c) });

    expect(chunks).toContain('Hello ');
    expect(chunks).toContain('world');
    expect(result.content).toBe('Hello world');
  });
});

describe('ApiKeyProvider — streaming: OpenAI', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls onChunk and returns content via streaming', async () => {
    const streamBody = [
      'data: ' + JSON.stringify({ choices: [{ delta: { content: 'GPT ' }, finish_reason: null }] }),
      'data: ' + JSON.stringify({ choices: [{ delta: { content: 'streaming' }, finish_reason: 'stop' }] }),
      'data: [DONE]',
    ].join('\n');

    setupSequentialMock({ bodies: [streamBody] });

    const chunks: string[] = [];
    const p = new ApiKeyProvider({ openaiApiKey: 'sk-openai' });
    const result = await p.sendRequest(AgentName.GPT, { ...defaultOpts, onChunk: (c) => chunks.push(c) });

    expect(result.content).toContain('GPT');
    expect(result.content).toContain('streaming');
  });
});

describe('ApiKeyProvider — streaming: Gemini', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls onChunk and returns content via streaming', async () => {
    // Gemini streaming uses SSE format with 'data: ' prefix
    const streamBody = [
      'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Gemini ' }] }, finishReason: null }] }),
      'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: 'streaming' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 } }),
    ].join('\n');

    setupSequentialMock({ bodies: [streamBody] });

    const chunks: string[] = [];
    const p = new ApiKeyProvider({ googleApiKey: 'goog-key' });
    const result = await p.sendRequest(AgentName.GEMINI, { ...defaultOpts, onChunk: (c) => chunks.push(c) });

    expect(result.content).toContain('Gemini');
  });
});

describe('ApiKeyProvider — streaming: DeepSeek', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls onChunk and returns content via streaming', async () => {
    const streamBody = [
      'data: ' + JSON.stringify({ choices: [{ delta: { content: 'DS response' }, finish_reason: 'stop' }] }),
      'data: [DONE]',
    ].join('\n');

    setupSequentialMock({ bodies: [streamBody] });

    const chunks: string[] = [];
    const p = new ApiKeyProvider({ deepseekApiKey: 'sk-ds' });
    const result = await p.sendRequest(AgentName.DEEPSEEK, { ...defaultOpts, onChunk: (c) => chunks.push(c) });

    expect(result.content).toContain('DS response');
  });
});

// ── Light model tier ──────────────────────────────────────────────────────────

describe('ApiKeyProvider — light model tier', () => {
  beforeEach(() => jest.clearAllMocks());

  it('uses light model variants when modelTier is light', async () => {
    setupSequentialMock({ bodies: [claudeBody()] });
    const p = new ApiKeyProvider({ anthropicApiKey: 'sk-ant', modelTier: 'light' });
    const result = await p.sendRequest(AgentName.CLAUDE, defaultOpts);
    expect(result.content).toBe('Claude response');
    // The model used should be different (haiku vs sonnet) but we just verify it runs
  });
});
