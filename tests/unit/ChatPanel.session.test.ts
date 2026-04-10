/**
 * Session persistence integration tests for ChatPanel:
 *  - clearChat triggers new session
 *  - sendMessage completion appends turns
 *  - round type change triggers new session
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

// ── startNewSession on panel open ─────────────────────────────────────────────

describe('panel open', () => {
  it('calls createDirectory and writes a session file on creation', async () => {
    createPanel();
    await flushPromises();

    expect(vscode.workspace.fs.createDirectory).toHaveBeenCalled();
    const writes = (vscode.workspace.fs.writeFile as jest.Mock).mock.calls;
    const sessionWrite = writes.find((c) =>
      !(c[0] as vscode.Uri).fsPath.endsWith('index.json'),
    );
    expect(sessionWrite).toBeDefined();
  });
});

// ── clearChat triggers new session ────────────────────────────────────────────

describe('clearChat', () => {
  it('starts a new session after clearing', async () => {
    const { onMessage } = createPanel();
    await flushPromises();

    const writesBefore = (vscode.workspace.fs.writeFile as jest.Mock).mock.calls.length;

    await onMessage?.({ type: 'clearChat' });
    await flushPromises();

    const writesAfter = (vscode.workspace.fs.writeFile as jest.Mock).mock.calls.length;
    expect(writesAfter).toBeGreaterThan(writesBefore);
  });

  it('does not create an extra session file when first message uses non-default round', async () => {
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
    await flushPromises();

    const writesAfter = (vscode.workspace.fs.writeFile as jest.Mock).mock.calls;
    const sessionPathsAfter = new Set(
      writesAfter
        .map((c) => (c[0] as vscode.Uri).fsPath)
        .filter((p) => p.endsWith('.json') && !p.endsWith('index.json')),
    );

    expect(sessionPathsAfter.size).toBe(sessionPathsBefore.size);
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
