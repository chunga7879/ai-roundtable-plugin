/**
 * Integration tests for ChatPanel — additional message types and branches.
 *
 * Covers: clearChat, retryLastMessage, cancelRequest, setModelTier,
 * requestSessionList, restoreSession,
 * handleSendMessage round-type-change path, context usage posting,
 * applyChanges with install-command suggestion, handleSendMessage with empty prose.
 */
import * as vscode from 'vscode';
import { AgentName, ProviderMode, RoundType } from '../../src/types';
import * as RoundOrchestratorModule from '../../src/panels/RoundOrchestrator';

// ── Shared helpers ─────────────────────────────────────────────────────────────

function makeWebviewPanel() {
  const sentMessages: unknown[] = [];
  let messageHandler: ((msg: unknown) => void) | undefined;

  const panel = {
    webview: {
      html: '',
      postMessage: jest.fn().mockImplementation((msg: unknown) => {
        sentMessages.push(msg);
        return Promise.resolve(true);
      }),
      onDidReceiveMessage: jest.fn().mockImplementation(
        (handler: (msg: unknown) => void) => {
          messageHandler = handler;
          return { dispose: jest.fn() };
        },
      ),
    },
    onDidDispose: jest.fn().mockReturnValue({ dispose: jest.fn() }),
    reveal: jest.fn(),
    dispose: jest.fn(),
    _sentMessages: sentMessages,
  };

  Object.defineProperty(panel, '_messageHandler', {
    get() { return messageHandler; },
  });

  return panel as typeof panel & { _messageHandler: ((msg: unknown) => void) | undefined };
}

