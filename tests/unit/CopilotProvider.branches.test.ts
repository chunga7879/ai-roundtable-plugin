/**
 * Additional branch coverage tests for CopilotProvider.
 *
 * Covers: selectModel with preferredFamily (found/not-found), light vs heavy
 * model tier families, fallback when all family queries fail, timeout path,
 * setPreferredFamily cache invalidation, setModelTier cache invalidation,
 * sendRequest with tool calls (native LanguageModelToolCallPart), XML tool calls,
 * cancellation token handling, conversation history building.
 */
import * as vscode from 'vscode';
import { CopilotProvider, CopilotProviderError } from '../../src/agents/CopilotProvider';
import { AgentName } from '../../src/types';

function makeToken(cancelled = false): vscode.CancellationToken {
  return {
    isCancellationRequested: cancelled,
    onCancellationRequested: jest.fn(),
  } as unknown as vscode.CancellationToken;
}

async function* streamOf(...chunks: string[]): AsyncIterable<vscode.LanguageModelTextPart> {
  for (const chunk of chunks) {
    yield new vscode.LanguageModelTextPart(chunk);
  }
}

function makeModel(chunks: string[] = ['response'], throwOnSend?: Error) {
  return {
    sendRequest: jest.fn().mockImplementation(() => {
      if (throwOnSend) throw throwOnSend;
      return Promise.resolve({ stream: streamOf(...chunks) });
    }),
  };
}

const defaultOpts = {
  systemPrompt: 'You are a developer.',
  userMessage: 'Write tests',
};

// ── setPreferredFamily — cache invalidation ───────────────────────────────────

describe('CopilotProvider.setPreferredFamily', () => {
  beforeEach(() => jest.clearAllMocks());

  it('clears cached model when family changes', async () => {
    const model = makeModel(['first']);
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);

    const provider = new CopilotProvider();
    await provider.sendRequest(defaultOpts, AgentName.CLAUDE, makeToken());

    // Change family → cache invalidated
    provider.setPreferredFamily('gpt-4o');
    const selectMock = vscode.lm.selectChatModels as jest.Mock;
    const callsBefore = selectMock.mock.calls.length;

    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);
    await provider.sendRequest(defaultOpts, AgentName.CLAUDE, makeToken());

    expect(selectMock.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('does not invalidate cache when family is set to same value', async () => {
    const model = makeModel(['same']);
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);

    const provider = new CopilotProvider();
    provider.setPreferredFamily('gpt-4o');
    await provider.sendRequest(defaultOpts, AgentName.CLAUDE, makeToken());

    const selectMock = vscode.lm.selectChatModels as jest.Mock;
    const callsBefore = selectMock.mock.calls.length;

    // Setting the same family again should not invalidate cache
    provider.setPreferredFamily('gpt-4o');
    await provider.sendRequest(defaultOpts, AgentName.CLAUDE, makeToken());

    // Model cache still valid: no new selectChatModels call
    expect(selectMock.mock.calls.length).toBe(callsBefore);
  });
});

// ── setModelTier — cache invalidation ────────────────────────────────────────

