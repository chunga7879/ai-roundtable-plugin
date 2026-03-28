import * as vscode from 'vscode';
import { CopilotProvider, CopilotProviderError } from '../../src/agents/CopilotProvider';
import { AgentName } from '../../src/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeToken(cancelled = false): vscode.CancellationToken {
  return {
    isCancellationRequested: cancelled,
    onCancellationRequested: jest.fn(),
  } as unknown as vscode.CancellationToken;
}

async function* toAsyncIterable(chunks: string[]): AsyncIterable<string> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

function makeModel(chunks: string[] = ['hello ', 'world'], throwOnSend?: Error) {
  return {
    sendRequest: jest.fn().mockImplementation(() => {
      if (throwOnSend) {
        throw throwOnSend;
      }
      return Promise.resolve({ text: toAsyncIterable(chunks) });
    }),
  };
}

const defaultOptions = {
  systemPrompt: 'You are a developer.',
  userMessage: 'write tests',
  maxTokens: 1000,
};

// ── isAvailable ───────────────────────────────────────────────────────────────

describe('CopilotProvider.isAvailable', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns true when models are available', async () => {
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([makeModel()]);
    const provider = new CopilotProvider();
    expect(await provider.isAvailable()).toBe(true);
  });

  it('returns false when no models returned', async () => {
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([]);
    const provider = new CopilotProvider();
    expect(await provider.isAvailable()).toBe(false);
  });

  it('returns false when selectChatModels throws', async () => {
    (vscode.lm.selectChatModels as jest.Mock).mockRejectedValue(new Error('unavailable'));
    const provider = new CopilotProvider();
    expect(await provider.isAvailable()).toBe(false);
  });
});

// ── sendRequest — success ─────────────────────────────────────────────────────

describe('CopilotProvider.sendRequest — success', () => {
  beforeEach(() => jest.clearAllMocks());

  it('joins streamed chunks into a single string', async () => {
    const model = makeModel(['hello ', 'world']);
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);
    const provider = new CopilotProvider();

    const result = await provider.sendRequest(defaultOptions, AgentName.CLAUDE, makeToken());
    expect(result).toBe('hello world');
  });

  it('uses cached model on second call', async () => {
    const model = makeModel(['cached response']);
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);
    const provider = new CopilotProvider();

    await provider.sendRequest(defaultOptions, AgentName.CLAUDE, makeToken());
    await provider.sendRequest(defaultOptions, AgentName.CLAUDE, makeToken());

    // selectChatModels called only once due to caching
    expect(vscode.lm.selectChatModels).toHaveBeenCalledTimes(1);
  });

  it('invalidateModelCache clears cached model', async () => {
    const model = makeModel(['response']);
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);
    const provider = new CopilotProvider();

    await provider.sendRequest(defaultOptions, AgentName.CLAUDE, makeToken());
    provider.invalidateModelCache();
    await provider.sendRequest(defaultOptions, AgentName.CLAUDE, makeToken());

    expect(vscode.lm.selectChatModels).toHaveBeenCalledTimes(2);
  });

  it('tries model families in order', async () => {
    // First family (gpt-4o) returns empty; second (gpt-4) returns a model
    (vscode.lm.selectChatModels as jest.Mock)
      .mockResolvedValueOnce([]) // gpt-4o — empty
      .mockResolvedValueOnce([makeModel(['from gpt-4'])]) // gpt-4
      .mockResolvedValue([makeModel(['fallback'])]);

    const provider = new CopilotProvider();
    const result = await provider.sendRequest(defaultOptions, AgentName.GPT, makeToken());
    expect(result).toBe('from gpt-4');
  });

  it('falls back to any copilot model when all families return empty', async () => {
    (vscode.lm.selectChatModels as jest.Mock)
      .mockResolvedValue([]) // all family queries → empty
      .mockResolvedValueOnce([makeModel(['fallback response'])]); // re-mock first call as families

    // All 4 families return empty, fallback returns a model
    const selectMock = vscode.lm.selectChatModels as jest.Mock;
    selectMock.mockReset();
    for (let i = 0; i < 4; i++) {
      selectMock.mockResolvedValueOnce([]); // each family
    }
    selectMock.mockResolvedValueOnce([makeModel(['any model response'])]); // fallback

    const provider = new CopilotProvider();
    const result = await provider.sendRequest(defaultOptions, AgentName.CLAUDE, makeToken());
    expect(result).toBe('any model response');
  });
});