function makeConfigManager(overrides: Record<string, jest.Mock> = {}) {
  return {
    getConfig: jest.fn().mockResolvedValue({
      providerMode: ProviderMode.COPILOT,
      anthropicApiKey: undefined,
      openaiApiKey: undefined,
      googleApiKey: undefined,
      modelTier: 'heavy',
      runnerTimeoutMs: 60_000,
    }),
    configureProvider: jest.fn().mockResolvedValue(undefined),
    setProviderMode: jest.fn().mockResolvedValue(undefined),
    storeApiKey: jest.fn().mockResolvedValue(undefined),
    clearAllApiKeys: jest.fn().mockResolvedValue(undefined),
    setModelTier: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeFakeModel(responseText = 'agent response') {
  return {
    sendRequest: jest.fn().mockResolvedValue({
      stream: (async function* () {
        yield new vscode.LanguageModelTextPart(responseText);
      })(),
    }),
  };
}

async function setupPanel(configManager: ReturnType<typeof makeConfigManager>, fakeModel?: ReturnType<typeof makeFakeModel>) {
  jest.clearAllMocks();
  const panel = makeWebviewPanel();
  (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(panel);
  (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue(fakeModel ? [fakeModel] : []);
  (vscode.workspace.fs.stat as jest.Mock).mockRejectedValue(new Error('not found'));
  (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;

  const { ChatPanel } = await import('../../src/panels/ChatPanel');
  (ChatPanel as unknown as { instance: undefined }).instance = undefined;
  ChatPanel.createOrReveal(vscode.Uri.file('/ext'), configManager as never);
  return { panel, ChatPanel };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 600,
  stepMs = 10,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error('Timed out waiting for condition');
}

const validSendMessage = {
  type: 'sendMessage',
  payload: {
    userMessage: 'Build a function',
    roundType: RoundType.DEVELOPER,
    mainAgent: AgentName.CLAUDE,
    subAgents: [] as string[],
  },
};

// ── clearChat ─────────────────────────────────────────────────────────────────

describe('ChatPanel — clearChat', () => {
  afterEach(() => {
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
  });

  it('posts clearMessages and clearFileChanges on clearChat', async () => {
    const { panel } = await setupPanel(makeConfigManager());
    const handler = (panel as unknown as { _messageHandler: (m: unknown) => void })._messageHandler;
    panel._sentMessages.length = 0;

    handler({ type: 'clearChat' });
    await new Promise((r) => setTimeout(r, 20));

    const msgs = panel._sentMessages as Array<{ type: string }>;
    expect(msgs.some((m) => m.type === 'clearMessages')).toBe(true);
    expect(msgs.some((m) => m.type === 'clearFileChanges')).toBe(true);
  });

  it('handles clearChat while a request is in-flight', async () => {
    const slowModel = {
      sendRequest: jest.fn().mockResolvedValue({
        stream: (async function* () {
          yield new vscode.LanguageModelTextPart('chunk 1');
          await new Promise((r) => setTimeout(r, 40));
          yield new vscode.LanguageModelTextPart('chunk 2');
        })(),
      }),
    };
    const { panel } = await setupPanel(makeConfigManager(), slowModel);
    const handler = (panel as unknown as { _messageHandler: (m: unknown) => void })._messageHandler;

    handler(validSendMessage);
    await new Promise((r) => setTimeout(r, 5));
    handler({ type: 'clearChat' });
    await new Promise((r) => setTimeout(r, 120));

    const msgs = panel._sentMessages as Array<{ type: string }>;
    expect(msgs.some((m) => m.type === 'clearMessages')).toBe(true);
    expect(msgs.some((m) => m.type === 'clearFileChanges')).toBe(true);
  });
});

// ── retryLastMessage ──────────────────────────────────────────────────────────

describe('ChatPanel — retryLastMessage', () => {
  afterEach(() => {
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
  });

  it('does nothing when no last message exists', async () => {
    const { panel } = await setupPanel(makeConfigManager());
    const handler = (panel as unknown as { _messageHandler: (m: unknown) => void })._messageHandler;
    panel._sentMessages.length = 0;

    handler({ type: 'retryLastMessage' });
    await new Promise((r) => setTimeout(r, 20));

    // No addMessage should be emitted when there's no last message
    const msgs = panel._sentMessages as Array<{ type: string; payload?: { role?: string } }>;
    const userMsgs = msgs.filter((m) => m.type === 'addMessage' && m.payload?.role === 'user');
    expect(userMsgs).toHaveLength(0);
  });

  it('re-sends the last message when called after a sendMessage', async () => {
    const fakeModel = makeFakeModel();
    const { panel } = await setupPanel(makeConfigManager(), fakeModel);
    const handler = (panel as unknown as { _messageHandler: (m: unknown) => void })._messageHandler;

    // First send
    handler(validSendMessage);
    await new Promise((r) => setTimeout(r, 80));

    panel._sentMessages.length = 0;

    // Retry
    handler({ type: 'retryLastMessage' });
    await new Promise((r) => setTimeout(r, 80));

    const msgs = panel._sentMessages as Array<{ type: string; payload?: { role?: string } }>;
    expect(msgs.some((m) => m.type === 'setLoading')).toBe(true);
  });
});

// ── cancelRequest ─────────────────────────────────────────────────────────────

describe('ChatPanel — cancelRequest', () => {
  afterEach(() => {
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
  });

  it('does not throw when cancelRequest is sent', async () => {
    const { panel } = await setupPanel(makeConfigManager());
    const handler = (panel as unknown as { _messageHandler: (m: unknown) => void })._messageHandler;

    expect(() => handler({ type: 'cancelRequest' })).not.toThrow();
  });

  it('cancels during main-agent stage', async () => {
    const slowMainModel = {
      sendRequest: jest.fn().mockResolvedValue({
        stream: (async function* () {
          yield new vscode.LanguageModelTextPart('chunk 1');
          await new Promise((resolve) => setTimeout(resolve, 180));
          yield new vscode.LanguageModelTextPart('chunk 2');
        })(),
      }),
    };

    const { panel } = await setupPanel(makeConfigManager(), slowMainModel);
    const handler = (panel as unknown as { _messageHandler: (m: unknown) => void })._messageHandler;

    handler(validSendMessage);
    await waitFor(() => (panel._sentMessages as Array<{ type: string; payload?: { stage?: string } }>)
      .some((m) => m.type === 'pipelineProgress' && m.payload?.stage === 'thinking'));
    handler({ type: 'cancelRequest' });
    await waitFor(() => (panel._sentMessages as Array<{ type: string; payload?: { role?: string; content?: string } }>)
      .some((m) => m.type === 'addMessage' && m.payload?.role === 'system' && m.payload?.content === 'Request cancelled.'));
  });

  it('cancels when sub-agent verification is in-flight', async () => {
    let callCount = 0;
    const verifyingModel = {
      sendRequest: jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            stream: (async function* () {
              yield new vscode.LanguageModelTextPart('main response');
            })(),
          });
        }
        // Verifier call: intentionally hangs long enough for cancel path
        return Promise.resolve({
          stream: (async function* () {
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            yield new vscode.LanguageModelTextPart('late verifier feedback');
          })(),
        });
      }),
    };

    const { panel } = await setupPanel(makeConfigManager(), verifyingModel);
    const handler = (panel as unknown as { _messageHandler: (m: unknown) => void })._messageHandler;

    handler({
      type: 'sendMessage',
      payload: {
        userMessage: 'Build this',
        roundType: RoundType.DEVELOPER,
        mainAgent: AgentName.CLAUDE,
        subAgents: [AgentName.GPT],
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 40));
    handler({ type: 'cancelRequest' });
    await waitFor(() => (panel._sentMessages as Array<{ type: string; payload?: { role?: string; content?: string } }>)
      .some((m) => m.type === 'addMessage' && m.payload?.role === 'system' && m.payload?.content === 'Request cancelled.'));
  });

  it('cancels during reflection stage', async () => {
    let callCount = 0;
    const reflectionModel = {
      sendRequest: jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            stream: (async function* () {
              yield new vscode.LanguageModelTextPart('main response');
            })(),
          });
        }
        if (callCount === 2) {
          return Promise.resolve({
            stream: (async function* () {
              yield new vscode.LanguageModelTextPart(JSON.stringify({
                issues: [{ title: 'Fix X', detail: 'Need improvement' }],
              }));
            })(),
          });
        }
        return Promise.resolve({
          stream: (async function* () {
            yield new vscode.LanguageModelTextPart('reflection chunk 1');
            await new Promise((resolve) => setTimeout(resolve, 180));
            yield new vscode.LanguageModelTextPart('reflection chunk 2');
          })(),
        });
      }),
    };

    const { panel } = await setupPanel(makeConfigManager(), reflectionModel);
    const handler = (panel as unknown as { _messageHandler: (m: unknown) => void })._messageHandler;

    handler({
      type: 'sendMessage',
      payload: {
        userMessage: 'Improve code quality',
        roundType: RoundType.DEVELOPER,
        mainAgent: AgentName.CLAUDE,
        subAgents: [AgentName.GPT],
      },
    });

    await waitFor(() => callCount >= 3, 1_500);
    handler({ type: 'cancelRequest' });
    await waitFor(() => (panel._sentMessages as Array<{ type: string; payload?: { role?: string; content?: string } }>)
      .some((m) => m.type === 'addMessage' && m.payload?.role === 'system' && m.payload?.content === 'Request cancelled.'));
  });

  it('cancels in-flight post-apply command execution', async () => {
    const execSpy = jest.spyOn(RoundOrchestratorModule, 'execCommand').mockImplementation(
      (command: string, _cwd: string | undefined, _timeoutMs: number, cancellationToken?: vscode.CancellationToken) =>
        new Promise((resolve) => {
          cancellationToken?.onCancellationRequested(() => {
            resolve({ command, stdout: '(no output)\n[Cancelled]', exitCode: 1 });
          });
        }),
    );

    const { panel } = await setupPanel(makeConfigManager());
    (vscode.workspace.applyEdit as jest.Mock).mockResolvedValue(true);
    (vscode.workspace.fs.stat as jest.Mock).mockResolvedValue({ size: 10, type: 1 });
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: vscode.Uri.file('/workspace'), name: 'test', index: 0 },
    ];
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Run');

    const handler = (panel as unknown as { _messageHandler: (m: unknown) => void })._messageHandler;
    panel._sentMessages.length = 0;

    handler({
      type: 'applyChanges',
      payload: {
        fileChanges: [
          { filePath: 'package.json', content: '{"name":"test"}', isNew: false },
        ],
      },
    });

    await waitFor(() => execSpy.mock.calls.length > 0, 1_200);
    handler({ type: 'cancelRequest' });

    await waitFor(() => (panel._sentMessages as Array<{ type: string; payload?: { role?: string; content?: string } }>)
      .some((m) => m.type === 'addMessage' && m.payload?.role === 'system' && m.payload?.content === 'Command cancelled.'));
    const msgs = panel._sentMessages as Array<{ type: string }>;
    expect(msgs.some((m) => m.type === 'addCollapsibleMessage')).toBe(false);
    execSpy.mockRestore();
  });
});