describe('CopilotProvider.setModelTier', () => {
  beforeEach(() => jest.clearAllMocks());

  it('clears cached model when tier changes', async () => {
    const model = makeModel(['heavy response']);
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);

    const provider = new CopilotProvider(); // default tier = heavy
    await provider.sendRequest(defaultOpts, AgentName.CLAUDE, makeToken());

    const selectMock = vscode.lm.selectChatModels as jest.Mock;
    const callsBefore = selectMock.mock.calls.length;

    provider.setModelTier('light');
    await provider.sendRequest(defaultOpts, AgentName.CLAUDE, makeToken());

    expect(selectMock.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('does not invalidate cache when tier is set to same value', async () => {
    const model = makeModel(['response']);
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);

    const provider = new CopilotProvider();
    provider.setModelTier('heavy'); // default is heavy
    await provider.sendRequest(defaultOpts, AgentName.CLAUDE, makeToken());

    const selectMock = vscode.lm.selectChatModels as jest.Mock;
    const callsBefore = selectMock.mock.calls.length;

    provider.setModelTier('heavy'); // same value
    await provider.sendRequest(defaultOpts, AgentName.CLAUDE, makeToken());

    expect(selectMock.mock.calls.length).toBe(callsBefore);
  });
});

// ── configureRouting — per-agent family/tier ────────────────────────────────

describe('CopilotProvider.configureRouting', () => {
  beforeEach(() => jest.clearAllMocks());

  it('routes each agent to its configured family override', async () => {
    (vscode.lm.selectChatModels as jest.Mock).mockImplementation(({ family }: { family?: string }) => {
      if (family === 'claude') return Promise.resolve([makeModel(['claude-family'])]);
      if (family === 'gpt-4o') return Promise.resolve([makeModel(['default-family'])]);
      return Promise.resolve([]);
    });

    const provider = new CopilotProvider();
    provider.configureRouting({
      defaultFamily: 'gpt-4o',
      defaultTier: 'heavy',
      familyByAgent: { claude: 'claude' },
    });

    const claudeResult = await provider.sendRequest(defaultOpts, AgentName.CLAUDE, makeToken());
    const gptResult = await provider.sendRequest(defaultOpts, AgentName.GPT, makeToken());

    expect(claudeResult).toBe('claude-family');
    expect(gptResult).toBe('default-family');
    expect(vscode.lm.selectChatModels).toHaveBeenCalledWith(
      expect.objectContaining({ family: 'claude' }),
    );
    expect(vscode.lm.selectChatModels).toHaveBeenCalledWith(
      expect.objectContaining({ family: 'gpt-4o' }),
    );
  });

  it('honors per-agent tier override (light) over default heavy tier', async () => {
    (vscode.lm.selectChatModels as jest.Mock).mockImplementation(({ family }: { family?: string }) => {
      if (family === 'claude') return Promise.resolve([makeModel(['light-tier'])]);
      if (family === 'gpt-4o') return Promise.resolve([makeModel(['heavy-tier'])]);
      return Promise.resolve([]);
    });

    const provider = new CopilotProvider();
    provider.configureRouting({
      defaultTier: 'heavy',
      tierByAgent: { claude: 'light' },
    });

    const claudeResult = await provider.sendRequest(defaultOpts, AgentName.CLAUDE, makeToken());
    const gptResult = await provider.sendRequest(defaultOpts, AgentName.GPT, makeToken());

    expect(claudeResult).toBe('light-tier');
    expect(gptResult).toBe('heavy-tier');
    expect(vscode.lm.selectChatModels).toHaveBeenCalledWith(
      expect.objectContaining({ family: 'claude' }),
    );
  });

  it('fails fast in strict mode when configured family is unavailable', async () => {
    (vscode.lm.selectChatModels as jest.Mock).mockImplementation(({ family }: { family?: string }) => {
      if (family === 'gpt-4') return Promise.resolve([]);
      return Promise.resolve([makeModel(['fallback'])]);
    });

    const provider = new CopilotProvider();
    provider.configureRouting({
      defaultTier: 'heavy',
      familyByAgent: { claude: 'gpt-4' },
      strictFamilyMatch: true,
    });

    await expect(provider.sendRequest(defaultOpts, AgentName.CLAUDE, makeToken()))
      .rejects.toBeInstanceOf(CopilotProviderError);
  });
});

// ── selectModel — preferredFamily found ───────────────────────────────────────

describe('CopilotProvider.selectModel — preferredFamily', () => {
  beforeEach(() => jest.clearAllMocks());

  it('uses preferred family when available', async () => {
    const model = makeModel(['from preferred family']);
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);

    const provider = new CopilotProvider();
    provider.setPreferredFamily('claude');

    const result = await provider.sendRequest(defaultOpts, AgentName.CLAUDE, makeToken());
    expect(result).toBe('from preferred family');

    // Should have queried with the preferred family
    expect(vscode.lm.selectChatModels).toHaveBeenCalledWith(
      expect.objectContaining({ family: 'claude' }),
    );
  });

  it('falls through to auto selection when preferred family returns empty', async () => {
    const model = makeModel(['from auto selection']);
    (vscode.lm.selectChatModels as jest.Mock)
      .mockImplementation(({ family }: { family?: string }) => {
        if (family === 'nonexistent') return Promise.resolve([]);
        return Promise.resolve([model]);
      });

    const provider = new CopilotProvider();
    provider.setPreferredFamily('nonexistent');

    const result = await provider.sendRequest(defaultOpts, AgentName.CLAUDE, makeToken());
    expect(result).toBe('from auto selection');
  });

  it('rethrows CopilotProviderError from preferred family query', async () => {
    (vscode.lm.selectChatModels as jest.Mock)
      .mockRejectedValue(new CopilotProviderError('Timed out'));

    const provider = new CopilotProvider();
    provider.setPreferredFamily('gpt-4o');

    await expect(provider.sendRequest(defaultOpts, AgentName.CLAUDE, makeToken())).rejects.toBeInstanceOf(CopilotProviderError);
  });

  it('ignores non-CopilotProviderError from preferred family query and falls through', async () => {
    const model = makeModel(['fallback model response']);
    let callCount = 0;
    (vscode.lm.selectChatModels as jest.Mock).mockImplementation(({ family }: { family?: string }) => {
      callCount++;
      if (family === 'preferred-family') {
        return Promise.reject(new Error('temporary error'));
      }
      return Promise.resolve([model]);
    });

    const provider = new CopilotProvider();
    provider.setPreferredFamily('preferred-family');

    const result = await provider.sendRequest(defaultOpts, AgentName.CLAUDE, makeToken());
    expect(result).toBe('fallback model response');
  });
});

