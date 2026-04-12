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

async function* toAsyncIterable(chunks: string[]): AsyncIterable<vscode.LanguageModelTextPart> {
  for (const chunk of chunks) {
    yield new vscode.LanguageModelTextPart(chunk);
  }
}

function makeModel(chunks: string[] = ['hello ', 'world'], throwOnSend?: Error) {
  return {
    sendRequest: jest.fn().mockImplementation(() => {
      if (throwOnSend) {
        throw throwOnSend;
      }
      return Promise.resolve({ stream: toAsyncIterable(chunks) });
    }),
  };
}

const defaultOptions = {
  systemPrompt: 'You are a developer.',
  userMessage: 'write tests',
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

  it('includes only enabled tool definitions when enabledTools is provided', async () => {
    const model = makeModel(['done']);
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);
    const provider = new CopilotProvider();

    await provider.sendRequest(
      { ...defaultOptions, onToolCall: jest.fn(), enabledTools: ['write_file', 'delete_file'] },
      AgentName.CLAUDE,
      makeToken(),
    );

    const toolDefs = (model.sendRequest as jest.Mock).mock.calls[0][1].tools as Array<{ name: string }>;
    expect(toolDefs.map((t) => t.name)).toEqual(['write_file', 'delete_file']);
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
    async function* cancellingStream(): AsyncIterable<vscode.LanguageModelTextPart> {
      yield new vscode.LanguageModelTextPart('first chunk');
      // Simulate cancellation after first chunk
      (token as { isCancellationRequested: boolean }).isCancellationRequested = true;
      yield new vscode.LanguageModelTextPart('second chunk');
    }
    const model = {
      sendRequest: jest.fn().mockResolvedValue({ stream: cancellingStream() }),
    };
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);
    const provider = new CopilotProvider();

    await expect(provider.sendRequest(defaultOptions, AgentName.CLAUDE, token))
      .rejects.toBeInstanceOf(vscode.CancellationError);
  });

  it('throws CancellationError when cancelled while waiting for stalled sendRequest', async () => {
    let cancelled = false;
    let cancelHandler: (() => void) | undefined;
    const token = {
      get isCancellationRequested() {
        return cancelled;
      },
      onCancellationRequested: jest.fn((cb: () => void) => {
        cancelHandler = cb;
        return { dispose: jest.fn() };
      }),
    } as unknown as vscode.CancellationToken;

    const model = {
      sendRequest: jest.fn().mockImplementation(() => new Promise(() => {})),
    };
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);
    const provider = new CopilotProvider();

    const runPromise = provider.sendRequest(defaultOptions, AgentName.CLAUDE, token);
    await new Promise((resolve) => setTimeout(resolve, 0));
    cancelled = true;
    cancelHandler?.();

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Timed out waiting for cancellation')), 120);
    });

    await expect(Promise.race([runPromise, timeoutPromise]))
      .rejects.toBeInstanceOf(vscode.CancellationError);
  });

  it('throws CancellationError when cancelled while waiting for stalled stream chunk', async () => {
    let cancelled = false;
    let cancelHandler: (() => void) | undefined;
    const token = {
      get isCancellationRequested() {
        return cancelled;
      },
      onCancellationRequested: jest.fn((cb: () => void) => {
        cancelHandler = cb;
        return { dispose: jest.fn() };
      }),
    } as unknown as vscode.CancellationToken;

    async function* stalledStream(): AsyncIterable<vscode.LanguageModelTextPart> {
      yield new vscode.LanguageModelTextPart('first chunk');
      await new Promise<void>(() => {});
    }

    const model = {
      sendRequest: jest.fn().mockResolvedValue({ stream: stalledStream() }),
    };
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);
    const provider = new CopilotProvider();

    const runPromise = provider.sendRequest(defaultOptions, AgentName.CLAUDE, token);
    await new Promise((resolve) => setTimeout(resolve, 0));
    cancelled = true;
    cancelHandler?.();

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Timed out waiting for cancellation')), 120);
    });

    await expect(Promise.race([runPromise, timeoutPromise]))
      .rejects.toBeInstanceOf(vscode.CancellationError);
  });

  it('aborts when the same disallowed tool call batch repeats', async () => {
    const model = {
      sendRequest: jest.fn().mockResolvedValue({
        stream: (async function* () {
          yield new vscode.LanguageModelToolCallPart('cmd1', 'run_command', { command: 'npm test' });
        })(),
      }),
    };
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);

    const onToolCall = jest.fn().mockResolvedValue({ id: 'cmd1', content: 'ok', isError: false });
    const provider = new CopilotProvider();

    await expect(
      provider.sendRequest(
        { ...defaultOptions, onToolCall, enabledTools: ['write_file', 'delete_file'] },
        AgentName.CLAUDE,
        makeToken(),
      ),
    ).rejects.toBeInstanceOf(CopilotProviderError);

    expect(onToolCall).not.toHaveBeenCalled();
    expect(model.sendRequest).toHaveBeenCalledTimes(2);
  });

  it('native LanguageModelToolCallPart run_command: dispatches and loops', async () => {
    let callCount = 0;
    const model = {
      sendRequest: jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          async function* toolStream() {
            yield new vscode.LanguageModelToolCallPart('cmd1', 'run_command', { command: 'npm test' });
          }
          return Promise.resolve({ stream: toolStream() });
        }
        return Promise.resolve({ stream: toAsyncIterable(['Tests passed.']) });
      }),
    };
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);

    const onToolCall = jest.fn().mockResolvedValue({ id: 'cmd1', content: 'Exit code: 0\nAll tests passed', isError: false });
    const provider = new CopilotProvider();
    const result = await provider.sendRequest(
      { ...defaultOptions, onToolCall },
      AgentName.CLAUDE,
      makeToken(),
    );

    expect(onToolCall).toHaveBeenCalledWith({ id: 'cmd1', name: 'run_command', command: 'npm test' });
    expect(result).toBe('Tests passed.');
  });

  it('wraps stream iteration errors as CopilotProviderError', async () => {
    async function* throwingStream(): AsyncIterable<vscode.LanguageModelTextPart> {
      yield new vscode.LanguageModelTextPart('partial');
      throw new Error('stream error');
    }
    const model = {
      sendRequest: jest.fn().mockResolvedValue({ stream: throwingStream() }),
    };
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);
    const provider = new CopilotProvider();

    await expect(provider.sendRequest(defaultOptions, AgentName.CLAUDE, makeToken()))
      .rejects.toBeInstanceOf(CopilotProviderError);
  });

  it('native LanguageModelToolCallPart read_file: dispatches and loops', async () => {
    let callCount = 0;
    const model = {
      sendRequest: jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          async function* toolStream() {
            yield new vscode.LanguageModelTextPart('Reading file...');
            yield new vscode.LanguageModelToolCallPart('call1', 'read_file', { path: 'src/app.ts' });
          }
          return Promise.resolve({ stream: toolStream() });
        }
        return Promise.resolve({ stream: toAsyncIterable(['File content loaded.']) });
      }),
    };
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);

    const onToolCall = jest.fn().mockResolvedValue({ id: 'call1', content: 'const x = 1;', isError: false });
    const provider = new CopilotProvider();
    const result = await provider.sendRequest(
      { ...defaultOptions, onToolCall },
      AgentName.CLAUDE,
      makeToken(),
    );

    expect(onToolCall).toHaveBeenCalledWith({ id: 'call1', name: 'read_file', filePath: 'src/app.ts' });
    // After the bug fix, text from all iterations is accumulated: first iteration emits
    // 'Reading file...' before the tool call, second iteration emits 'File content loaded.'
    expect(result).toBe('Reading file...File content loaded.');
    expect(model.sendRequest).toHaveBeenCalledTimes(2);
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