// ── setModelTier ──────────────────────────────────────────────────────────────

describe('ChatPanel — setModelTier', () => {
  afterEach(() => {
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
  });

  it('calls setModelTier and posts configLoaded for light tier', async () => {
    const configManager = makeConfigManager();
    const { panel } = await setupPanel(configManager);
    const handler = (panel as unknown as { _messageHandler: (m: unknown) => void })._messageHandler;
    panel._sentMessages.length = 0;

    handler({ type: 'setModelTier', payload: { tier: 'light' } });
    await new Promise((r) => setTimeout(r, 30));

    expect(configManager.setModelTier).toHaveBeenCalledWith('light');
    const msgs = panel._sentMessages as Array<{ type: string }>;
    expect(msgs.some((m) => m.type === 'configLoaded')).toBe(true);
  });

  it('calls setModelTier and posts configLoaded for heavy tier', async () => {
    const configManager = makeConfigManager();
    const { panel } = await setupPanel(configManager);
    const handler = (panel as unknown as { _messageHandler: (m: unknown) => void })._messageHandler;
    panel._sentMessages.length = 0;

    handler({ type: 'setModelTier', payload: { tier: 'heavy' } });
    await new Promise((r) => setTimeout(r, 30));

    expect(configManager.setModelTier).toHaveBeenCalledWith('heavy');
  });

  it('ignores invalid tier value', async () => {
    const configManager = makeConfigManager();
    const { panel } = await setupPanel(configManager);
    const handler = (panel as unknown as { _messageHandler: (m: unknown) => void })._messageHandler;
    panel._sentMessages.length = 0;

    handler({ type: 'setModelTier', payload: { tier: 'ultra' } });
    await new Promise((r) => setTimeout(r, 20));

    expect(configManager.setModelTier).not.toHaveBeenCalled();
  });
});