// ── selectModel — light vs heavy families ─────────────────────────────────────

describe('CopilotProvider.selectModel — light tier', () => {
  beforeEach(() => jest.clearAllMocks());

  it('claude agent tries claude family first in light tier', async () => {
    const model = makeModel(['light response']);
    (vscode.lm.selectChatModels as jest.Mock).mockImplementation(({ family }: { family?: string }) => {
      if (family === 'claude') return Promise.resolve([model]);
      return Promise.resolve([]);
    });

    const provider = new CopilotProvider();
    provider.setModelTier('light');

    const result = await provider.sendRequest(defaultOpts, AgentName.CLAUDE, makeToken());
    expect(result).toBe('light response');
    expect(vscode.lm.selectChatModels).toHaveBeenCalledWith(
      expect.objectContaining({ family: 'claude' }),
    );
  });
});

// ── selectModel — all families fail, fallback query ───────────────────────────

describe('CopilotProvider.selectModel — fallback', () => {
  beforeEach(() => jest.clearAllMocks());

  it('uses any available model when all family queries return empty', async () => {
    const model = makeModel(['fallback response']);
    (vscode.lm.selectChatModels as jest.Mock).mockImplementation(({ family }: { family?: string }) => {
      if (family) return Promise.resolve([]);
      return Promise.resolve([model]); // fallback: vendor-only query
    });

    const provider = new CopilotProvider();
    const result = await provider.sendRequest(defaultOpts, AgentName.CLAUDE, makeToken());
    expect(result).toBe('fallback response');
  });

  it('throws CopilotProviderError when all models are unavailable', async () => {
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([]);

    const provider = new CopilotProvider();
    await expect(provider.sendRequest(defaultOpts, AgentName.CLAUDE, makeToken())).rejects.toBeInstanceOf(CopilotProviderError);
  });

  it('throws CopilotProviderError when fallback query throws', async () => {
    (vscode.lm.selectChatModels as jest.Mock).mockImplementation(({ family }: { family?: string }) => {
      if (family) return Promise.resolve([]);
      return Promise.reject(new Error('network error'));
    });

    const provider = new CopilotProvider();
    await expect(provider.sendRequest(defaultOpts, AgentName.CLAUDE, makeToken())).rejects.toBeInstanceOf(CopilotProviderError);
  });
});

