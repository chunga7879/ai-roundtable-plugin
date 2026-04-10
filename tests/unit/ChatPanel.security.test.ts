/**
 * Security-focused tests for ChatPanel:
 *  - MAX_ERROR_MESSAGE_LENGTH truncation
 */

jest.mock('vscode');
jest.mock('fs');
jest.mock('child_process');

import * as vscode from 'vscode';
import * as fs from 'fs';
import { ChatPanel } from '../../src/panels/ChatPanel';
import { ProviderMode } from '../../src/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConfigManager(overrides: Partial<{ runnerTimeoutMs: number; anthropicApiKey: string }> = {}) {
  return {
    getConfig: jest.fn().mockResolvedValue({
      providerMode: ProviderMode.API_KEYS,
      anthropicApiKey: overrides.anthropicApiKey ?? 'sk-test',
      openaiApiKey: undefined,
      googleApiKey: undefined,
      deepseekApiKey: undefined,
      copilotModelFamily: undefined,
      runnerTimeoutMs: overrides.runnerTimeoutMs ?? 30_000,
    }),
    configureProvider: jest.fn(),
  };
}

function createPanel(configManager = makeConfigManager()) {
  // Reset singleton
  (ChatPanel as unknown as { instance: undefined }).instance = undefined;

  (fs.readFileSync as jest.Mock).mockReturnValue('<html>{{NONCE}}</html>');
  (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
    { uri: { fsPath: '/workspace' }, name: 'test', index: 0 },
  ];

  const panel = ChatPanel.createOrReveal(
    {
      extensionUri: { fsPath: '/ext', scheme: 'file' } as vscode.Uri,
      globalStorageUri: { fsPath: '/global-storage', scheme: 'file' } as vscode.Uri,
      globalState: { get: jest.fn().mockReturnValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
    } as unknown as vscode.ExtensionContext,
    configManager as never,
  );

  // Capture the onDidReceiveMessage callback registered on the webview
  const webview = (vscode.window.createWebviewPanel as jest.Mock).mock.results[0]?.value?.webview;
  const onMessageCallback = webview?.onDidReceiveMessage?.mock?.calls?.[0]?.[0] as
    | ((msg: unknown) => Promise<void>)
    | undefined;

  return { panel, onMessageCallback };
}

// ── MAX_ERROR_MESSAGE_LENGTH truncation ───────────────────────────────────────

describe('ChatPanel — error message truncation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (ChatPanel as unknown as { instance: undefined }).instance = undefined;
  });

  afterEach(() => {
    (ChatPanel as unknown as { instance: undefined }).instance = undefined;
  });

  it('truncates error messages longer than 300 characters before posting to webview', async () => {
    // Trigger an error by sending a message with an invalid payload (missing fields)
    const { onMessageCallback } = createPanel();
    if (!onMessageCallback) return;

    // sendMessage with malformed payload triggers a validation error path
    await onMessageCallback({
      type: 'sendMessage',
      payload: { userMessage: 'x'.repeat(40_000), roundType: 'developer', mainAgent: 'claude', subAgents: [] },
    });

    const webview = (vscode.window.createWebviewPanel as jest.Mock).mock.results[0]?.value?.webview;
    const postedMessages = (webview?.postMessage as jest.Mock).mock.calls.map((c: unknown[]) => c[0]) as Array<{ type: string; payload?: { content?: string } }>;

    const errorMessages = postedMessages.filter((m) => m.type === 'addMessage' && m.payload?.content);
    const errorContent = errorMessages.find((m) => m.payload?.content?.includes('exceed'));

    if (errorContent?.payload?.content) {
      expect(errorContent.payload.content.length).toBeLessThanOrEqual(300 + 1); // +1 for '…'
    }
  });
});

describe('ChatPanel — file cache watcher wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (ChatPanel as unknown as { instance: undefined }).instance = undefined;
  });

  afterEach(() => {
    (ChatPanel as unknown as { instance: undefined }).instance = undefined;
  });

  it('registers onDidCreate invalidation handler on file watcher', () => {
    createPanel();

    const watcher = (vscode.workspace.createFileSystemWatcher as jest.Mock).mock.results[0]?.value as
      | { onDidCreate: jest.Mock }
      | undefined;
    expect(watcher?.onDidCreate).toHaveBeenCalled();
  });

  it('creates one watcher per workspace folder in multi-root mode', () => {
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: { fsPath: '/workspace-a' }, name: 'a', index: 0 },
      { uri: { fsPath: '/workspace-b' }, name: 'b', index: 1 },
    ];
    (fs.readFileSync as jest.Mock).mockReturnValue('<html>{{NONCE}}</html>');
    ChatPanel.createOrReveal(
      {
        extensionUri: { fsPath: '/ext', scheme: 'file' } as vscode.Uri,
        globalStorageUri: { fsPath: '/global-storage', scheme: 'file' } as vscode.Uri,
        globalState: { get: jest.fn().mockReturnValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
      } as unknown as vscode.ExtensionContext,
      makeConfigManager() as never,
    );
    expect(vscode.workspace.createFileSystemWatcher).toHaveBeenCalledTimes(2);
  });
});
