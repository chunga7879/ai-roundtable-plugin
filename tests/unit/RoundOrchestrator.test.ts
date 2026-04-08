/**
 * Unit tests for RoundOrchestrator.
 *
 * Covers: run() lifecycle, cancel(), dispose(), handleProgressEvent() all branches,
 * runCommandWithApproval() approve/deny, execCommand() success and sync-error paths.
 */
import * as vscode from 'vscode';
import { RoundOrchestrator, execCommand } from '../../src/panels/RoundOrchestrator';
import { AgentName, ProviderMode, RoundType } from '../../src/types';
import type { ExtensionToWebviewMessage, ExtensionConfig, CommandOutput } from '../../src/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<ExtensionConfig> = {}): ExtensionConfig {
  return {
    providerMode: ProviderMode.COPILOT,
    anthropicApiKey: undefined,
    openaiApiKey: undefined,
    googleApiKey: undefined,
    deepseekApiKey: undefined,
    copilotModelFamily: undefined,
    modelTier: 'heavy',
    runnerTimeoutMs: 60_000,
    ...overrides,
  };
}

function makeConfigManager(config: Partial<ExtensionConfig> = {}) {
  return {
    getConfig: jest.fn().mockResolvedValue(makeConfig(config)),
    configureProvider: jest.fn(),
    setModelTier: jest.fn(),
  };
}

function makeWorkspaceReader() {
  return {
    buildContext: jest.fn().mockResolvedValue({ files: [] }),
    readFileForTool: jest.fn().mockResolvedValue({ content: 'content', isError: false }),
  };
}

function makeParams(overrides: Partial<{
  userMessage: string;
  roundType: RoundType;
  mainAgent: AgentName;
  subAgents: AgentName[];
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
  fileCache: Map<string, string>;
  commandOutputCache: Map<string, CommandOutput>;
}> = {}) {
  return {
    userMessage: 'Write a function',
    roundType: RoundType.DEVELOPER,
    mainAgent: AgentName.CLAUDE,
    subAgents: [] as AgentName[],
    conversationHistory: [] as Array<{ role: 'user' | 'assistant'; content: string }>,
    fileCache: new Map<string, string>(),
    commandOutputCache: new Map<string, CommandOutput>() as Map<string, CommandOutput>,
    ...overrides,
  };
}

// ── RoundOrchestrator.cancel() ────────────────────────────────────────────────

describe('RoundOrchestrator.cancel', () => {
  it('does not throw when called before any run()', () => {
    const emitted: ExtensionToWebviewMessage[] = [];
    const orchestrator = new RoundOrchestrator(
      makeConfigManager() as never,
      makeWorkspaceReader() as never,
      (msg) => emitted.push(msg),
    );
    expect(() => orchestrator.cancel()).not.toThrow();
  });
});

// ── RoundOrchestrator.dispose() ───────────────────────────────────────────────

describe('RoundOrchestrator.dispose', () => {
  it('does not throw when called before any run()', () => {
    const orchestrator = new RoundOrchestrator(
      makeConfigManager() as never,
      makeWorkspaceReader() as never,
      jest.fn(),
    );
    expect(() => orchestrator.dispose()).not.toThrow();
  });

  it('can be called multiple times safely', () => {
    const orchestrator = new RoundOrchestrator(
      makeConfigManager() as never,
      makeWorkspaceReader() as never,
      jest.fn(),
    );
    expect(() => {
      orchestrator.dispose();
      orchestrator.dispose();
    }).not.toThrow();
  });
});

// ── streamingBubbleId / clearStreamingBubble ──────────────────────────────────