// ── sendRequest — with tool callbacks ────────────────────────────────────────

describe('CopilotProvider.sendRequest — with onToolCall', () => {
  beforeEach(() => jest.clearAllMocks());

  it('includes tool definitions when onToolCall is provided', async () => {
    const model = makeModel(['result with tools']);
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);

    const provider = new CopilotProvider();
    const onToolCall = jest.fn();
    await provider.sendRequest(
      { ...defaultOpts, onToolCall },
      AgentName.CLAUDE,
      makeToken(),
    );

    // sendRequest should have been called — tools were included
    expect(model.sendRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tools: expect.arrayContaining([expect.objectContaining({ name: 'read_file' })]) }),
      expect.anything(),
    );
  });

  it('does not include tool definitions when onToolCall is not provided', async () => {
    const model = makeModel(['result without tools']);
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);

    const provider = new CopilotProvider();
    await provider.sendRequest(defaultOpts, AgentName.CLAUDE, makeToken());

    expect(model.sendRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tools: [] }),
      expect.anything(),
    );
  });

  it('calls onToolCall when a LanguageModelToolCallPart is received', async () => {
    const toolCallPart = new vscode.LanguageModelToolCallPart('call1', 'read_file', { path: 'src/app.ts' });
    const model = {
      sendRequest: jest.fn().mockResolvedValue({
        stream: (async function* () {
          yield toolCallPart;
          yield new vscode.LanguageModelTextPart('done');
        })(),
      }),
    };
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);

    const onToolCall = jest.fn().mockResolvedValue({ id: 'call1', content: 'file content', isError: false });

    const provider = new CopilotProvider();
    await provider.sendRequest(
      { ...defaultOpts, onToolCall },
      AgentName.CLAUDE,
      makeToken(),
    );

    expect(onToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'read_file', filePath: 'src/app.ts' }),
    );
  });
});

// ── sendRequest — XML tool call parsing ───────────────────────────────────────

describe('CopilotProvider.sendRequest — XML tool calls', () => {
  beforeEach(() => jest.clearAllMocks());

  it('parses XML read_file tool calls from text chunks', async () => {
    const xmlChunk = `<function_calls><invoke name="read_file"><parameter name="path">src/auth.ts</parameter></invoke></function_calls>`;
    const model = {
      sendRequest: jest.fn().mockResolvedValue({
        stream: (async function* () {
          yield new vscode.LanguageModelTextPart(xmlChunk);
          yield new vscode.LanguageModelTextPart('response after tool');
        })(),
      }),
    };
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);

    const onToolCall = jest.fn().mockResolvedValue({ id: 'xml1', content: 'auth content', isError: false });

    const provider = new CopilotProvider();
    await provider.sendRequest(
      { ...defaultOpts, onToolCall },
      AgentName.CLAUDE,
      makeToken(),
    );

    expect(onToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'read_file', filePath: 'src/auth.ts' }),
    );
  });

  it('parses XML run_command tool calls from text chunks', async () => {
    const xmlChunk = `<function_calls><invoke name="run_command"><parameter name="command">npm test</parameter></invoke></function_calls>`;
    const model = {
      sendRequest: jest.fn().mockResolvedValue({
        stream: (async function* () {
          yield new vscode.LanguageModelTextPart(xmlChunk);
          yield new vscode.LanguageModelTextPart('ran');
        })(),
      }),
    };
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);

    const onToolCall = jest.fn().mockResolvedValue({ id: 'cmd1', content: 'output', isError: false });

    const provider = new CopilotProvider();
    await provider.sendRequest(
      { ...defaultOpts, onToolCall },
      AgentName.CLAUDE,
      makeToken(),
    );

    expect(onToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'run_command', command: 'npm test' }),
    );
  });

  it('parses XML write_file tool calls from text chunks', async () => {
    const xmlChunk = `<function_calls><invoke name="write_file"><parameter name="path">src/out.ts</parameter><parameter name="content">export const x = 1;</parameter></invoke></function_calls>`;
    const model = {
      sendRequest: jest.fn().mockResolvedValue({
        stream: (async function* () {
          yield new vscode.LanguageModelTextPart(xmlChunk);
          yield new vscode.LanguageModelTextPart('written');
        })(),
      }),
    };
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);

    const onToolCall = jest.fn().mockResolvedValue({ id: 'w1', content: 'written', isError: false });

    const provider = new CopilotProvider();
    await provider.sendRequest(
      { ...defaultOpts, onToolCall },
      AgentName.CLAUDE,
      makeToken(),
    );

    expect(onToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'write_file', filePath: 'src/out.ts' }),
    );
  });
});

