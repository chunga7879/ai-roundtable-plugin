/**
 * Tests for extension.ts: ConfigManager and activate().
 *
 * Covers: getConfig branches, storeApiKey validation, clearAllApiKeys,
 * setModelTier/setProviderMode, configureProvider UI flows,
 * activate() command registration, runFirstTimeSetupIfNeeded branches.
 */
import * as vscode from 'vscode';
import { ConfigManager, activate, deactivate, DIFF_SCHEME, diffContentStore } from '../../src/extension';
import { ProviderMode } from '../../src/types';
import { ConfigurationError } from '../../src/errors';

const mockWs = vscode.workspace as jest.Mocked<typeof vscode.workspace>;
const mockWin = vscode.window as jest.Mocked<typeof vscode.window>;
const mockLm = vscode.lm as jest.Mocked<typeof vscode.lm>;
const mockCmds = vscode.commands as jest.Mocked<typeof vscode.commands>;

function makeSecretStorage(overrides: Partial<vscode.SecretStorage> = {}): vscode.SecretStorage {
  return {
    get: jest.fn().mockResolvedValue(undefined),
    store: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
    onDidChange: jest.fn(),
    ...overrides,
  } as unknown as vscode.SecretStorage;
}

function makeContext(secrets?: vscode.SecretStorage): vscode.ExtensionContext {
  return {
    secrets: secrets ?? makeSecretStorage(),
    subscriptions: { push: jest.fn() },
    globalStorageUri: vscode.Uri.file('/tmp/ai-roundtable-test-storage'),
  } as unknown as vscode.ExtensionContext;
}

afterEach(() => {
  jest.clearAllMocks();
  diffContentStore.clear();
});

// ── ConfigManager.getConfig ───────────────────────────────────────────────────

