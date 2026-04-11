/**
 * Session persistence integration tests for ChatPanel:
 *  - panel open/clearChat do not create empty sessions
 *  - sendMessage completion appends turns
 *  - first successful send lazily creates a session
 *  - requestSessionList posts sessionListLoaded
 *  - restoreSession loads and restores state
 *  - storage failures do not break the chat
 */

jest.mock('vscode');
jest.mock('fs');

import * as vscode from 'vscode';
import * as fs from 'fs';
import { ChatPanel } from '../../src/panels/ChatPanel';
import type { FileChange } from '../../src/types';
import { AgentName, ProviderMode, RoundType } from '../../src/types';

const flushPromises = () => new Promise<void>((resolve) => setImmediate(resolve));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConfigManager() {
  return {
    getConfig: jest.fn().mockResolvedValue({
      providerMode: ProviderMode.API_KEYS,
      anthropicApiKey: 'sk-test',
      openaiApiKey: undefined,
      googleApiKey: undefined,
      deepseekApiKey: undefined,
      copilotModelFamily: undefined,
      runnerTimeoutMs: 30_000,
    }),
    configureProvider: jest.fn(),
  };
}

function createPanel(configManager = makeConfigManager(), globalStateGet?: jest.Mock) {
  (ChatPanel as unknown as { instance: undefined }).instance = undefined;
  (fs.readFileSync as jest.Mock).mockReturnValue('<html>{{NONCE}}</html>');
  (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
    { uri: { fsPath: '/workspace' }, name: 'test', index: 0 },
  ];

  const globalStateUpdate = jest.fn().mockResolvedValue(undefined);
  const globalStateGetFn = globalStateGet ?? jest.fn().mockReturnValue(undefined);

  const panel = ChatPanel.createOrReveal(
    {
      extensionUri: { fsPath: '/ext', scheme: 'file' } as vscode.Uri,
      globalStorageUri: { fsPath: '/global-storage', scheme: 'file' } as vscode.Uri,
      globalState: { get: globalStateGetFn, update: globalStateUpdate },
    } as unknown as vscode.ExtensionContext,
    configManager as never,
  );

  const webview = (vscode.window.createWebviewPanel as jest.Mock).mock.results[0]?.value?.webview;
  const onMessage = webview?.onDidReceiveMessage?.mock?.calls?.[0]?.[0] as
    | ((msg: unknown) => Promise<void>)
    | undefined;

  const postedMessages = () =>
    ((webview?.postMessage as jest.Mock).mock.calls ?? []).map((c: unknown[]) => c[0]) as Array<{
      type: string;
      payload?: unknown;
    }>;

  return { panel, onMessage, postedMessages, globalStateUpdate };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  (ChatPanel as unknown as { instance: undefined }).instance = undefined;
  // Default: fs operations succeed
  (vscode.workspace.fs.writeFile as jest.Mock).mockResolvedValue(undefined);
  (vscode.workspace.fs.createDirectory as jest.Mock).mockResolvedValue(undefined);
  (vscode.workspace.fs.readFile as jest.Mock).mockRejectedValue(new Error('not found'));
});

afterEach(() => {
  (ChatPanel as unknown as { instance: undefined }).instance = undefined;
});

// ── panel open (lazy session creation) ────────────────────────────────────────

describe('panel open', () => {
  it('does not create a session file on panel creation', async () => {
    createPanel();
    await flushPromises();

    expect(vscode.workspace.fs.createDirectory).not.toHaveBeenCalled();
    const sessionWrites = (vscode.workspace.fs.writeFile as jest.Mock).mock.calls.filter(
      (c) => (c[0] as vscode.Uri).fsPath.endsWith('.json') && !(c[0] as vscode.Uri).fsPath.endsWith('index.json'),
    );
    expect(sessionWrites).toHaveLength(0);
  });
});

// ── clearChat (still lazy) ────────────────────────────────────────────────────