// ── sendRequest — onChunk streaming callback ──────────────────────────────────

describe('CopilotProvider.sendRequest — onChunk', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls onChunk for each text part', async () => {
    const model = makeModel(['chunk1', 'chunk2', 'chunk3']);
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);

    const chunks: string[] = [];
    const provider = new CopilotProvider();
    await provider.sendRequest(
      { ...defaultOpts, onChunk: (c) => chunks.push(c) },
      AgentName.CLAUDE,
      makeToken(),
    );

    expect(chunks).toEqual(['chunk1', 'chunk2', 'chunk3']);
  });
});

// ── sendRequest — conversation history ───────────────────────────────────────

describe('CopilotProvider.sendRequest — conversation history', () => {
  beforeEach(() => jest.clearAllMocks());

  it('includes prior turns as history messages', async () => {
    const model = makeModel(['with history']);
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);

    const provider = new CopilotProvider();
    await provider.sendRequest(
      {
        ...defaultOpts,
        conversationHistory: [
          { role: 'user', content: 'Prior user turn' },
          { role: 'assistant', content: 'Prior assistant turn' },
        ],
      },
      AgentName.CLAUDE,
      makeToken(),
    );

    expect(model.sendRequest).toHaveBeenCalled();
    const [messages] = (model.sendRequest as jest.Mock).mock.calls[0];
    // History turns should be before the current user message
    expect(messages.length).toBeGreaterThanOrEqual(3);
  });
});

// ── sendRequest — model throws error ─────────────────────────────────────────

describe('CopilotProvider.sendRequest — model errors', () => {
  beforeEach(() => jest.clearAllMocks());

  it('wraps model sendRequest error in CopilotProviderError', async () => {
    const model = makeModel([], new Error('model API down'));
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);

    const provider = new CopilotProvider();
    await expect(provider.sendRequest(defaultOpts, AgentName.CLAUDE, makeToken())).rejects.toBeInstanceOf(CopilotProviderError);
  });

  it('rethrows CancellationError directly', async () => {
    const model = {
      sendRequest: jest.fn().mockImplementation(() => {
        throw new vscode.CancellationError();
      }),
    };
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);

    const provider = new CopilotProvider();
    await expect(provider.sendRequest(defaultOpts, AgentName.CLAUDE, makeToken())).rejects.toBeInstanceOf(vscode.CancellationError);
  });
});

// ── selectModel — selectWithTimeout timeout (preferred family) ────────────────

describe('CopilotProvider.selectModel — timeout on preferred family', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });
  afterEach(() => jest.useRealTimers());

  it('throws CopilotProviderError when preferred family selection times out', async () => {
    // Never resolves → timeout fires after MODEL_SELECTION_TIMEOUT_MS (30s)
    (vscode.lm.selectChatModels as jest.Mock).mockReturnValue(new Promise(() => {}));

    const provider = new CopilotProvider();
    provider.setPreferredFamily('claude-opus');

    const resultPromise = provider.sendRequest(defaultOpts, AgentName.CLAUDE, makeToken());
    // Attach rejection handler BEFORE advancing timers to avoid unhandled rejection
    const expectation = expect(resultPromise).rejects.toBeInstanceOf(CopilotProviderError);
    await jest.advanceTimersByTimeAsync(31_000);
    await expectation;
  });
});