describe('ConfigManager.getConfig', () => {
  it('returns copilot mode by default', async () => {
    const cfg = mockWs.getConfiguration as jest.Mock;
    cfg.mockReturnValue({
      get: jest.fn((key: string) => {
        if (key === 'providerMode') return 'copilot';
        if (key === 'copilotModelFamily') return 'auto';
        if (key === 'modelTier') return 'heavy';
        if (key === 'runnerTimeout') return 60;
        return undefined;
      }),
    });
    const secrets = makeSecretStorage();
    const manager = new ConfigManager(secrets);
    const config = await manager.getConfig();

    expect(config.providerMode).toBe(ProviderMode.COPILOT);
    expect(config.copilotModelFamily).toBeUndefined(); // 'auto' → undefined
    expect(config.modelTier).toBe('heavy');
    expect(config.runnerTimeoutMs).toBe(60_000);
    expect(config.enableMetrics).toBe(false);
  });

  it('returns API_KEYS mode when set', async () => {
    const cfg = mockWs.getConfiguration as jest.Mock;
    cfg.mockReturnValue({
      get: jest.fn((key: string) => {
        if (key === 'providerMode') return 'api_keys';
        if (key === 'copilotModelFamily') return 'auto';
        if (key === 'modelTier') return 'heavy';
        if (key === 'runnerTimeout') return 60;
        return undefined;
      }),
    });
    const manager = new ConfigManager(makeSecretStorage());
    const config = await manager.getConfig();
    expect(config.providerMode).toBe(ProviderMode.API_KEYS);
  });

  it('sets modelTier to light when configured', async () => {
    const cfg = mockWs.getConfiguration as jest.Mock;
    cfg.mockReturnValue({
      get: jest.fn((key: string) => {
        if (key === 'modelTier') return 'light';
        if (key === 'runnerTimeout') return 60;
        return undefined;
      }),
    });
    const manager = new ConfigManager(makeSecretStorage());
    const config = await manager.getConfig();
    expect(config.modelTier).toBe('light');
  });

  it('enables metrics when explicitly configured', async () => {
    const cfg = mockWs.getConfiguration as jest.Mock;
    cfg.mockReturnValue({
      get: jest.fn((key: string) => {
        if (key === 'enableMetrics') return true;
        if (key === 'runnerTimeout') return 60;
        return undefined;
      }),
    });
    const manager = new ConfigManager(makeSecretStorage());
    const config = await manager.getConfig();
    expect(config.enableMetrics).toBe(true);
  });

  it('preserves explicit copilotModelFamily', async () => {
    const cfg = mockWs.getConfiguration as jest.Mock;
    cfg.mockReturnValue({
      get: jest.fn((key: string) => {
        if (key === 'copilotModelFamily') return 'gpt-4o';
        if (key === 'runnerTimeout') return 60;
        return undefined;
      }),
    });
    const manager = new ConfigManager(makeSecretStorage());
    const config = await manager.getConfig();
    expect(config.copilotModelFamily).toBe('gpt-4o');
  });

  it('clamps runnerTimeout to min 10s', async () => {
    const cfg = mockWs.getConfiguration as jest.Mock;
    cfg.mockReturnValue({
      get: jest.fn((key: string) => {
        if (key === 'runnerTimeout') return 1; // below min
        return undefined;
      }),
    });
    const manager = new ConfigManager(makeSecretStorage());
    const config = await manager.getConfig();
    expect(config.runnerTimeoutMs).toBe(10_000);
  });

  it('clamps runnerTimeout to max 600s', async () => {
    const cfg = mockWs.getConfiguration as jest.Mock;
    cfg.mockReturnValue({
      get: jest.fn((key: string) => {
        if (key === 'runnerTimeout') return 9999; // above max
        return undefined;
      }),
    });
    const manager = new ConfigManager(makeSecretStorage());
    const config = await manager.getConfig();
    expect(config.runnerTimeoutMs).toBe(600_000);
  });

  it('returns api keys from secret storage', async () => {
    const cfg = mockWs.getConfiguration as jest.Mock;
    cfg.mockReturnValue({ get: jest.fn().mockReturnValue(undefined) });
    const secrets = makeSecretStorage({
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'aiRoundtable.anthropicApiKey') return Promise.resolve('sk-ant-xxx');
        if (key === 'aiRoundtable.openaiApiKey') return Promise.resolve('sk-openai-yyy');
        if (key === 'aiRoundtable.googleApiKey') return Promise.resolve('AIzaZZZ');
        if (key === 'aiRoundtable.deepseekApiKey') return Promise.resolve('sk-ds-000');
        return Promise.resolve(undefined);
      }),
    });
    const manager = new ConfigManager(secrets);
    const config = await manager.getConfig();
    expect(config.anthropicApiKey).toBe('sk-ant-xxx');
    expect(config.openaiApiKey).toBe('sk-openai-yyy');
    expect(config.googleApiKey).toBe('AIzaZZZ');
    expect(config.deepseekApiKey).toBe('sk-ds-000');
  });

  it('throws ConfigurationError when secret storage fails', async () => {
    const cfg = mockWs.getConfiguration as jest.Mock;
    cfg.mockReturnValue({ get: jest.fn().mockReturnValue(undefined) });
    const secrets = makeSecretStorage({
      get: jest.fn().mockRejectedValue(new Error('vault locked')),
    });
    const manager = new ConfigManager(secrets);
    await expect(manager.getConfig()).rejects.toBeInstanceOf(ConfigurationError);
  });
});

// ── ConfigManager.setModelTier / setProviderMode ──────────────────────────────

describe('ConfigManager.setModelTier', () => {
  it('calls vsConfig.update with the given tier', async () => {
    const updateMock = jest.fn().mockResolvedValue(undefined);
    (mockWs.getConfiguration as jest.Mock).mockReturnValue({ update: updateMock });
    const manager = new ConfigManager(makeSecretStorage());
    await manager.setModelTier('light');
    expect(updateMock).toHaveBeenCalledWith('modelTier', 'light', vscode.ConfigurationTarget.Global);
  });
});

describe('ConfigManager.setProviderMode', () => {
  it('calls vsConfig.update with the given mode', async () => {
    const updateMock = jest.fn().mockResolvedValue(undefined);
    (mockWs.getConfiguration as jest.Mock).mockReturnValue({ update: updateMock });
    const manager = new ConfigManager(makeSecretStorage());
    await manager.setProviderMode(ProviderMode.API_KEYS);
    expect(updateMock).toHaveBeenCalledWith('providerMode', ProviderMode.API_KEYS, vscode.ConfigurationTarget.Global);
  });
});