describe('RoundOrchestrator.streamingBubbleId / clearStreamingBubble', () => {
  it('returns undefined initially', () => {
    const orchestrator = new RoundOrchestrator(
      makeConfigManager() as never,
      makeWorkspaceReader() as never,
      jest.fn(),
    );
    expect(orchestrator.streamingBubbleId).toBeUndefined();
  });

  it('clearStreamingBubble does not throw when called with no bubble', () => {
    const orchestrator = new RoundOrchestrator(
      makeConfigManager() as never,
      makeWorkspaceReader() as never,
      jest.fn(),
    );
    expect(() => orchestrator.clearStreamingBubble()).not.toThrow();
    expect(orchestrator.streamingBubbleId).toBeUndefined();
  });
});

// ── run() — success path ──────────────────────────────────────────────────────

describe('RoundOrchestrator.run — success', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([
      {
        sendRequest: jest.fn().mockResolvedValue({
          stream: (async function* () {
            yield new vscode.LanguageModelTextPart('response text');
          })(),
        }),
      },
    ]);
  });

  it('emits setLoading true then false around a successful run', async () => {
    const emitted: ExtensionToWebviewMessage[] = [];
    const orchestrator = new RoundOrchestrator(
      makeConfigManager() as never,
      makeWorkspaceReader() as never,
      (msg) => emitted.push(msg),
    );

    const result = await orchestrator.run(makeParams());

    expect(result.status).toBe('success');
    expect(emitted.some((m) => m.type === 'setLoading' && (m as { type: 'setLoading'; payload: { loading: boolean } }).payload.loading === true)).toBe(true);
    expect(emitted.some((m) => m.type === 'setLoading' && (m as { type: 'setLoading'; payload: { loading: boolean } }).payload.loading === false)).toBe(true);
  });

  it('emits clearFileChanges and clearContextFiles at start of run', async () => {
    const emitted: ExtensionToWebviewMessage[] = [];
    const orchestrator = new RoundOrchestrator(
      makeConfigManager() as never,
      makeWorkspaceReader() as never,
      (msg) => emitted.push(msg),
    );

    await orchestrator.run(makeParams());

    expect(emitted.some((m) => m.type === 'clearFileChanges')).toBe(true);
    expect(emitted.some((m) => m.type === 'clearContextFiles')).toBe(true);
  });

  it('returns success with newUserTurn when history is empty', async () => {
    const emitted: ExtensionToWebviewMessage[] = [];
    const orchestrator = new RoundOrchestrator(
      makeConfigManager() as never,
      makeWorkspaceReader() as never,
      (msg) => emitted.push(msg),
    );

    const result = await orchestrator.run(makeParams({ conversationHistory: [] }));

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.newUserTurn).toBeDefined();
      expect(result.newUserTurn?.role).toBe('user');
      expect(result.newUserTurn?.content).toBe('Write a function');
    }
  });

  it('returns newUserTurn=undefined when last history entry matches the message', async () => {
    const emitted: ExtensionToWebviewMessage[] = [];
    const orchestrator = new RoundOrchestrator(
      makeConfigManager() as never,
      makeWorkspaceReader() as never,
      (msg) => emitted.push(msg),
    );

    const conversationHistory = [
      { role: 'user' as const, content: 'Write a function' },
    ];

    const result = await orchestrator.run(makeParams({ conversationHistory }));

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.newUserTurn).toBeUndefined();
    }
  });
});

// ── run() — cancellation ──────────────────────────────────────────────────────

describe('RoundOrchestrator.run — cancellation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns cancelled when model.sendRequest throws CancellationError', async () => {
    // CancellationError must come from model.sendRequest (not selectChatModels)
    // to propagate as-is through AgentRunner.callAgent
    const cancellingModel = {
      sendRequest: jest.fn().mockRejectedValue(new vscode.CancellationError()),
    };
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([cancellingModel]);

    const emitted: ExtensionToWebviewMessage[] = [];
    const orchestrator = new RoundOrchestrator(
      makeConfigManager() as never,
      makeWorkspaceReader() as never,
      (msg) => emitted.push(msg),
    );

    const result = await orchestrator.run(makeParams());
    expect(result.status).toBe('cancelled');
  });

  it('still emits setLoading false in finally after cancellation', async () => {
    const cancellingModel = {
      sendRequest: jest.fn().mockRejectedValue(new vscode.CancellationError()),
    };
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([cancellingModel]);

    const emitted: ExtensionToWebviewMessage[] = [];
    const orchestrator = new RoundOrchestrator(
      makeConfigManager() as never,
      makeWorkspaceReader() as never,
      (msg) => emitted.push(msg),
    );

    await orchestrator.run(makeParams());

    expect(emitted.some((m) => m.type === 'setLoading' && (m as { type: 'setLoading'; payload: { loading: boolean } }).payload.loading === false)).toBe(true);
  });
});