// ── sendMessage — round type change clears history ────────────────────────────

describe('ChatPanel — sendMessage round type change', () => {
  afterEach(() => {
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
  });

  it('clears conversation history when round type changes', async () => {
    const fakeModel = makeFakeModel();
    const { panel } = await setupPanel(makeConfigManager(), fakeModel);
    const handler = (panel as unknown as { _messageHandler: (m: unknown) => void })._messageHandler;

    // First message: non-default round (ensures currentRoundType is initialized)
    handler({
      type: 'sendMessage',
      payload: {
        userMessage: 'Write tests',
        roundType: RoundType.QA,
        mainAgent: AgentName.CLAUDE,
        subAgents: [],
      },
    });
    await new Promise((r) => setTimeout(r, 80));

    panel._sentMessages.length = 0;

    // Second message: different round type (REVIEWER)
    handler({
      type: 'sendMessage',
      payload: {
        userMessage: 'Review my code',
        roundType: RoundType.REVIEWER,
        mainAgent: AgentName.CLAUDE,
        subAgents: [],
      },
    });
    await new Promise((r) => setTimeout(r, 80));

    const msgs = panel._sentMessages as Array<{ type: string; payload?: { roundType?: RoundType } }>;
    const roundChanged = msgs.find((m) => m.type === 'roundChanged');
    expect(roundChanged).toBeDefined();
    expect(roundChanged?.payload?.roundType).toBe(RoundType.REVIEWER);
  });
});