// ── XML tool call path ────────────────────────────────────────────────────────

describe('CopilotProvider — XML tool calls', () => {
  beforeEach(() => jest.clearAllMocks());

  it('XML read_file: parses path, strips XML from visible text, dispatches onToolCall', async () => {
    let callCount = 0;
    const model = {
      sendRequest: jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          const xml = 'Checking the file.\n\n<function_calls><invoke name="read_file"><parameter name="path">src/app.ts</parameter></invoke></function_calls>';
          return Promise.resolve({ stream: toAsyncIterable([xml]) });
        }
        return Promise.resolve({ stream: toAsyncIterable(['Done reading.']) });
      }),
    };
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);

    const onToolCall = jest.fn().mockResolvedValue({ id: 'src/app.ts', content: 'const x = 1;', isError: false });
    const provider = new CopilotProvider();
    const result = await provider.sendRequest({ ...defaultOptions, onToolCall }, AgentName.CLAUDE, makeToken());

    expect(onToolCall).toHaveBeenCalledWith({ id: 'src/app.ts', name: 'read_file', filePath: 'src/app.ts' });
    // After the bug fix, text from all iterations is accumulated: first iteration contributes
    // the clean text before the XML tag ('Checking the file.'), second contributes 'Done reading.'
    expect(result).toBe('Checking the file.Done reading.');
    // XML should not appear in final text
    expect(result).not.toContain('<function_calls>');
  });

  it('XML run_command: parses command and dispatches onToolCall', async () => {
    let callCount = 0;
    const model = {
      sendRequest: jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          const xml = '<function_calls><invoke name="run_command"><parameter name="command">npm test</parameter></invoke></function_calls>';
          return Promise.resolve({ stream: toAsyncIterable([xml]) });
        }
        return Promise.resolve({ stream: toAsyncIterable(['Tests executed.']) });
      }),
    };
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);

    const onToolCall = jest.fn().mockResolvedValue({ id: 'npm test', content: 'All passed', isError: false });
    const provider = new CopilotProvider();
    const result = await provider.sendRequest({ ...defaultOptions, onToolCall }, AgentName.CLAUDE, makeToken());

    expect(onToolCall).toHaveBeenCalledWith({ id: 'npm test', name: 'run_command', command: 'npm test' });
    expect(result).toBe('Tests executed.');
  });

  it('XML mixed: read_file and run_command in same response both dispatched', async () => {
    let callCount = 0;
    const model = {
      sendRequest: jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          const xml = 'Analyzing.\n\n<function_calls>'
            + '<invoke name="read_file"><parameter name="path">src/a.ts</parameter></invoke>'
            + '<invoke name="run_command"><parameter name="command">npm run build</parameter></invoke>'
            + '</function_calls>';
          return Promise.resolve({ stream: toAsyncIterable([xml]) });
        }
        return Promise.resolve({ stream: toAsyncIterable(['All done.']) });
      }),
    };
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);

    const onToolCall = jest.fn().mockResolvedValue({ id: 'x', content: 'ok', isError: false });
    const provider = new CopilotProvider();
    await provider.sendRequest({ ...defaultOptions, onToolCall }, AgentName.CLAUDE, makeToken());

    expect(onToolCall).toHaveBeenCalledTimes(2);
    const calls = onToolCall.mock.calls.map((c: unknown[]) => (c[0] as { name: string }).name);
    expect(calls).toContain('read_file');
    expect(calls).toContain('run_command');
  });

  it('XML with no recognized invoke tags is treated as plain text (not dispatched)', async () => {
    const model = makeModel(['Some text with <function_calls><invoke name="unknown_tool"></invoke></function_calls>']);
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);

    const onToolCall = jest.fn();
    const provider = new CopilotProvider();
    // The provider should either skip unknown tools or return the text as-is
    // Either way onToolCall should not be called for unknown tool names
    await provider.sendRequest({ ...defaultOptions, onToolCall }, AgentName.CLAUDE, makeToken()).catch(() => {});
    // Unknown tool name has no path/command parameter — extractXmlToolCalls returns empty array
    // so the text is treated as a plain text response (may throw empty if XML stripped leaves nothing)
    expect(onToolCall).not.toHaveBeenCalled();
  });
});