// ── selectModel — selectWithTimeout timeout (family loop) ─────────────────────

describe('CopilotProvider.selectModel — timeout in family loop', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });
  afterEach(() => jest.useRealTimers());

  it('throws CopilotProviderError when family loop selection times out', async () => {
    // No preferred family → goes through COPILOT_HEAVY_FAMILIES loop, each times out
    (vscode.lm.selectChatModels as jest.Mock).mockReturnValue(new Promise(() => {}));

    const provider = new CopilotProvider(); // no preferred family
    const resultPromise = provider.sendRequest(defaultOpts, AgentName.CLAUDE, makeToken());
    const expectation = expect(resultPromise).rejects.toBeInstanceOf(CopilotProviderError);
    await jest.advanceTimersByTimeAsync(31_000);
    await expectation;
  });
});

// ── sendRequest — native tool calls: cancellation mid-loop ───────────────────

describe('CopilotProvider.sendRequest — native tool call loop cancellation', () => {
  beforeEach(() => jest.clearAllMocks());

  it('throws CancellationError when token fires between tool call rounds', async () => {
    const token = { isCancellationRequested: false, onCancellationRequested: jest.fn() };

    const model = {
      sendRequest: jest.fn().mockResolvedValue({
        stream: (async function* () {
          yield new vscode.LanguageModelToolCallPart('c1', 'read_file', { path: 'src/app.ts' });
        })(),
      }),
    };
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);

    const onToolCall = jest.fn().mockImplementation(async () => {
      token.isCancellationRequested = true;
      return { id: 'c1', content: 'file content', isError: false };
    });

    const provider = new CopilotProvider();
    await expect(
      provider.sendRequest(
        { ...defaultOpts, onToolCall },
        AgentName.CLAUDE,
        token as unknown as import('vscode').CancellationToken,
      ),
    ).rejects.toBeInstanceOf(vscode.CancellationError);
  });
});

// ── sendRequest — XML tool calls: cancellation mid-loop ──────────────────────

describe('CopilotProvider.sendRequest — XML tool call cancellation', () => {
  beforeEach(() => jest.clearAllMocks());

  it('throws CancellationError when token fires in XML tool call path', async () => {
    const token = { isCancellationRequested: false, onCancellationRequested: jest.fn() };

    const xmlBody = '<function_calls><invoke name="read_file"><parameter name="path">src/app.ts</parameter></invoke></function_calls>';
    const model = {
      sendRequest: jest.fn().mockResolvedValue({
        stream: (async function* () {
          yield new vscode.LanguageModelTextPart(xmlBody);
        })(),
      }),
    };
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);

    const onToolCall = jest.fn().mockImplementation(async () => {
      token.isCancellationRequested = true;
      return { id: 'x1', content: 'file content', isError: false };
    });

    const provider = new CopilotProvider();
    await expect(
      provider.sendRequest(
        { ...defaultOpts, onToolCall },
        AgentName.CLAUDE,
        token as unknown as import('vscode').CancellationToken,
      ),
    ).rejects.toBeInstanceOf(vscode.CancellationError);
  });
});

// ── invalidateModelCache ──────────────────────────────────────────────────────

describe('CopilotProvider.invalidateModelCache', () => {
  beforeEach(() => jest.clearAllMocks());

  it('forces model re-selection on next request after invalidation', async () => {
    const model = makeModel(['first call']);
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);

    const provider = new CopilotProvider();
    await provider.sendRequest(defaultOpts, AgentName.CLAUDE, makeToken());

    const callsBefore = (vscode.lm.selectChatModels as jest.Mock).mock.calls.length;

    provider.invalidateModelCache();
    await provider.sendRequest(defaultOpts, AgentName.CLAUDE, makeToken());

    expect((vscode.lm.selectChatModels as jest.Mock).mock.calls.length).toBeGreaterThan(callsBefore);
  });
});