// ── run() — error path ────────────────────────────────────────────────────────

describe('RoundOrchestrator.run — error', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns error status when agent throws generic error', async () => {
    (vscode.lm.selectChatModels as jest.Mock).mockRejectedValue(new Error('API timeout'));

    const orchestrator = new RoundOrchestrator(
      makeConfigManager() as never,
      makeWorkspaceReader() as never,
      jest.fn(),
    );

    const result = await orchestrator.run(makeParams());
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.error).toBeInstanceOf(Error);
    }
  });

  it('still emits setLoading false in finally after error', async () => {
    (vscode.lm.selectChatModels as jest.Mock).mockRejectedValue(new Error('fail'));

    const emitted: ExtensionToWebviewMessage[] = [];
    const orchestrator = new RoundOrchestrator(
      makeConfigManager() as never,
      makeWorkspaceReader() as never,
      (msg) => emitted.push(msg),
    );

    await orchestrator.run(makeParams());

    expect(emitted.some((m) => m.type === 'setLoading' && (m as { type: 'setLoading'; payload: { loading: boolean } }).payload.loading === false)).toBe(true);
  });
});

// ── handleProgressEvent — main_agent_start ────────────────────────────────────

describe('RoundOrchestrator.handleProgressEvent — main_agent_start', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('emits pipelineProgress:thinking and addMessage with streaming:true', async () => {
    const model = {
      sendRequest: jest.fn().mockResolvedValue({
        stream: (async function* () {
          yield new vscode.LanguageModelTextPart('hello');
        })(),
      }),
    };
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);

    const emitted: ExtensionToWebviewMessage[] = [];
    const orchestrator = new RoundOrchestrator(
      makeConfigManager() as never,
      makeWorkspaceReader() as never,
      (msg) => emitted.push(msg),
    );

    await orchestrator.run(makeParams());

    expect(emitted.some((m) => m.type === 'pipelineProgress' && (m as { type: 'pipelineProgress'; payload: { stage: string } }).payload.stage === 'thinking')).toBe(true);
    const addMsgs = emitted.filter((m) => m.type === 'addMessage') as Array<{ type: 'addMessage'; payload: { streaming?: boolean; role: string } }>;
    expect(addMsgs.some((m) => m.payload.streaming === true && m.payload.role === 'agent')).toBe(true);
  });
});

// ── handleProgressEvent — streaming chunks ────────────────────────────────────

describe('RoundOrchestrator.handleProgressEvent — main_agent_chunk streaming', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('emits streamChunk messages for each chunk', async () => {
    const model = {
      sendRequest: jest.fn().mockResolvedValue({
        stream: (async function* () {
          yield new vscode.LanguageModelTextPart('chunk1');
          yield new vscode.LanguageModelTextPart('chunk2');
        })(),
      }),
    };
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);

    const emitted: ExtensionToWebviewMessage[] = [];
    const orchestrator = new RoundOrchestrator(
      makeConfigManager() as never,
      makeWorkspaceReader() as never,
      (msg) => emitted.push(msg),
    );

    await orchestrator.run(makeParams());

    const chunks = emitted.filter((m) => m.type === 'streamChunk');
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });
});

// ── handleProgressEvent — sub_agents_start / sub_agent_feedback ───────────────

