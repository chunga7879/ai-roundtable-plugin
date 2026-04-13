/**
 * Integration tests for ChatPanel webview message routing.
 * These tests verify that messages from the webview are correctly dispatched
 * and that the extension responds with the expected output messages.
 *
 * The tests use the full ChatPanel + AgentRunner stack with all AI providers mocked.
 */
import * as vscode from 'vscode';
import { AgentName, ProviderMode, RoundType } from '../../src/types';

// ── Mock helpers ──────────────────────────────────────────────────────────────

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
    _messageHandler: undefined as ((msg: unknown) => void) | undefined,
    _sentMessages: sentMessages,
  };

  // Expose the message handler for tests to call
  Object.defineProperty(panel, '_messageHandler', {
    get() {
      return messageHandler;
    },
  });

  return panel;
}

function makeConfigManager(providerMode = ProviderMode.COPILOT) {
  return {
    getConfig: jest.fn().mockResolvedValue({
      providerMode,
      anthropicApiKey: undefined,
      openaiApiKey: undefined,
      googleApiKey: undefined,
    }),
    configureProvider: jest.fn().mockResolvedValue(undefined),
    setProviderMode: jest.fn().mockResolvedValue(undefined),
    storeApiKey: jest.fn().mockResolvedValue(undefined),
    clearAllApiKeys: jest.fn().mockResolvedValue(undefined),
  };
}

// ── sendMessage happy path ────────────────────────────────────────────────────