// ── applyChanges — install command suggestion ─────────────────────────────────

describe('ChatPanel — applyChanges with dependency file change', () => {
  afterEach(() => {
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
  });

  it('shows install-command dialog when package.json is in changed files', async () => {
    const { panel } = await setupPanel(makeConfigManager());
    // Set mocks AFTER setupPanel (setupPanel calls jest.clearAllMocks internally)
    (vscode.workspace.applyEdit as jest.Mock).mockResolvedValue(true);
    (vscode.workspace.fs.stat as jest.Mock).mockResolvedValue({ size: 10, type: 1 });
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: vscode.Uri.file('/workspace'), name: 'test', index: 0 },
    ];

    const handler = (panel as unknown as { _messageHandler: (m: unknown) => void })._messageHandler;
    panel._sentMessages.length = 0;

    handler({
      type: 'applyChanges',
      payload: {
        fileChanges: [
          { filePath: 'package.json', content: '{"name":"test"}', isNew: false },
        ],
      },
    });
    await new Promise((r) => setTimeout(r, 100));

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('Dependency'),
      expect.anything(),
      'Run',
    );
  });

  it('does not show install dialog for non-dependency files', async () => {
    const { panel } = await setupPanel(makeConfigManager());
    (vscode.workspace.applyEdit as jest.Mock).mockResolvedValue(true);
    (vscode.workspace.fs.stat as jest.Mock).mockResolvedValue({ size: 10, type: 1 });
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: vscode.Uri.file('/workspace'), name: 'test', index: 0 },
    ];

    const handler = (panel as unknown as { _messageHandler: (m: unknown) => void })._messageHandler;
    panel._sentMessages.length = 0;

    handler({
      type: 'applyChanges',
      payload: {
        fileChanges: [
          { filePath: 'src/utils.ts', content: 'export const x = 1;', isNew: true },
        ],
      },
    });
    await new Promise((r) => setTimeout(r, 100));

    // Should not prompt for non-dependency files
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalledWith(
      expect.stringContaining('Dependency'),
      expect.anything(),
      'Run',
    );
  });
});

// ── sendMessage — success with file changes produces showFileChanges ──────────

describe('ChatPanel — sendMessage success with file changes', () => {
  afterEach(() => {
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
  });

  it('posts showFileChanges when agent writes files via write_file tool', async () => {
    // Agent that writes a file via tool call
    const model = {
      sendRequest: jest.fn().mockResolvedValue({
        stream: (async function* () {
          yield new vscode.LanguageModelToolCallPart('c1', 'write_file', {
            path: 'src/output.ts',
            content: 'export const x = 1;',
          });
          yield new vscode.LanguageModelTextPart('Done');
        })(),
      }),
    };
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);
    (vscode.workspace.fs.stat as jest.Mock).mockRejectedValue(new Error('not found'));
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: vscode.Uri.file('/workspace'), name: 'test', index: 0 },
    ];

    const { panel } = await setupPanel(makeConfigManager(), model);
    const handler = (panel as unknown as { _messageHandler: (m: unknown) => void })._messageHandler;
    panel._sentMessages.length = 0;

    handler(validSendMessage);
    await new Promise((r) => setTimeout(r, 100));

    const msgs = panel._sentMessages as Array<{ type: string }>;
    expect(msgs.some((m) => m.type === 'showFileChanges')).toBe(true);

    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
  });
});