// ── ConfigManager.storeApiKey ─────────────────────────────────────────────────

describe('ConfigManager.storeApiKey', () => {
  it('throws ConfigurationError for key that is too short', async () => {
    const manager = new ConfigManager(makeSecretStorage());
    await expect(manager.storeApiKey('anthropic', 'short')).rejects.toBeInstanceOf(ConfigurationError);
  });

  it('throws ConfigurationError for empty key', async () => {
    const manager = new ConfigManager(makeSecretStorage());
    await expect(manager.storeApiKey('openai', '')).rejects.toBeInstanceOf(ConfigurationError);
  });

  it('stores anthropic key', async () => {
    const storeMock = jest.fn().mockResolvedValue(undefined);
    const manager = new ConfigManager(makeSecretStorage({ store: storeMock }));
    await manager.storeApiKey('anthropic', 'sk-ant-valid-key-here');
    expect(storeMock).toHaveBeenCalledWith('aiRoundtable.anthropicApiKey', 'sk-ant-valid-key-here');
  });

  it('stores openai key', async () => {
    const storeMock = jest.fn().mockResolvedValue(undefined);
    const manager = new ConfigManager(makeSecretStorage({ store: storeMock }));
    await manager.storeApiKey('openai', 'sk-openai-valid-key-here');
    expect(storeMock).toHaveBeenCalledWith('aiRoundtable.openaiApiKey', 'sk-openai-valid-key-here');
  });

  it('stores google key', async () => {
    const storeMock = jest.fn().mockResolvedValue(undefined);
    const manager = new ConfigManager(makeSecretStorage({ store: storeMock }));
    await manager.storeApiKey('google', 'AIzaSyValid-key-xxxx');
    expect(storeMock).toHaveBeenCalledWith('aiRoundtable.googleApiKey', 'AIzaSyValid-key-xxxx');
  });

  it('stores deepseek key', async () => {
    const storeMock = jest.fn().mockResolvedValue(undefined);
    const manager = new ConfigManager(makeSecretStorage({ store: storeMock }));
    await manager.storeApiKey('deepseek', 'sk-deepseek-valid-key');
    expect(storeMock).toHaveBeenCalledWith('aiRoundtable.deepseekApiKey', 'sk-deepseek-valid-key');
  });

  it('throws ConfigurationError when store fails', async () => {
    const manager = new ConfigManager(makeSecretStorage({
      store: jest.fn().mockRejectedValue(new Error('disk full')),
    }));
    await expect(manager.storeApiKey('anthropic', 'sk-ant-valid-key-here')).rejects.toBeInstanceOf(ConfigurationError);
  });
});

// ── ConfigManager.clearAllApiKeys ─────────────────────────────────────────────

describe('ConfigManager.clearAllApiKeys', () => {
  it('deletes all 4 keys', async () => {
    const deleteMock = jest.fn().mockResolvedValue(undefined);
    const manager = new ConfigManager(makeSecretStorage({ delete: deleteMock }));
    await manager.clearAllApiKeys();
    expect(deleteMock).toHaveBeenCalledTimes(4);
    expect(deleteMock).toHaveBeenCalledWith('aiRoundtable.anthropicApiKey');
    expect(deleteMock).toHaveBeenCalledWith('aiRoundtable.openaiApiKey');
    expect(deleteMock).toHaveBeenCalledWith('aiRoundtable.googleApiKey');
    expect(deleteMock).toHaveBeenCalledWith('aiRoundtable.deepseekApiKey');
  });

  it('throws ConfigurationError when delete fails', async () => {
    const manager = new ConfigManager(makeSecretStorage({
      delete: jest.fn().mockRejectedValue(new Error('locked')),
    }));
    await expect(manager.clearAllApiKeys()).rejects.toBeInstanceOf(ConfigurationError);
  });
});

// ── ConfigManager.configureProvider ──────────────────────────────────────────