// ── Bug fixes: text accumulation across tool-call iterations ──────────────────

describe('CopilotProvider — Bug fix: finalText accumulation (native tool calls)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('concatenates text from two native tool-call iterations', async () => {
    let callCount = 0;
    const model = {
      sendRequest: jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          async function* stream1() {
            yield new vscode.LanguageModelTextPart('Iteration one. ');
            yield new vscode.LanguageModelToolCallPart('tc1', 'read_file', { path: 'src/a.ts' });
          }
          return Promise.resolve({ stream: stream1() });
        }
        return Promise.resolve({ stream: toAsyncIterable(['Iteration two.']) });
      }),
    };
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);

    const onToolCall = jest.fn().mockResolvedValue({ id: 'tc1', content: 'file body', isError: false });
    const provider = new CopilotProvider();
    const result = await provider.sendRequest(
      { ...defaultOptions, onToolCall },
      AgentName.CLAUDE,
      makeToken(),
    );

    expect(result).toBe('Iteration one. Iteration two.');
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(model.sendRequest).toHaveBeenCalledTimes(2);
  });

  it('handles first iteration with no text (empty prefix) followed by text in second iteration', async () => {
    let callCount = 0;
    const model = {
      sendRequest: jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          async function* stream1() {
            // No text, only a tool call
            yield new vscode.LanguageModelToolCallPart('tc1', 'run_command', { command: 'npm install' });
          }
          return Promise.resolve({ stream: stream1() });
        }
        return Promise.resolve({ stream: toAsyncIterable(['Install complete.']) });
      }),
    };
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);

    const onToolCall = jest.fn().mockResolvedValue({ id: 'tc1', content: 'ok', isError: false });
    const provider = new CopilotProvider();
    const result = await provider.sendRequest(
      { ...defaultOptions, onToolCall },
      AgentName.CLAUDE,
      makeToken(),
    );

    expect(result).toBe('Install complete.');
  });

  it('concatenates text across three native tool-call iterations', async () => {
    let callCount = 0;
    const model = {
      sendRequest: jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          async function* s1() {
            yield new vscode.LanguageModelTextPart('A');
            yield new vscode.LanguageModelToolCallPart('t1', 'read_file', { path: 'a.ts' });
          }
          return Promise.resolve({ stream: s1() });
        }
        if (callCount === 2) {
          async function* s2() {
            yield new vscode.LanguageModelTextPart('B');
            yield new vscode.LanguageModelToolCallPart('t2', 'run_command', { command: 'ls' });
          }
          return Promise.resolve({ stream: s2() });
        }
        return Promise.resolve({ stream: toAsyncIterable(['C']) });
      }),
    };
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);

    const onToolCall = jest.fn().mockResolvedValue({ id: 'x', content: 'data', isError: false });
    const provider = new CopilotProvider();
    const result = await provider.sendRequest(
      { ...defaultOptions, onToolCall },
      AgentName.CLAUDE,
      makeToken(),
    );

    expect(result).toBe('ABC');
    expect(onToolCall).toHaveBeenCalledTimes(2);
    expect(model.sendRequest).toHaveBeenCalledTimes(3);
  });
});