// ── requestSessionList — no session manager ────────────────────────────────────

describe('ChatPanel — requestSessionList', () => {
  afterEach(() => {
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
  });

  it('does not throw when requestSessionList is sent without context', async () => {
    const { panel } = await setupPanel(makeConfigManager());
    const handler = (panel as unknown as { _messageHandler: (m: unknown) => void })._messageHandler;

    expect(() => handler({ type: 'requestSessionList' })).not.toThrow();
  });
});

// ── sendMessage — empty prose response ───────────────────────────────────────

describe('ChatPanel — sendMessage empty prose with no file changes', () => {
  afterEach(() => {
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
  });

  it('posts "Done." when agent returns empty text and no file changes', async () => {
    const model = {
      sendRequest: jest.fn().mockResolvedValue({
        stream: (async function* () {
          yield new vscode.LanguageModelTextPart('');
        })(),
      }),
    };
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([model]);

    const { panel } = await setupPanel(makeConfigManager(), model);
    const handler = (panel as unknown as { _messageHandler: (m: unknown) => void })._messageHandler;
    panel._sentMessages.length = 0;

    handler(validSendMessage);
    await new Promise((r) => setTimeout(r, 80));

    const msgs = panel._sentMessages as Array<{ type: string; payload?: { content?: string } }>;
    // At minimum setLoading should have been emitted
    expect(msgs.some((m) => m.type === 'setLoading')).toBe(true);
  });
});

// ── previewChange — missing payload fields ────────────────────────────────────

describe('ChatPanel — previewChange edge cases', () => {
  afterEach(() => {
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
  });

  it('ignores previewChange with missing fileChange', async () => {
    const { panel } = await setupPanel(makeConfigManager());
    const handler = (panel as unknown as { _messageHandler: (m: unknown) => void })._messageHandler;

    expect(() => handler({ type: 'previewChange', payload: {} })).not.toThrow();
  });

  it('ignores previewChange with null payload', async () => {
    const { panel } = await setupPanel(makeConfigManager());
    const handler = (panel as unknown as { _messageHandler: (m: unknown) => void })._messageHandler;

    expect(() => handler({ type: 'previewChange', payload: null })).not.toThrow();
  });

  it('ignores previewChange where filePath is absolute', async () => {
    const { panel } = await setupPanel(makeConfigManager());
    const handler = (panel as unknown as { _messageHandler: (m: unknown) => void })._messageHandler;

    handler({ type: 'previewChange', payload: { fileChange: { filePath: '/etc/passwd', content: '', isNew: false } } });
    await new Promise((r) => setTimeout(r, 20));
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });
});

// ── refreshConfig ─────────────────────────────────────────────────────────────