describe('ConfigManager.configureProvider', () => {
  it('returns early when user cancels quick pick', async () => {
    mockWin.showQuickPick.mockResolvedValue(undefined);
    const manager = new ConfigManager(makeSecretStorage());
    await expect(manager.configureProvider()).resolves.toBeUndefined();
    expect(mockWin.showInputBox).not.toHaveBeenCalled();
  });

  it('sets provider to copilot and shows info message', async () => {
    const updateMock = jest.fn().mockResolvedValue(undefined);
    (mockWs.getConfiguration as jest.Mock).mockReturnValue({ update: updateMock });
    mockWin.showQuickPick.mockResolvedValue({
      label: '$(github) GitHub Copilot',
      value: ProviderMode.COPILOT,
    } as unknown as vscode.QuickPickItem);

    const manager = new ConfigManager(makeSecretStorage());
    await manager.configureProvider();

    expect(updateMock).toHaveBeenCalledWith('providerMode', ProviderMode.COPILOT, vscode.ConfigurationTarget.Global);
    expect(mockWin.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('GitHub Copilot'),
    );
  });

  it('sets provider to API keys and prompts for keys', async () => {
    const updateMock = jest.fn().mockResolvedValue(undefined);
    (mockWs.getConfiguration as jest.Mock).mockReturnValue({ update: updateMock });
    mockWin.showQuickPick.mockResolvedValue({
      label: '$(key) API Keys',
      value: ProviderMode.API_KEYS,
    } as unknown as vscode.QuickPickItem);
    // User skips all key inputs
    mockWin.showInputBox.mockResolvedValue(undefined);

    const manager = new ConfigManager(makeSecretStorage());
    await manager.configureProvider();

    expect(updateMock).toHaveBeenCalledWith('providerMode', ProviderMode.API_KEYS, vscode.ConfigurationTarget.Global);
    // promptForApiKeys loops over 4 providers
    expect(mockWin.showInputBox).toHaveBeenCalledTimes(4);
  });

  it('saves entered API keys and shows confirmation', async () => {
    const storeMock = jest.fn().mockResolvedValue(undefined);
    const updateMock = jest.fn().mockResolvedValue(undefined);
    (mockWs.getConfiguration as jest.Mock).mockReturnValue({ update: updateMock });
    mockWin.showQuickPick.mockResolvedValue({
      label: '$(key) API Keys',
      value: ProviderMode.API_KEYS,
    } as unknown as vscode.QuickPickItem);
    mockWin.showInputBox
      .mockResolvedValueOnce('sk-ant-valid-key-anthropic') // anthropic
      .mockResolvedValueOnce(undefined)                    // openai skipped
      .mockResolvedValueOnce(undefined)                    // google skipped
      .mockResolvedValueOnce(undefined);                   // deepseek skipped

    const manager = new ConfigManager(makeSecretStorage({ store: storeMock }));
    await manager.configureProvider();

    expect(storeMock).toHaveBeenCalledWith('aiRoundtable.anthropicApiKey', 'sk-ant-valid-key-anthropic');
    expect(mockWin.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('1 API key(s) saved'),
    );
  });

  it('shows warning when no keys entered', async () => {
    const updateMock = jest.fn().mockResolvedValue(undefined);
    (mockWs.getConfiguration as jest.Mock).mockReturnValue({ update: updateMock });
    mockWin.showQuickPick.mockResolvedValue({
      label: '$(key) API Keys',
      value: ProviderMode.API_KEYS,
    } as unknown as vscode.QuickPickItem);
    mockWin.showInputBox.mockResolvedValue(undefined);

    const manager = new ConfigManager(makeSecretStorage());
    await manager.configureProvider();

    expect(mockWin.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('No API keys were saved'),
    );
  });

  it('shows warning and continues when one store fails', async () => {
    const storeMock = jest.fn().mockRejectedValue(new Error('vault locked'));
    const updateMock = jest.fn().mockResolvedValue(undefined);
    (mockWs.getConfiguration as jest.Mock).mockReturnValue({ update: updateMock });
    mockWin.showQuickPick.mockResolvedValue({
      label: '$(key) API Keys',
      value: ProviderMode.API_KEYS,
    } as unknown as vscode.QuickPickItem);
    mockWin.showInputBox.mockResolvedValue('sk-ant-valid-long-key-here');

    const manager = new ConfigManager(makeSecretStorage({ store: storeMock }));
    await manager.configureProvider(); // must not throw

    expect(mockWin.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to save'),
    );
  });
});