// ── sendRequest — errors ──────────────────────────────────────────────────────

describe('CopilotProvider.sendRequest — errors', () => {
  beforeEach(() => jest.clearAllMocks());

  it('throws CopilotProviderError when no models available at all', async () => {
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([]);
    const provider = new CopilotProvider();
    await expect(provider.sendRequest(defaultOptions, AgentName.CLAUDE, makeToken()))
      .rejects.toBeInstanceOf(CopilotProviderError);
  });

  it('throws CopilotProviderError when sendRequest fails', async () => {
    const model = makeModel([], new Error('request failed'));
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);
    const provider = new CopilotProvider();

    await expect(provider.sendRequest(defaultOptions, AgentName.CLAUDE, makeToken()))
      .rejects.toBeInstanceOf(CopilotProviderError);
  });

  it('invalidates cache when sendRequest throws', async () => {
    const model = makeModel([], new Error('broken'));
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);
    const provider = new CopilotProvider();

    await expect(provider.sendRequest(defaultOptions, AgentName.CLAUDE, makeToken()))
      .rejects.toBeInstanceOf(CopilotProviderError);

    // After failure, selectChatModels should be called again on next request
    const goodModel = makeModel(['recovered']);
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([goodModel]);
    const result = await provider.sendRequest(defaultOptions, AgentName.CLAUDE, makeToken());
    expect(result).toBe('recovered');
    expect(vscode.lm.selectChatModels).toHaveBeenCalledTimes(2);
  });

  it('throws CopilotProviderError when response is empty', async () => {
    const model = makeModel(['   ']); // whitespace-only
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);
    const provider = new CopilotProvider();

    await expect(provider.sendRequest(defaultOptions, AgentName.CLAUDE, makeToken()))
      .rejects.toBeInstanceOf(CopilotProviderError);
  });

  it('propagates CancellationError from sendRequest', async () => {
    const model = {
      sendRequest: jest.fn().mockRejectedValue(new vscode.CancellationError()),
    };
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);
    const provider = new CopilotProvider();

    await expect(provider.sendRequest(defaultOptions, AgentName.CLAUDE, makeToken()))
      .rejects.toBeInstanceOf(vscode.CancellationError);
  });

  it('throws CancellationError when cancelled mid-stream', async () => {
    const token = makeToken();
    let firstChunk = true;
    async function* cancellingStream(): AsyncIterable<string> {
      yield 'first chunk';
      // Simulate cancellation after first chunk
      (token as { isCancellationRequested: boolean }).isCancellationRequested = true;
      if (!firstChunk) return;
      firstChunk = false;
      yield 'second chunk';
    }
    const model = {
      sendRequest: jest.fn().mockResolvedValue({ text: cancellingStream() }),
    };
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);
    const provider = new CopilotProvider();

    await expect(provider.sendRequest(defaultOptions, AgentName.CLAUDE, token))
      .rejects.toBeInstanceOf(vscode.CancellationError);
  });

  it('wraps stream iteration errors as CopilotProviderError', async () => {
    async function* throwingStream(): AsyncIterable<string> {
      yield 'partial';
      throw new Error('stream error');
    }
    const model = {
      sendRequest: jest.fn().mockResolvedValue({ text: throwingStream() }),
    };
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);
    const provider = new CopilotProvider();

    await expect(provider.sendRequest(defaultOptions, AgentName.CLAUDE, makeToken()))
      .rejects.toBeInstanceOf(CopilotProviderError);
  });

  it('throws CopilotProviderError when family selectChatModels throws (non-timeout)', async () => {
    (vscode.lm.selectChatModels as jest.Mock)
      .mockRejectedValueOnce(new Error('api down')) // gpt-4o throws
      .mockRejectedValueOnce(new Error('api down')) // gpt-4 throws
      .mockRejectedValueOnce(new Error('api down')) // claude throws
      .mockRejectedValueOnce(new Error('api down')) // gemini throws
      .mockRejectedValueOnce(new CopilotProviderError('fallback also failed')); // fallback throws

    const provider = new CopilotProvider();
    await expect(provider.sendRequest(defaultOptions, AgentName.CLAUDE, makeToken()))
      .rejects.toBeInstanceOf(CopilotProviderError);
  });
});