describe('CopilotProvider — Bug fix: finalText accumulation (XML tool calls)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('concatenates clean text prefix from two XML tool-call iterations', async () => {
    let callCount = 0;
    const model = {
      sendRequest: jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          const xml = 'Looking at the code.\n\n<function_calls><invoke name="read_file"><parameter name="path">src/a.ts</parameter></invoke></function_calls>';
          return Promise.resolve({ stream: toAsyncIterable([xml]) });
        }
        return Promise.resolve({ stream: toAsyncIterable(['Analysis done.']) });
      }),
    };
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);

    const onToolCall = jest.fn().mockResolvedValue({ id: 'src/a.ts', content: 'const x = 1;', isError: false });
    const provider = new CopilotProvider();
    const result = await provider.sendRequest(
      { ...defaultOptions, onToolCall },
      AgentName.CLAUDE,
      makeToken(),
    );

    // First iteration contributes the clean text before the XML, second contributes the final answer
    expect(result).toContain('Analysis done.');
    expect(result).not.toContain('<function_calls>');
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(model.sendRequest).toHaveBeenCalledTimes(2);
  });

  it('concatenates text across two XML iterations where first has prefix text and second adds final answer', async () => {
    let callCount = 0;
    const model = {
      sendRequest: jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          const xml = 'Prefix text. <function_calls><invoke name="run_command"><parameter name="command">npm test</parameter></invoke></function_calls>';
          return Promise.resolve({ stream: toAsyncIterable([xml]) });
        }
        return Promise.resolve({ stream: toAsyncIterable(['All tests passed.']) });
      }),
    };
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);

    const onToolCall = jest.fn().mockResolvedValue({ id: 'npm test', content: 'ok', isError: false });
    const provider = new CopilotProvider();
    const result = await provider.sendRequest(
      { ...defaultOptions, onToolCall },
      AgentName.CLAUDE,
      makeToken(),
    );

    expect(result).toContain('Prefix text.');
    expect(result).toContain('All tests passed.');
  });
});