// ── activate() — command & provider registration ─────────────────────────────

describe('activate()', () => {
  beforeEach(() => {
    (mockWs.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn().mockReturnValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
    });
    (makeSecretStorage().get as jest.Mock);
    mockLm.selectChatModels.mockResolvedValue([{ id: 'copilot-model' }] as unknown as vscode.LanguageModelChat[]);
  });

  it('registers commands and 1 document provider', async () => {
    const secrets = makeSecretStorage();
    const context = makeContext(secrets);
    await activate(context);

    expect(mockWs.registerTextDocumentContentProvider).toHaveBeenCalledWith(
      DIFF_SCHEME,
      expect.objectContaining({ provideTextDocumentContent: expect.any(Function) }),
    );
    expect(mockCmds.registerCommand).toHaveBeenCalledWith('aiRoundtable.openPanel', expect.any(Function));
    expect(mockCmds.registerCommand).toHaveBeenCalledWith('aiRoundtable.configureProvider', expect.any(Function));
    expect(mockCmds.registerCommand).toHaveBeenCalledWith('aiRoundtable.clearApiKeys', expect.any(Function));
    expect(mockCmds.registerCommand).toHaveBeenCalledWith('aiRoundtable.showAbReport', expect.any(Function));
    expect(mockCmds.registerCommand).toHaveBeenCalledWith('aiRoundtable.clearMetrics', expect.any(Function));
    expect((context.subscriptions as unknown as { push: jest.Mock }).push).toHaveBeenCalled();
  });

  it('document provider returns content from diffContentStore', async () => {
    diffContentStore.set('/test/file.ts', 'const x = 1;');
    const context = makeContext(makeSecretStorage());
    await activate(context);

    const [, provider] = (mockWs.registerTextDocumentContentProvider as jest.Mock).mock.calls[0];
    const content = provider.provideTextDocumentContent(vscode.Uri.file('/test/file.ts'));
    expect(content).toBe('const x = 1;');
  });

  it('document provider returns empty string for unknown uri', async () => {
    const context = makeContext(makeSecretStorage());
    await activate(context);

    const [, provider] = (mockWs.registerTextDocumentContentProvider as jest.Mock).mock.calls[0];
    const content = provider.provideTextDocumentContent(vscode.Uri.file('/unknown/path.ts'));
    expect(content).toBe('');
  });
});

describe('activate() — metrics commands', () => {
  beforeEach(() => {
    (mockWs.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn((key: string) => {
        if (key === 'providerMode') return ProviderMode.API_KEYS;
        if (key === 'enableMetrics') return false;
        if (key === 'runnerTimeout') return 60;
        return undefined;
      }),
      update: jest.fn().mockResolvedValue(undefined),
    });
    mockLm.selectChatModels.mockResolvedValue([{ id: 'copilot-model' }] as unknown as vscode.LanguageModelChat[]);
  });

  function getCommandHandler(commandId: string): (() => void) | undefined {
    const calls = (mockCmds.registerCommand as jest.Mock).mock.calls as Array<[string, () => void]>;
    const hit = calls.find(([id]) => id === commandId);
    return hit?.[1];
  }

  it('shows guidance when A/B report is requested while metrics are disabled', async () => {
    const context = makeContext(makeSecretStorage());
    await activate(context);
    const handler = getCommandHandler('aiRoundtable.showAbReport');

    handler?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockWin.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('Metrics collection is disabled'),
    );
  });

  it('clears metrics for the current workspace', async () => {
    const context = makeContext(makeSecretStorage());
    await activate(context);
    const handler = getCommandHandler('aiRoundtable.clearMetrics');

    expect(handler).toBeDefined();
    handler?.();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mockWin.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('Metrics for this workspace were cleared'),
    );
  });
});

