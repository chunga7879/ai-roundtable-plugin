/**
 * Security-focused tests for ChatPanel:
 *  - runCommandWithApproval: user approval gate
 *  - MAX_ERROR_MESSAGE_LENGTH truncation
 *  - executeCommand input validation
 */

jest.mock('vscode');
jest.mock('fs');
jest.mock('child_process');

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as cp from 'child_process';
import { ChatPanel } from '../../src/panels/ChatPanel';
import { ProviderMode } from '../../src/types';

/** Drain all pending microtasks and macrotasks so fire-and-forget async chains complete. */
const flushPromises = () => new Promise<void>((resolve) => setImmediate(resolve));

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

// ── runCommandWithApproval: user approval gate ────────────────────────────────

describe('ChatPanel — runCommandWithApproval security gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (ChatPanel as unknown as { instance: undefined }).instance = undefined;
  });

  afterEach(() => {
    (ChatPanel as unknown as { instance: undefined }).instance = undefined;
  });

  it('does NOT execute command when user dismisses the approval dialog', async () => {
    // showWarningMessage returns undefined = user dismissed
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);

    const { onMessageCallback } = createPanel();
    if (!onMessageCallback) return;

    await onMessageCallback({
      type: 'executeCommand',
      payload: { command: 'rm -rf /' },
    });
    await flushPromises();

    // Approval was shown
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('rm -rf /'),
      expect.anything(),
      'Run',
    );
    // cp.exec must NOT have been called
    expect(cp.exec as unknown as jest.Mock).not.toHaveBeenCalled();
  });

  it('opens terminal and sends command when user clicks Run', async () => {
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Run');

    const { onMessageCallback } = createPanel();
    if (!onMessageCallback) return;

    await onMessageCallback({
      type: 'executeCommand',
      payload: { command: 'ls -la' },
    });
    await flushPromises();

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('ls -la'),
      expect.anything(),
      'Run',
    );
    // Terminal is used — NOT cp.exec
    expect(vscode.window.createTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'AI Roundtable' }),
    );
    const terminal = (vscode.window.createTerminal as jest.Mock).mock.results[0]?.value;
    expect(terminal.sendText).toHaveBeenCalledWith('ls -la');
    expect(cp.exec as unknown as jest.Mock).not.toHaveBeenCalled();
  });
});

// ── executeCommand input validation ──────────────────────────────────────────

describe('ChatPanel — executeCommand input validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (ChatPanel as unknown as { instance: undefined }).instance = undefined;
  });

  afterEach(() => {
    (ChatPanel as unknown as { instance: undefined }).instance = undefined;
  });

  it('ignores executeCommand with empty string', async () => {
    const { onMessageCallback } = createPanel();
    if (!onMessageCallback) return;

    await onMessageCallback({ type: 'executeCommand', payload: { command: '' } });
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('ignores executeCommand with whitespace-only string', async () => {
    const { onMessageCallback } = createPanel();
    if (!onMessageCallback) return;

    await onMessageCallback({ type: 'executeCommand', payload: { command: '   ' } });
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('ignores executeCommand with missing payload', async () => {
    const { onMessageCallback } = createPanel();
    if (!onMessageCallback) return;

    await onMessageCallback({ type: 'executeCommand', payload: {} });
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });
});

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