// ── Bug fixes: cancellation between tool-call iterations ──────────────────────

describe('CopilotProvider — Bug fix: cancellation between tool-call iterations (native)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('throws CancellationError and does NOT call onToolCall again after token fires', async () => {
    const token = makeToken(); // starts uncancelled
    let callCount = 0;
    const model = {
      sendRequest: jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          async function* stream1() {
            yield new vscode.LanguageModelTextPart('Step one. ');
            yield new vscode.LanguageModelToolCallPart('tc1', 'read_file', { path: 'a.ts' });
          }
          return Promise.resolve({ stream: stream1() });
        }
        // Should never reach a second sendRequest
        return Promise.resolve({ stream: toAsyncIterable(['Should not appear.']) });
      }),
    };
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);

    const onToolCall = jest.fn().mockImplementation(async () => {
      // Cancel the token right after the first tool call executes
      (token as { isCancellationRequested: boolean }).isCancellationRequested = true;
      return { id: 'tc1', content: 'file body', isError: false };
    });

    const provider = new CopilotProvider();
    await expect(
      provider.sendRequest({ ...defaultOptions, onToolCall }, AgentName.CLAUDE, token),
    ).rejects.toBeInstanceOf(vscode.CancellationError);

    // onToolCall was called once; no second HTTP request
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(model.sendRequest).toHaveBeenCalledTimes(1);
  });

  it('throws CancellationError immediately when token is pre-cancelled (does not call onToolCall)', async () => {
    const token = makeToken(true); // already cancelled
    let callCount = 0;
    const model = {
      sendRequest: jest.fn().mockImplementation(() => {
        callCount++;
        async function* stream1() {
          yield new vscode.LanguageModelToolCallPart('tc1', 'read_file', { path: 'a.ts' });
        }
        return Promise.resolve({ stream: stream1() });
      }),
    };
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);

    const onToolCall = jest.fn();
    const provider = new CopilotProvider();
    await expect(
      provider.sendRequest({ ...defaultOptions, onToolCall }, AgentName.CLAUDE, token),
    ).rejects.toBeInstanceOf(vscode.CancellationError);

    expect(onToolCall).not.toHaveBeenCalled();
  });
});

describe('CopilotProvider — Bug fix: cancellation between tool-call iterations (XML)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('throws CancellationError and does NOT loop again when token fires in XML path', async () => {
    const token = makeToken();
    let callCount = 0;
    const model = {
      sendRequest: jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          const xml = '<function_calls><invoke name="run_command"><parameter name="command">npm build</parameter></invoke></function_calls>';
          return Promise.resolve({ stream: toAsyncIterable([xml]) });
        }
        return Promise.resolve({ stream: toAsyncIterable(['Should not appear.']) });
      }),
    };
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);

    const onToolCall = jest.fn().mockImplementation(async () => {
      (token as { isCancellationRequested: boolean }).isCancellationRequested = true;
      return { id: 'npm build', content: 'built', isError: false };
    });

    const provider = new CopilotProvider();
    await expect(
      provider.sendRequest({ ...defaultOptions, onToolCall }, AgentName.CLAUDE, token),
    ).rejects.toBeInstanceOf(vscode.CancellationError);

    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(model.sendRequest).toHaveBeenCalledTimes(1);
  });
});