// ── runFirstTimeSetupIfNeeded — copilot not found ─────────────────────────────

describe('activate() — first-run setup: copilot not found', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('shows prompt when copilot mode and no models found', async () => {
    (mockWs.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn((key: string) => {
        if (key === 'providerMode') return ProviderMode.COPILOT;
        if (key === 'runnerTimeout') return 60;
        return undefined;
      }),
    });
    mockLm.selectChatModels.mockResolvedValue([]);
    mockWin.showInformationMessage.mockResolvedValue(undefined); // user clicks nothing

    const secrets = makeSecretStorage();
    const context = makeContext(secrets);
    await activate(context);

    // Advance past the 2-second defer
    await jest.advanceTimersByTimeAsync(2100);

    expect(mockLm.selectChatModels).toHaveBeenCalledWith({ vendor: 'copilot' });
    expect(mockWin.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('GitHub Copilot was not found'),
      'Configure API Keys',
      'Later',
    );
  });

  it('does not show prompt when copilot models are available', async () => {
    (mockWs.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn((key: string) => {
        if (key === 'providerMode') return ProviderMode.COPILOT;
        if (key === 'runnerTimeout') return 60;
        return undefined;
      }),
    });
    mockLm.selectChatModels.mockResolvedValue([{ id: 'copilot-gpt' }] as unknown as vscode.LanguageModelChat[]);

    const context = makeContext(makeSecretStorage());
    await activate(context);
    await jest.advanceTimersByTimeAsync(2100);

    expect(mockWin.showInformationMessage).not.toHaveBeenCalledWith(
      expect.stringContaining('GitHub Copilot was not found'),
      expect.anything(),
      expect.anything(),
    );
  });

  it('skips copilot check when provider mode is API_KEYS', async () => {
    (mockWs.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn((key: string) => {
        if (key === 'providerMode') return ProviderMode.API_KEYS;
        if (key === 'runnerTimeout') return 60;
        return undefined;
      }),
    });

    const context = makeContext(makeSecretStorage());
    await activate(context);
    await jest.advanceTimersByTimeAsync(2100);

    expect(mockLm.selectChatModels).not.toHaveBeenCalled();
  });

  it('silently continues when getConfig throws during first-run', async () => {
    (mockWs.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn().mockReturnValue(undefined),
    });
    const secrets = makeSecretStorage({
      get: jest.fn().mockRejectedValue(new Error('vault locked')),
    });
    const context = makeContext(secrets);
    await expect(activate(context)).resolves.toBeUndefined();
  });

  it('silently continues when selectChatModels throws', async () => {
    (mockWs.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn((key: string) => {
        if (key === 'providerMode') return ProviderMode.COPILOT;
        if (key === 'runnerTimeout') return 60;
        return undefined;
      }),
    });
    mockLm.selectChatModels.mockRejectedValue(new Error('lm not available'));

    const context = makeContext(makeSecretStorage());
    await activate(context);
    await jest.advanceTimersByTimeAsync(2100);
    // No unhandled rejection — silently ignored
  });

  it('calls configureProvider when user clicks Configure API Keys', async () => {
    (mockWs.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn((key: string) => {
        if (key === 'providerMode') return ProviderMode.COPILOT;
        if (key === 'runnerTimeout') return 60;
        return undefined;
      }),
    });
    mockLm.selectChatModels.mockResolvedValue([]);
    // User clicks "Configure API Keys" → showQuickPick returns undefined (cancel setup flow)
    mockWin.showInformationMessage.mockResolvedValue('Configure API Keys' as unknown as vscode.MessageItem);
    mockWin.showQuickPick.mockResolvedValue(undefined); // cancel configureProvider

    const context = makeContext(makeSecretStorage());
    await activate(context);
    await jest.advanceTimersByTimeAsync(2100);

    expect(mockWin.showQuickPick).toHaveBeenCalled();
  });
});

// ── deactivate ────────────────────────────────────────────────────────────────

describe('deactivate()', () => {
  it('returns without error', () => {
    expect(() => deactivate()).not.toThrow();
  });
});