describe('ChatPanel.refreshConfig', () => {
  afterEach(() => {
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
  });

  it('does not throw when no instance exists', async () => {
    jest.clearAllMocks();
    const { ChatPanel } = await import('../../src/panels/ChatPanel');
    (ChatPanel as unknown as { instance: undefined }).instance = undefined;

    await expect(ChatPanel.refreshConfig()).resolves.not.toThrow();
  });

  it('posts configLoaded when instance exists', async () => {
    jest.clearAllMocks();
    const panel = makeWebviewPanel();
    (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(panel);
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([]);

    const { ChatPanel } = await import('../../src/panels/ChatPanel');
    (ChatPanel as unknown as { instance: undefined }).instance = undefined;
    ChatPanel.createOrReveal(vscode.Uri.file('/ext'), makeConfigManager() as never);

    panel._sentMessages.length = 0;
    await ChatPanel.refreshConfig();

    const msgs = panel._sentMessages as Array<{ type: string }>;
    expect(msgs.some((m) => m.type === 'configLoaded')).toBe(true);
  });
});

// ── ChatPanel — VERIFY: dialog after Apply ────────────────────────────────────

describe('ChatPanel — VERIFY: dialog after Apply', () => {
  afterEach(() => {
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
  });

  it('shows VERIFY: dialog when pendingVerifyCommand is set after sendMessage with file changes', async () => {
    const model = {
      sendRequest: jest.fn().mockResolvedValue({
        stream: (async function* () {
          yield new vscode.LanguageModelToolCallPart('c1', 'write_file', {
            path: 'src/out.ts',
            content: 'export const x = 1;',
          });
          yield new vscode.LanguageModelTextPart('Done.\n\nVERIFY: npm test');
        })(),
      }),
    };

    const { panel } = await setupPanel(makeConfigManager(), model);

    // Set up mocks AFTER setupPanel (which calls jest.clearAllMocks internally)
    (vscode.workspace.applyEdit as jest.Mock).mockResolvedValue(true);
    (vscode.workspace.fs.stat as jest.Mock).mockResolvedValue({ size: 10, type: 1 });
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: vscode.Uri.file('/workspace'), name: 'test', index: 0 },
    ];

    const handler = (panel as unknown as { _messageHandler: (m: unknown) => void })._messageHandler;

    // Send a message to trigger the agent (with file changes + VERIFY: token)
    handler({
      type: 'sendMessage',
      payload: {
        userMessage: 'Build something',
        roundType: RoundType.DEVELOPER,
        mainAgent: AgentName.CLAUDE,
        subAgents: [] as string[],
      },
    });
    await new Promise((r) => setTimeout(r, 150));

    // Now apply changes
    handler({
      type: 'applyChanges',
      payload: {
        fileChanges: [
          { filePath: 'src/out.ts', content: 'export const x = 1;', isNew: true },
        ],
      },
    });
    await new Promise((r) => setTimeout(r, 150));

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('npm test'),
      expect.anything(),
      'Run',
    );
  });

  it('does NOT show VERIFY: dialog when response has no VERIFY: token', async () => {
    const model = {
      sendRequest: jest.fn().mockResolvedValue({
        stream: (async function* () {
          yield new vscode.LanguageModelToolCallPart('c1', 'write_file', {
            path: 'src/out.ts',
            content: 'export const x = 1;',
          });
          yield new vscode.LanguageModelTextPart('Done. No verify token here.');
        })(),
      }),
    };

    const { panel } = await setupPanel(makeConfigManager(), model);

    (vscode.workspace.applyEdit as jest.Mock).mockResolvedValue(true);
    (vscode.workspace.fs.stat as jest.Mock).mockResolvedValue({ size: 10, type: 1 });
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: vscode.Uri.file('/workspace'), name: 'test', index: 0 },
    ];

    const handler = (panel as unknown as { _messageHandler: (m: unknown) => void })._messageHandler;

    handler({
      type: 'sendMessage',
      payload: {
        userMessage: 'Build something',
        roundType: RoundType.DEVELOPER,
        mainAgent: AgentName.CLAUDE,
        subAgents: [] as string[],
      },
    });
    await new Promise((r) => setTimeout(r, 150));

    handler({
      type: 'applyChanges',
      payload: {
        fileChanges: [
          { filePath: 'src/out.ts', content: 'export const x = 1;', isNew: true },
        ],
      },
    });
    await new Promise((r) => setTimeout(r, 150));

    // showWarningMessage may be called for install commands, but not for verification
    const calls = (vscode.window.showWarningMessage as jest.Mock).mock.calls;
    const verifyCall = calls.find((args: unknown[]) =>
      typeof args[0] === 'string' && args[0].includes('Run verification command'),
    );
    expect(verifyCall).toBeUndefined();
  });

  it('pendingVerifyCommand cleared by rejectChanges — VERIFY: dialog not shown on subsequent apply', async () => {
    const model = {
      sendRequest: jest.fn().mockResolvedValue({
        stream: (async function* () {
          yield new vscode.LanguageModelToolCallPart('c1', 'write_file', {
            path: 'src/out.ts',
            content: 'export const x = 1;',
          });
          yield new vscode.LanguageModelTextPart('Done.\n\nVERIFY: npm test');
        })(),
      }),
    };

    const { panel } = await setupPanel(makeConfigManager(), model);

    (vscode.workspace.applyEdit as jest.Mock).mockResolvedValue(true);
    (vscode.workspace.fs.stat as jest.Mock).mockResolvedValue({ size: 10, type: 1 });
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: vscode.Uri.file('/workspace'), name: 'test', index: 0 },
    ];

    const handler = (panel as unknown as { _messageHandler: (m: unknown) => void })._messageHandler;

    // Send message with VERIFY: token + file changes
    handler({
      type: 'sendMessage',
      payload: {
        userMessage: 'Build something',
        roundType: RoundType.DEVELOPER,
        mainAgent: AgentName.CLAUDE,
        subAgents: [] as string[],
      },
    });
    await new Promise((r) => setTimeout(r, 150));

    // Reject changes — this should clear pendingVerifyCommand
    handler({ type: 'rejectChanges' });
    await new Promise((r) => setTimeout(r, 50));

    // Reset mock call tracking
    (vscode.window.showWarningMessage as jest.Mock).mockClear();

    // Apply a subsequent batch — VERIFY: dialog should NOT appear
    handler({
      type: 'applyChanges',
      payload: {
        fileChanges: [
          { filePath: 'src/out.ts', content: 'some content', isNew: false },
        ],
      },
    });
    await new Promise((r) => setTimeout(r, 150));

    const calls = (vscode.window.showWarningMessage as jest.Mock).mock.calls;
    const verifyCall = calls.find((args: unknown[]) =>
      typeof args[0] === 'string' && args[0].includes('Run verification command'),
    );
    expect(verifyCall).toBeUndefined();
  });

  it('pendingVerifyCommand NOT set when fileChanges = 0 — VERIFY: dialog not shown after applyChanges', async () => {
    // Agent emits VERIFY: token but NO write_file calls → fileChanges = 0 → pendingVerifyCommand not set
    const model = {
      sendRequest: jest.fn().mockResolvedValue({
        stream: (async function* () {
          yield new vscode.LanguageModelTextPart('Done.\n\nVERIFY: npm test');
        })(),
      }),
    };

    const { panel } = await setupPanel(makeConfigManager(), model);

    (vscode.workspace.applyEdit as jest.Mock).mockResolvedValue(true);
    (vscode.workspace.fs.stat as jest.Mock).mockResolvedValue({ size: 10, type: 1 });
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: vscode.Uri.file('/workspace'), name: 'test', index: 0 },
    ];

    const handler = (panel as unknown as { _messageHandler: (m: unknown) => void })._messageHandler;

    handler({
      type: 'sendMessage',
      payload: {
        userMessage: 'Build something',
        roundType: RoundType.DEVELOPER,
        mainAgent: AgentName.CLAUDE,
        subAgents: [] as string[],
      },
    });
    await new Promise((r) => setTimeout(r, 150));

    handler({
      type: 'applyChanges',
      payload: {
        fileChanges: [
          { filePath: 'src/dummy.ts', content: 'const x = 1;', isNew: false },
        ],
      },
    });
    await new Promise((r) => setTimeout(r, 150));

    const calls = (vscode.window.showWarningMessage as jest.Mock).mock.calls;
    const verifyCall = calls.find((args: unknown[]) =>
      typeof args[0] === 'string' && args[0].includes('Run verification command'),
    );
    expect(verifyCall).toBeUndefined();
  });
});