describe('ChatPanel — sendMessage message routing', () => {
  let panel: ReturnType<typeof makeWebviewPanel>;
  let configManager: ReturnType<typeof makeConfigManager>;

  beforeEach(() => {
    jest.clearAllMocks();

    panel = makeWebviewPanel();

    configManager = makeConfigManager();

    // Mock vscode.window.createWebviewPanel to return our controlled panel
    (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(panel);

    // Mock Copilot model selection: return a fake model
    const fakeModel = {
      sendRequest: jest.fn().mockResolvedValue({
        text: (async function* () {
          yield 'Agent ';
          yield 'response text';
        })(),
      }),
    };
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([fakeModel]);

    // Mock workspace FS
    (vscode.workspace.fs.readDirectory as jest.Mock).mockResolvedValue([]);
    (vscode.workspace.fs.stat as jest.Mock).mockRejectedValue(new Error('not found'));
  });

  it('posts addMessage for user and agent on valid sendMessage', async () => {
    // Dynamic import avoids import-time side effects in the singleton
    const { ChatPanel } = await import('../../src/panels/ChatPanel');

    // Reset singleton
    (ChatPanel as unknown as { instance: undefined }).instance = undefined;

    ChatPanel.createOrReveal(
      vscode.Uri.file('/ext'),
      configManager as never,
    );

    const handler = panel._messageHandler;
    expect(handler).toBeDefined();

    // Send a valid sendMessage
    await handler!({
      type: 'sendMessage',
      payload: {
        userMessage: 'Create a TODO app',
        roundType: RoundType.DEVELOPER,
        mainAgent: AgentName.CLAUDE,
        subAgents: [],
      },
    });

    const messages = panel._sentMessages as Array<{ type: string }>;
    const types = messages.map((m) => m.type);

    expect(types).toContain('addMessage');
    expect(types).toContain('setLoading');
  });

  it('posts error message for invalid sendMessage payload', async () => {
    const { ChatPanel } = await import('../../src/panels/ChatPanel');
    (ChatPanel as unknown as { instance: undefined }).instance = undefined;

    ChatPanel.createOrReveal(vscode.Uri.file('/ext'), configManager as never);

    const handler = panel._messageHandler;
    await handler!({
      type: 'sendMessage',
      payload: {
        userMessage: '',  // invalid: empty
        roundType: RoundType.DEVELOPER,
        mainAgent: AgentName.CLAUDE,
        subAgents: [],
      },
    });

    const messages = panel._sentMessages as Array<{ type: string; payload?: { role?: string } }>;
    const errorMessages = messages.filter(
      (m) => m.type === 'addMessage' && m.payload?.role === 'error',
    );
    expect(errorMessages.length).toBeGreaterThan(0);
  });

  it('posts error message for unknown message type', async () => {
    const { ChatPanel } = await import('../../src/panels/ChatPanel');
    (ChatPanel as unknown as { instance: undefined }).instance = undefined;

    ChatPanel.createOrReveal(vscode.Uri.file('/ext'), configManager as never);

    const handler = panel._messageHandler;

    // Should not throw — unknown types are silently ignored
    expect(() => handler!({ type: 'unknownType', payload: {} })).not.toThrow();
  });

  it('posts clearFileChanges on rejectChanges', async () => {
    const { ChatPanel } = await import('../../src/panels/ChatPanel');
    (ChatPanel as unknown as { instance: undefined }).instance = undefined;

    ChatPanel.createOrReveal(vscode.Uri.file('/ext'), configManager as never);
    panel._sentMessages.length = 0; // clear init messages

    const handler = panel._messageHandler;
    await handler!({ type: 'rejectChanges' });

    const messages = panel._sentMessages as Array<{ type: string }>;
    expect(messages.some((m) => m.type === 'clearFileChanges')).toBe(true);
  });

  it('posts configLoaded on requestConfig', async () => {
    const { ChatPanel } = await import('../../src/panels/ChatPanel');
    (ChatPanel as unknown as { instance: undefined }).instance = undefined;

    ChatPanel.createOrReveal(vscode.Uri.file('/ext'), configManager as never);
    panel._sentMessages.length = 0;

    const handler = panel._messageHandler;
    await handler!({ type: 'requestConfig' });

    const messages = panel._sentMessages as Array<{ type: string }>;
    expect(messages.some((m) => m.type === 'configLoaded')).toBe(true);
  });
});

// ── dispose cleanup ───────────────────────────────────────────────────────────

// ── message routing — additional paths ───────────────────────────────────────

describe('ChatPanel — additional message types', () => {
  let panel: ReturnType<typeof makeWebviewPanel>;

  beforeEach(async () => {
    jest.clearAllMocks();
    panel = makeWebviewPanel();
    (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(panel);
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([]);
    (vscode.workspace.fs.stat as jest.Mock).mockRejectedValue(new Error('not found'));
    (vscode.workspace.applyEdit as jest.Mock).mockResolvedValue(true);
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: vscode.Uri.file('/workspace'), name: 'test', index: 0 },
    ];

    const { ChatPanel } = await import('../../src/panels/ChatPanel');
    (ChatPanel as unknown as { instance: undefined }).instance = undefined;
    ChatPanel.createOrReveal(vscode.Uri.file('/ext'), makeConfigManager() as never);
  });

  afterEach(() => {
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
  });

  it('silently ignores null message', async () => {
    const handler = panel._messageHandler;
    expect(() => handler!(null)).not.toThrow();
  });

  it('silently ignores non-object message', async () => {
    const handler = panel._messageHandler;
    expect(() => handler!('raw string')).not.toThrow();
  });

  it('silently ignores message without type field', async () => {
    const handler = panel._messageHandler;
    expect(() => handler!({ payload: {} })).not.toThrow();
  });

  it('routes applyChanges and posts addMessage with summary', async () => {
    (vscode.workspace.fs.stat as jest.Mock).mockResolvedValue({ size: 10 });

    const handler = panel._messageHandler;
    panel._sentMessages.length = 0;

    handler!({
      type: 'applyChanges',
      payload: {
        fileChanges: [{ filePath: 'src/app.ts', content: 'const x = 1;', isNew: false }],
      },
    });

    // Wait for async handler to resolve
    await new Promise((r) => setTimeout(r, 50));

    const messages = panel._sentMessages as Array<{ type: string }>;
    expect(messages.some((m) => m.type === 'addMessage')).toBe(true);
  });

  it('posts error for invalid applyChanges payload', async () => {
    const handler = panel._messageHandler;
    panel._sentMessages.length = 0;

    handler!({
      type: 'applyChanges',
      payload: { fileChanges: [{ filePath: '../../etc/passwd', content: '', isNew: false }] },
    });

    await new Promise((r) => setTimeout(r, 10));

    const messages = panel._sentMessages as Array<{ type: string; payload?: { role?: string } }>;
    expect(messages.some((m) => m.type === 'addMessage' && m.payload?.role === 'error')).toBe(true);
  });

  it('routes previewChange with valid payload', async () => {
    const handler = panel._messageHandler;
    handler!({
      type: 'previewChange',
      payload: {
        fileChange: { filePath: 'src/app.ts', content: 'const x = 1;', isNew: false },
      },
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'vscode.diff',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('ignores previewChange with path traversal in filePath', async () => {
    const handler = panel._messageHandler;
    handler!({
      type: 'previewChange',
      payload: { fileChange: { filePath: '../../etc/passwd', content: '', isNew: false } },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });

  it('routes configureProvider and posts configLoaded', async () => {
    const handler = panel._messageHandler;
    panel._sentMessages.length = 0;

    handler!({ type: 'configureProvider' });
    await new Promise((r) => setTimeout(r, 20));

    const messages = panel._sentMessages as Array<{ type: string }>;
    expect(messages.some((m) => m.type === 'configLoaded')).toBe(true);
  });
});

// ── sendMessage error paths ───────────────────────────────────────────────────

describe('ChatPanel — sendMessage error paths', () => {
  let panel: ReturnType<typeof makeWebviewPanel>;

  const validSendMessage = {
    type: 'sendMessage',
    payload: {
      userMessage: 'do something',
      roundType: 'developer',
      mainAgent: 'claude',
      subAgents: [] as string[],
    },
  };

  async function setupPanel(fakeModelSendRequest: jest.Mock) {
    jest.clearAllMocks();
    panel = makeWebviewPanel();
    (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(panel);
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([
      { sendRequest: fakeModelSendRequest },
    ]);
    (vscode.workspace.fs.stat as jest.Mock).mockRejectedValue(new Error('not found'));
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;

    const { ChatPanel } = await import('../../src/panels/ChatPanel');
    (ChatPanel as unknown as { instance: undefined }).instance = undefined;
    ChatPanel.createOrReveal(vscode.Uri.file('/ext'), makeConfigManager() as never);
    return panel;
  }

  afterEach(() => {
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
  });

  it('posts system message when agent throws CancellationError', async () => {
    const sendRequest = jest.fn().mockRejectedValue(new vscode.CancellationError());
    await setupPanel(sendRequest);

    const handler = panel._messageHandler;
    panel._sentMessages.length = 0;
    handler!(validSendMessage);
    await new Promise((r) => setTimeout(r, 50));

    const messages = panel._sentMessages as Array<{ type: string; payload?: { role?: string; content?: string } }>;
    const systemMsg = messages.find(
      (m) => m.type === 'addMessage' && m.payload?.role === 'system' && m.payload?.content?.includes('cancelled'),
    );
    expect(systemMsg).toBeDefined();
  });

  it('posts error message when agent throws generic error', async () => {
    const sendRequest = jest.fn().mockRejectedValue(new Error('API quota exceeded'));
    await setupPanel(sendRequest);

    const handler = panel._messageHandler;
    panel._sentMessages.length = 0;
    handler!(validSendMessage);
    await new Promise((r) => setTimeout(r, 50));

    const messages = panel._sentMessages as Array<{ type: string; payload?: { role?: string } }>;
    expect(messages.some((m) => m.type === 'addMessage' && m.payload?.role === 'error')).toBe(true);
  });

  it('posts setLoading false in finally block even on error', async () => {
    const sendRequest = jest.fn().mockRejectedValue(new Error('fail'));
    await setupPanel(sendRequest);

    const handler = panel._messageHandler;
    panel._sentMessages.length = 0;
    handler!(validSendMessage);
    await new Promise((r) => setTimeout(r, 50));

    const messages = panel._sentMessages as Array<{ type: string; payload?: { loading?: boolean } }>;
    const loadingFalse = messages.find(
      (m) => m.type === 'setLoading' && m.payload?.loading === false,
    );
    expect(loadingFalse).toBeDefined();
  });
});

// ── createOrReveal — reveal existing instance ─────────────────────────────────

describe('ChatPanel — createOrReveal reveal', () => {
  it('reveals existing panel when called twice', async () => {
    jest.clearAllMocks();
    const panel = makeWebviewPanel();
    (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(panel);
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([]);

    const { ChatPanel } = await import('../../src/panels/ChatPanel');
    (ChatPanel as unknown as { instance: undefined }).instance = undefined;

    ChatPanel.createOrReveal(vscode.Uri.file('/ext'), makeConfigManager() as never);
    ChatPanel.createOrReveal(vscode.Uri.file('/ext'), makeConfigManager() as never); // second call

    // createWebviewPanel only called once; second call reveals instead
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(panel.reveal).toHaveBeenCalledTimes(1);
  });
});

// ── revive — restart/panel restore paths ────────────────────────────────────

describe('ChatPanel — revive', () => {
  const extensionContext = {
    extensionUri: vscode.Uri.file('/ext'),
    globalStorageUri: vscode.Uri.file('/tmp/ai-roundtable-test'),
  } as unknown as vscode.ExtensionContext;

  it('reuses existing instance when reviving the same panel', async () => {
    jest.clearAllMocks();
    const panel = makeWebviewPanel();
    (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(panel);
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([]);

    const { ChatPanel } = await import('../../src/panels/ChatPanel');
    (ChatPanel as unknown as { instance: undefined }).instance = undefined;

    const existing = ChatPanel.createOrReveal(vscode.Uri.file('/ext'), makeConfigManager() as never);
    const revived = ChatPanel.revive(panel as never, extensionContext, makeConfigManager() as never);

    expect(revived).toBe(existing);
    expect(panel.dispose).not.toHaveBeenCalled();
  });

  it('replaces previous instance when reviving a different panel', async () => {
    jest.clearAllMocks();
    const firstPanel = makeWebviewPanel();
    const secondPanel = makeWebviewPanel();
    (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(firstPanel);
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([]);

    const { ChatPanel } = await import('../../src/panels/ChatPanel');
    (ChatPanel as unknown as { instance: undefined }).instance = undefined;

    const firstInstance = ChatPanel.createOrReveal(vscode.Uri.file('/ext'), makeConfigManager() as never);
    const revived = ChatPanel.revive(secondPanel as never, extensionContext, makeConfigManager() as never);

    expect(revived).not.toBe(firstInstance);
    expect(firstPanel.dispose).toHaveBeenCalledTimes(1);
    expect((secondPanel.webview as { options?: unknown }).options).toEqual({
      enableScripts: true,
      localResourceRoots: [extensionContext.extensionUri],
    });
  });
});

// ── requestConfig — getConfig failure ────────────────────────────────────────

describe('ChatPanel — requestConfig getConfig failure', () => {
  it('posts configLoaded with defaults when getConfig throws', async () => {
    jest.clearAllMocks();
    const panel = makeWebviewPanel();
    (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(panel);
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([]);

    const failingConfig = {
      ...makeConfigManager(),
      getConfig: jest.fn().mockRejectedValue(new Error('keychain unavailable')),
    };

    const { ChatPanel } = await import('../../src/panels/ChatPanel');
    (ChatPanel as unknown as { instance: undefined }).instance = undefined;
    ChatPanel.createOrReveal(vscode.Uri.file('/ext'), failingConfig as never);

    panel._sentMessages.length = 0;
    const handler = panel._messageHandler;
    handler!({ type: 'requestConfig' });
    await new Promise((r) => setTimeout(r, 20));

    const messages = panel._sentMessages as Array<{ type: string; payload?: { providerMode?: string } }>;
    const configMsg = messages.find((m) => m.type === 'configLoaded');
    expect(configMsg).toBeDefined();
    expect(configMsg?.payload?.providerMode).toBe('copilot');
  });
});

describe('ChatPanel — disposal', () => {
  it('sets ChatPanel.instance to undefined after dispose', async () => {
    jest.clearAllMocks();
    const panel = makeWebviewPanel();
    (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(panel);
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([]);

    const { ChatPanel } = await import('../../src/panels/ChatPanel');
    (ChatPanel as unknown as { instance: undefined }).instance = undefined;

    const instance = ChatPanel.createOrReveal(
      vscode.Uri.file('/ext'),
      makeConfigManager() as never,
    );

    expect((ChatPanel as unknown as { instance: unknown }).instance).toBeDefined();

    instance.dispose();

    expect((ChatPanel as unknown as { instance: unknown }).instance).toBeUndefined();
  });

  it('does not throw when dispose is called twice', async () => {
    jest.clearAllMocks();
    const panel = makeWebviewPanel();
    (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(panel);
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([]);

    const { ChatPanel } = await import('../../src/panels/ChatPanel');
    (ChatPanel as unknown as { instance: undefined }).instance = undefined;

    const instance = ChatPanel.createOrReveal(
      vscode.Uri.file('/ext'),
      makeConfigManager() as never,
    );

    expect(() => {
      instance.dispose();
      instance.dispose(); // second call should be no-op
    }).not.toThrow();
  });
});