// ── Model tier ────────────────────────────────────────────────────────────────

describe('CopilotProvider — model tier', () => {
  beforeEach(() => jest.clearAllMocks());

  it('heavy tier (default) — claude agent queries claude family first', async () => {
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([makeModel(['response'])]);
    const provider = new CopilotProvider();
    await provider.sendRequest(defaultOptions, AgentName.CLAUDE, makeToken());
    const firstCall = (vscode.lm.selectChatModels as jest.Mock).mock.calls[0][0];
    expect(firstCall.family).toBe('claude');
  });

  it('light tier — claude agent still queries claude family first', async () => {
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([makeModel(['response'])]);
    const provider = new CopilotProvider();
    provider.setModelTier('light');
    await provider.sendRequest(defaultOptions, AgentName.CLAUDE, makeToken());
    const firstCall = (vscode.lm.selectChatModels as jest.Mock).mock.calls[0][0];
    expect(firstCall.family).toBe('claude');
  });

  it('gpt agent in light tier queries gpt-4o-mini family first', async () => {
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([makeModel(['response'])]);
    const provider = new CopilotProvider();
    provider.setModelTier('light');
    await provider.sendRequest(defaultOptions, AgentName.GPT, makeToken());
    const firstCall = (vscode.lm.selectChatModels as jest.Mock).mock.calls[0][0];
    expect(firstCall.family).toBe('gpt-4o-mini');
  });

  it('switching tier invalidates model cache and re-queries', async () => {
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([makeModel(['response'])]);
    const provider = new CopilotProvider();

    // First request — caches heavy model
    await provider.sendRequest(defaultOptions, AgentName.CLAUDE, makeToken());
    expect(vscode.lm.selectChatModels).toHaveBeenCalledTimes(1);

    // Switch tier — cache should be invalidated
    provider.setModelTier('light');
    await provider.sendRequest(defaultOptions, AgentName.CLAUDE, makeToken());
    expect(vscode.lm.selectChatModels).toHaveBeenCalledTimes(2);
    const secondCall = (vscode.lm.selectChatModels as jest.Mock).mock.calls[1][0];
    expect(secondCall.family).toBe('claude');
  });

  it('setting same tier twice does not invalidate cache', async () => {
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([makeModel(['response'])]);
    const provider = new CopilotProvider();
    provider.setModelTier('heavy');

    await provider.sendRequest(defaultOptions, AgentName.CLAUDE, makeToken());
    provider.setModelTier('heavy'); // same tier — no invalidation
    await provider.sendRequest(defaultOptions, AgentName.CLAUDE, makeToken());

    // selectChatModels called only once (cache hit on second request)
    expect(vscode.lm.selectChatModels).toHaveBeenCalledTimes(1);
  });

  it('light tier claude chain falls back to gpt-4o-mini then gpt-4o when claude unavailable', async () => {
    (vscode.lm.selectChatModels as jest.Mock)
      .mockResolvedValueOnce([]) // claude — empty
      .mockResolvedValueOnce([]) // gpt-4o-mini — empty
      .mockResolvedValue([makeModel(['fallback'])]); // gpt-4o and beyond
    const provider = new CopilotProvider();
    provider.setModelTier('light');
    const result = await provider.sendRequest(defaultOptions, AgentName.CLAUDE, makeToken());
    expect(result).toBe('fallback');
    expect((vscode.lm.selectChatModels as jest.Mock).mock.calls[0][0].family).toBe('claude');
    expect((vscode.lm.selectChatModels as jest.Mock).mock.calls[1][0].family).toBe('gpt-4o-mini');
    expect((vscode.lm.selectChatModels as jest.Mock).mock.calls[2][0].family).toBe('gpt-4o');
  });
});