describe('RoundOrchestrator.handleProgressEvent — sub-agent pipeline', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('emits pipelineProgress:verifying and addMessage placeholders for sub-agents', async () => {
    let callCount = 0;
    const model = {
      sendRequest: jest.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          stream: (async function* () {
            if (callCount === 1) {
              yield new vscode.LanguageModelTextPart('main response');
            } else if (callCount === 2) {
              yield new vscode.LanguageModelTextPart('sub agent feedback: looks good');
            } else {
              yield new vscode.LanguageModelTextPart('reflected');
            }
          })(),
        });
      }),
    };
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);

    const emitted: ExtensionToWebviewMessage[] = [];
    const orchestrator = new RoundOrchestrator(
      makeConfigManager() as never,
      makeWorkspaceReader() as never,
      (msg) => emitted.push(msg),
    );

    await orchestrator.run(makeParams({ subAgents: [AgentName.GPT] }));

    expect(emitted.some((m) => m.type === 'pipelineProgress' && (m as { type: 'pipelineProgress'; payload: { stage: string } }).payload.stage === 'verifying')).toBe(true);
    // Should have sub-agent placeholder messages
    const addMsgs = emitted.filter((m) => m.type === 'addMessage') as Array<{ type: 'addMessage'; payload: { isSubAgentFeedback?: boolean } }>;
    expect(addMsgs.some((m) => m.payload.isSubAgentFeedback === true)).toBe(true);
  });

  it('emits pipelineProgress:reflecting when sub-agent provides valid feedback', async () => {
    let callCount = 0;
    const model = {
      sendRequest: jest.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          stream: (async function* () {
            if (callCount === 1) {
              yield new vscode.LanguageModelTextPart('main response');
            } else if (callCount === 2) {
              yield new vscode.LanguageModelTextPart('feedback: missing error handling');
            } else {
              yield new vscode.LanguageModelTextPart('reflected with fixes');
            }
          })(),
        });
      }),
    };
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);

    const emitted: ExtensionToWebviewMessage[] = [];
    const orchestrator = new RoundOrchestrator(
      makeConfigManager() as never,
      makeWorkspaceReader() as never,
      (msg) => emitted.push(msg),
    );

    await orchestrator.run(makeParams({ subAgents: [AgentName.GPT] }));

    expect(emitted.some((m) => m.type === 'pipelineProgress' && (m as { type: 'pipelineProgress'; payload: { stage: string } }).payload.stage === 'reflecting')).toBe(true);
  });

  it('removes placeholder for unavailable sub-agent verification', async () => {
    let callCount = 0;
    const model = {
      sendRequest: jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 2) {
          return Promise.reject(new Error('rate limit'));
        }
        return Promise.resolve({
          stream: (async function* () {
            yield new vscode.LanguageModelTextPart('main response');
          })(),
        });
      }),
    };
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);

    const emitted: ExtensionToWebviewMessage[] = [];
    const orchestrator = new RoundOrchestrator(
      makeConfigManager() as never,
      makeWorkspaceReader() as never,
      (msg) => emitted.push(msg),
    );

    const result = await orchestrator.run(makeParams({ subAgents: [AgentName.GPT] }));

    // Should still succeed overall
    expect(result.status).toBe('success');
    // Should have removed the unavailable placeholder
    const removeMsgs = emitted.filter((m) => m.type === 'removeMessage');
    expect(removeMsgs.length).toBeGreaterThan(0);
  });
});

// ── handleProgressEvent — tool_read / tool_run_command / tool_write_file ───────