describe('clearChat', () => {
  it('does not create a new session after clearing', async () => {
    const { onMessage } = createPanel();
    await flushPromises();

    const writesBefore = (vscode.workspace.fs.writeFile as jest.Mock).mock.calls.length;

    await onMessage?.({ type: 'clearChat' });
    await flushPromises();

    const writesAfter = (vscode.workspace.fs.writeFile as jest.Mock).mock.calls.length;
    expect(writesAfter).toBe(writesBefore);
  });

  it('creates first session lazily on first successful send (non-default round)', async () => {
    const fakeModel = {
      sendRequest: jest.fn().mockResolvedValue({
        stream: (async function* () {
          yield new vscode.LanguageModelTextPart('done');
        })(),
      }),
    };
    (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([fakeModel]);

    const configManager = {
      ...makeConfigManager(),
      getConfig: jest.fn().mockResolvedValue({
        providerMode: ProviderMode.COPILOT,
        anthropicApiKey: undefined,
        openaiApiKey: undefined,
        googleApiKey: undefined,
        deepseekApiKey: undefined,
        copilotModelFamily: undefined,
        runnerTimeoutMs: 30_000,
      }),
    };
    const { onMessage } = createPanel(configManager);
    await flushPromises();

    const writesBefore = (vscode.workspace.fs.writeFile as jest.Mock).mock.calls;
    const sessionPathsBefore = new Set(
      writesBefore
        .map((c) => (c[0] as vscode.Uri).fsPath)
        .filter((p) => p.endsWith('.json') && !p.endsWith('index.json')),
    );

    await onMessage?.({
      type: 'sendMessage',
      payload: {
        userMessage: 'Run QA checks',
        roundType: RoundType.QA,
        mainAgent: AgentName.CLAUDE,
        subAgents: [],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await flushPromises();

    const writesAfter = (vscode.workspace.fs.writeFile as jest.Mock).mock.calls;
    const sessionPathsAfter = new Set(
      writesAfter
        .map((c) => (c[0] as vscode.Uri).fsPath)
        .filter((p) => p.endsWith('.json') && !p.endsWith('index.json')),
    );

    expect(sessionPathsBefore.size).toBe(0);
    expect(sessionPathsAfter.size).toBe(1);
  });
});

// ── requestSessionList ────────────────────────────────────────────────────────

describe('requestSessionList', () => {
  it('posts sessionListLoaded with empty array when no sessions exist', async () => {
    const { onMessage, postedMessages } = createPanel();
    await flushPromises();

    await onMessage?.({ type: 'requestSessionList' });
    await flushPromises();

    const msg = postedMessages().find((m) => m.type === 'sessionListLoaded');
    expect(msg).toBeDefined();
    expect((msg?.payload as { sessions: unknown[] }).sessions).toEqual([]);
  });

  it('posts sessionListLoaded with sessions from index', async () => {
    const sessions = [
      { id: 's1', workspaceId: 'x', roundType: RoundType.DEVELOPER, createdAt: 1, updatedAt: 2, turnCount: 1, preview: 'hello' },
    ];
    (vscode.workspace.fs.readFile as jest.Mock).mockImplementation((uri: vscode.Uri) => {
      if (uri.fsPath.endsWith('index.json')) {
        return Promise.resolve(Buffer.from(JSON.stringify(sessions)));
      }
      return Promise.reject(new Error('not found'));
    });

    const { onMessage, postedMessages } = createPanel();
    await flushPromises();

    await onMessage?.({ type: 'requestSessionList' });
    await flushPromises();

    const msg = postedMessages().find((m) => m.type === 'sessionListLoaded');
    expect((msg?.payload as { sessions: typeof sessions }).sessions).toHaveLength(1);
    expect((msg?.payload as { sessions: typeof sessions }).sessions[0].id).toBe('s1');
  });
});

// ── restoreSession ────────────────────────────────────────────────────────────

describe('restoreSession', () => {
  it('posts sessionRestored with turns and roundType', async () => {
    const session = {
      id: 'sess-abc',
      workspaceId: 'x',
      roundType: RoundType.QA,
      createdAt: 1,
      updatedAt: 2,
      turns: [
        { role: 'user', content: 'write tests' },
        { role: 'assistant', content: 'here are your tests' },
      ],
    };
    (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(
      Buffer.from(JSON.stringify(session)),
    );

    const { onMessage, postedMessages } = createPanel();
    await flushPromises();

    await onMessage?.({ type: 'restoreSession', payload: { sessionId: 'sess-abc' } });
    await flushPromises();

    const msg = postedMessages().find((m) => m.type === 'sessionRestored');
    expect(msg).toBeDefined();
    const payload = msg?.payload as { turns: unknown[]; roundType: string };
    expect(payload.turns).toHaveLength(2);
    expect(payload.roundType).toBe(RoundType.QA);

    const msgs = postedMessages();
    expect(msgs.some((m) => m.type === 'clearFileChanges')).toBe(true);
    expect(msgs.some((m) => m.type === 'clearContextFiles')).toBe(true);
  });

  it('does not post sessionRestored if session file not found', async () => {
    (vscode.workspace.fs.readFile as jest.Mock).mockRejectedValue(new Error('not found'));

    const { onMessage, postedMessages } = createPanel();
    await flushPromises();

    await onMessage?.({ type: 'restoreSession', payload: { sessionId: 'missing' } });
    await flushPromises();

    const msg = postedMessages().find((m) => m.type === 'sessionRestored');
    expect(msg).toBeUndefined();
  });

  it('blocks restoreSession while panel is busy', async () => {
    const session = {
      id: 'sess-busy',
      workspaceId: 'x',
      roundType: RoundType.DEVELOPER,
      createdAt: 1,
      updatedAt: 2,
      turns: [{ role: 'user', content: 'hi' }],
    };
    (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(
      Buffer.from(JSON.stringify(session)),
    );

    const { panel, onMessage, postedMessages } = createPanel();
    await flushPromises();

    // Simulate busy state via in-flight local command source.
    (panel as unknown as { commandCancellationTokenSource: object }).commandCancellationTokenSource = {};

    await onMessage?.({ type: 'restoreSession', payload: { sessionId: 'sess-busy' } });
    await flushPromises();

    expect(postedMessages().some((m) => m.type === 'sessionRestored')).toBe(false);
    const systemMsg = postedMessages().find((m) => m.type === 'addMessage') as
      | { type: 'addMessage'; payload?: { role?: string; content?: string } }
      | undefined;
    expect(systemMsg?.payload?.role).toBe('system');
    expect(systemMsg?.payload?.content).toContain('Cannot restore history');
  });
});

// ── storage failure does not break chat ───────────────────────────────────────

describe('storage failure resilience', () => {
  it('does not throw when writeFile fails', async () => {
    (vscode.workspace.fs.writeFile as jest.Mock).mockRejectedValue(new Error('disk full'));

    expect(() => createPanel()).not.toThrow();
    await flushPromises();
    // No unhandled rejection — test simply passes
  });
});

// ── draft file changes ────────────────────────────────────────────────────────

describe('draft file changes', () => {
  const DRAFT_KEY = 'aiRoundtable.draftFileChanges';

  it('restores draft and posts restoreDraftFileChanges on requestConfig when draft exists', async () => {
    const draft = {
      fileChanges: [{ filePath: 'src/app.ts', content: 'const x = 1;', isNew: false }],
      roundType: RoundType.DEVELOPER,
      savedAt: Date.now() - 5 * 60 * 1000, // 5 mins ago
    };
    const globalStateGet = jest.fn().mockImplementation((key: string) =>
      key === DRAFT_KEY ? draft : undefined,
    );

    const { onMessage, postedMessages } = createPanel(makeConfigManager(), globalStateGet);
    await flushPromises();

    await onMessage?.({ type: 'requestConfig' });
    await flushPromises();

    const msg = postedMessages().find((m) => m.type === 'restoreDraftFileChanges');
    expect(msg).toBeDefined();
    const payload = msg?.payload as typeof draft;
    expect(payload.fileChanges).toHaveLength(1);
    expect(payload.fileChanges[0].filePath).toBe('src/app.ts');
    expect(payload.roundType).toBe(RoundType.DEVELOPER);
  });

  it('does NOT post restoreDraftFileChanges when no draft exists', async () => {
    const { onMessage, postedMessages } = createPanel();
    await flushPromises();

    await onMessage?.({ type: 'requestConfig' });
    await flushPromises();

    const msg = postedMessages().find((m) => m.type === 'restoreDraftFileChanges');
    expect(msg).toBeUndefined();
  });

  it('clears draft on rejectChanges', async () => {
    const { onMessage, globalStateUpdate } = createPanel();
    await flushPromises();

    await onMessage?.({ type: 'rejectChanges' });
    await flushPromises();

    expect(globalStateUpdate).toHaveBeenCalledWith(DRAFT_KEY, undefined);
  });

  it('clears draft on clearChat', async () => {
    const { onMessage, globalStateUpdate } = createPanel();
    await flushPromises();

    await onMessage?.({ type: 'clearChat' });
    await flushPromises();

    expect(globalStateUpdate).toHaveBeenCalledWith(DRAFT_KEY, undefined);
  });

  it('does not post restoreDraftFileChanges when draft has empty fileChanges', async () => {
    const draft = { fileChanges: [] as FileChange[], roundType: RoundType.DEVELOPER, savedAt: Date.now() };
    const globalStateGet = jest.fn().mockImplementation((key: string) =>
      key === DRAFT_KEY ? draft : undefined,
    );

    const { onMessage, postedMessages } = createPanel(makeConfigManager(), globalStateGet);
    await flushPromises();

    await onMessage?.({ type: 'requestConfig' });
    await flushPromises();

    const msg = postedMessages().find((m) => m.type === 'restoreDraftFileChanges');
    expect(msg).toBeUndefined();
  });
});