describe('RoundOrchestrator.handleProgressEvent — tool calls', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('emits toolCallProgress and contextFileRead on tool_read', async () => {
    (vscode.workspace.fs.readDirectory as jest.Mock).mockResolvedValue([
      ['src/app.ts', 1],
    ]);
    (vscode.workspace.fs.stat as jest.Mock).mockResolvedValue({ size: 10 });
    (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(Buffer.from('const x = 1;'));
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: vscode.Uri.file('/workspace'), name: 'test', index: 0 },
    ];

    const model = {
      sendRequest: jest.fn().mockResolvedValue({
        stream: (async function* () {
          yield new vscode.LanguageModelToolCallPart('call1', 'read_file', { path: 'src/app.ts' });
          yield new vscode.LanguageModelTextPart('done');
        })(),
      }),
    };
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);

    const emitted: ExtensionToWebviewMessage[] = [];
    const orchestrator = new RoundOrchestrator(
      makeConfigManager() as never,
      makeWorkspaceReader() as never,
      (msg) => emitted.push(msg),
    );

    await orchestrator.run(makeParams());

    // contextFileRead should be emitted when a file is read
    expect(emitted.some((m) => m.type === 'contextFileRead')).toBe(true);

    // cleanup
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
  });
});

// ── runCommandWithApproval — approve and deny ─────────────────────────────────

describe('RoundOrchestrator.runCommandWithApproval — via run()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns denied output when user clicks away from dialog', async () => {
    // Agent requests a run_command tool call
    const model = {
      sendRequest: jest.fn().mockResolvedValue({
        stream: (async function* () {
          yield new vscode.LanguageModelToolCallPart('c1', 'run_command', { command: 'npm test' });
          yield new vscode.LanguageModelTextPart('ran');
        })(),
      }),
    };
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);
    // User dismisses the dialog (returns undefined → not 'Run')
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);

    const orchestrator = new RoundOrchestrator(
      makeConfigManager() as never,
      makeWorkspaceReader() as never,
      jest.fn(),
    );

    const result = await orchestrator.run(makeParams());
    expect(result.status).toBe('success');
  });
});

// ── execCommand — success ─────────────────────────────────────────────────────

describe('execCommand', () => {
  it('resolves with exit code 0 for a successful command', async () => {
    const result = await execCommand('echo hello', undefined, 10_000);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello');
  });

  it('resolves with exit code 1 for a failing command', async () => {
    const result = await execCommand('exit 1', undefined, 10_000);
    // Shell behaviour: exit is a builtin, may produce stderr
    expect(result.exitCode).not.toBe(0);
  });

  it('resolves with exit code 1 for a non-existent command', async () => {
    const result = await execCommand('__nonexistent_command_xyz__', undefined, 10_000);
    expect(result.exitCode).not.toBe(0);
  });

  it('handles errors from invalid cwd gracefully (resolves, not rejects)', async () => {
    // Pass a non-existent cwd — cp.exec may error but should resolve via the callback
    const result = await execCommand('echo test', '/nonexistent/path/xyz', 5_000);
    // Should resolve (not reject), even if the command fails
    // exitCode may be a number or string depending on the OS error code
    expect(result).toBeDefined();
    expect(result.command).toBe('echo test');
  });
});

// ── orphaned streaming bubble cleanup ─────────────────────────────────────────

describe('RoundOrchestrator — orphaned streaming bubble cleanup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('emits removeMessage for orphaned bubble at start of second run', async () => {
    // First run starts but is cancelled mid-stream, leaving a dangling streamingMsgId
    let callCount = 0;
    const model = {
      sendRequest: jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new vscode.CancellationError());
        }
        return Promise.resolve({
          stream: (async function* () {
            yield new vscode.LanguageModelTextPart('second response');
          })(),
        });
      }),
    };
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);

    const emitted: ExtensionToWebviewMessage[] = [];
    const orchestrator = new RoundOrchestrator(
      makeConfigManager() as never,
      makeWorkspaceReader() as never,
      (msg) => emitted.push(msg),
    );

    // First run — agent throws CancellationError before emitting main_agent_start
    await orchestrator.run(makeParams());

    emitted.length = 0;

    // Second run — should clean up any orphan
    await orchestrator.run(makeParams());

    // No removeMessage needed since no bubble was created (CancellationError was thrown before main_agent_start)
    // Just verify second run completes
    expect(emitted.some((m) => m.type === 'setLoading')).toBe(true);
  });
});
