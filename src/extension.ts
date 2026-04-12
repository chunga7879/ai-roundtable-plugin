import * as vscode from 'vscode';
import type {
  CopilotAgentFamilyOverrides,
  CopilotAgentName,
  CopilotAgentTierOverrides,
  ExtensionConfig,
  ModelTier,
} from './types';
import { AgentName, ProviderMode } from './types';
import { ChatPanel } from './panels/ChatPanel';
import { ConfigurationError } from './errors';
import { RoundMetricsLogger } from './metrics/RoundMetricsLogger';

const CONFIG_SECTION = 'aiRoundtable';
const SECRET_ANTHROPIC_KEY = 'aiRoundtable.anthropicApiKey';
const SECRET_OPENAI_KEY = 'aiRoundtable.openaiApiKey';
const SECRET_GOOGLE_KEY = 'aiRoundtable.googleApiKey';
const SECRET_DEEPSEEK_KEY = 'aiRoundtable.deepseekApiKey';

const COMMANDS = {
  OPEN_PANEL: 'aiRoundtable.openPanel',
  CONFIGURE_PROVIDER: 'aiRoundtable.configureProvider',
  CLEAR_API_KEYS: 'aiRoundtable.clearApiKeys',
  SHOW_AB_REPORT: 'aiRoundtable.showAbReport',
  CLEAR_METRICS: 'aiRoundtable.clearMetrics',
} as const;

/** Minimum plausible length for any API key. */
const MIN_API_KEY_LENGTH = 10;
const COPILOT_AGENT_NAMES: readonly CopilotAgentName[] = [
  AgentName.CLAUDE,
  AgentName.GPT,
  AgentName.GEMINI,
];
const COPILOT_MODEL_FAMILY_SET = new Set([
  'gpt-4o-mini',
  'gpt-4o',
  'gpt-4',
  'claude',
  'gemini',
]);

export class ConfigManager {
  constructor(private readonly secretStorage: vscode.SecretStorage) {}

  async getConfig(): Promise<ExtensionConfig> {
    const vsConfig = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const rawMode = vsConfig.get<string>('providerMode');
    const providerMode: ProviderMode =
      rawMode === ProviderMode.API_KEYS ? ProviderMode.API_KEYS : ProviderMode.COPILOT;

    const rawCopilotFamily = vsConfig.get<string>('copilotModelFamily') ?? 'auto';
    const copilotModelFamily = rawCopilotFamily === 'auto' ? undefined : rawCopilotFamily;
    const copilotAgentFamilies = this.parseCopilotAgentFamilies(
      vsConfig.get<unknown>('copilotAgentFamilies'),
    );
    const copilotAgentTiers = this.parseCopilotAgentTiers(
      vsConfig.get<unknown>('copilotAgentTiers'),
    );
    const copilotStrictAgentFamily = vsConfig.get<boolean>('copilotStrictAgentFamily') === true;

    const rawTier = vsConfig.get<string>('modelTier');
    const modelTier: ModelTier = rawTier === 'light' ? 'light' : 'heavy';

    const rawTimeout = vsConfig.get<number>('runnerTimeout') ?? 60;
    const runnerTimeoutMs = Math.min(Math.max(rawTimeout, 10), 600) * 1000;
    const enableMetrics = vsConfig.get<boolean>('enableMetrics') === true;

    let anthropicApiKey: string | undefined;
    let openaiApiKey: string | undefined;
    let googleApiKey: string | undefined;
    let deepseekApiKey: string | undefined;

    try {
      [anthropicApiKey, openaiApiKey, googleApiKey, deepseekApiKey] = await Promise.all([
        this.secretStorage.get(SECRET_ANTHROPIC_KEY),
        this.secretStorage.get(SECRET_OPENAI_KEY),
        this.secretStorage.get(SECRET_GOOGLE_KEY),
        this.secretStorage.get(SECRET_DEEPSEEK_KEY),
      ]);
    } catch (err) {
      throw new ConfigurationError(
        'Failed to read API keys from secret storage.',
        err,
      );
    }

    return {
      providerMode,
      anthropicApiKey: anthropicApiKey ?? undefined,
      openaiApiKey: openaiApiKey ?? undefined,
      googleApiKey: googleApiKey ?? undefined,
      deepseekApiKey: deepseekApiKey ?? undefined,
      copilotModelFamily,
      copilotAgentFamilies,
      copilotAgentTiers,
      copilotStrictAgentFamily,
      modelTier,
      runnerTimeoutMs,
      enableMetrics,
    };
  }

  private parseCopilotAgentFamilies(raw: unknown): CopilotAgentFamilyOverrides | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return undefined;
    }
    const input = raw as Record<string, unknown>;
    const parsed: CopilotAgentFamilyOverrides = {};
    for (const agent of COPILOT_AGENT_NAMES) {
      const value = input[agent];
      if (typeof value !== 'string') {
        continue;
      }
      const normalized = value.trim().toLowerCase();
      if (!normalized || normalized === 'auto') {
        continue;
      }
      if (COPILOT_MODEL_FAMILY_SET.has(normalized)) {
        parsed[agent] = normalized;
      }
    }
    return Object.keys(parsed).length > 0 ? parsed : undefined;
  }

  private parseCopilotAgentTiers(raw: unknown): CopilotAgentTierOverrides | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return undefined;
    }
    const input = raw as Record<string, unknown>;
    const parsed: CopilotAgentTierOverrides = {};
    for (const agent of COPILOT_AGENT_NAMES) {
      const value = input[agent];
      if (typeof value !== 'string') {
        continue;
      }
      const normalized = value.trim().toLowerCase();
      if (normalized === 'heavy' || normalized === 'light') {
        parsed[agent] = normalized;
      }
    }
    return Object.keys(parsed).length > 0 ? parsed : undefined;
  }

  async setModelTier(tier: ModelTier): Promise<void> {
    const vsConfig = vscode.workspace.getConfiguration(CONFIG_SECTION);
    await vsConfig.update('modelTier', tier, vscode.ConfigurationTarget.Global);
  }

  async setProviderMode(mode: ProviderMode): Promise<void> {
    const vsConfig = vscode.workspace.getConfiguration(CONFIG_SECTION);
    await vsConfig.update(
      'providerMode',
      mode,
      vscode.ConfigurationTarget.Global,
    );
  }

  async storeApiKey(
    provider: 'anthropic' | 'openai' | 'google' | 'deepseek',
    key: string,
  ): Promise<void> {
    if (!key || key.trim().length < MIN_API_KEY_LENGTH) {
      throw new ConfigurationError(
        `API key for ${provider} is too short or empty.`,
      );
    }

    const secretKey = {
      anthropic: SECRET_ANTHROPIC_KEY,
      openai: SECRET_OPENAI_KEY,
      google: SECRET_GOOGLE_KEY,
      deepseek: SECRET_DEEPSEEK_KEY,
    }[provider];

    try {
      await this.secretStorage.store(secretKey, key.trim());
    } catch (err) {
      throw new ConfigurationError(
        `Failed to store API key for ${provider}.`,
        err,
      );
    }
  }

  async clearAllApiKeys(): Promise<void> {
    try {
      await Promise.all([
        this.secretStorage.delete(SECRET_ANTHROPIC_KEY),
        this.secretStorage.delete(SECRET_OPENAI_KEY),
        this.secretStorage.delete(SECRET_GOOGLE_KEY),
        this.secretStorage.delete(SECRET_DEEPSEEK_KEY),
      ]);
    } catch (err) {
      throw new ConfigurationError('Failed to clear API keys from secret storage.', err);
    }
  }

  async configureProvider(): Promise<void> {
    const choice = await vscode.window.showQuickPick(
      [
        {
          label: '$(github) GitHub Copilot',
          description: 'Use your existing Copilot subscription — no API key needed',
          value: ProviderMode.COPILOT,
        },
        {
          label: '$(key) API Keys (Anthropic / OpenAI / Google / DeepSeek)',
          description: 'Use Claude, GPT, or Gemini directly with your own API keys',
          value: ProviderMode.API_KEYS,
        },
      ],
      {
        title: 'AI Roundtable: Select Provider Mode',
        placeHolder: 'How do you want to connect to AI models?',
        ignoreFocusOut: true,
      },
    );

    if (!choice) {
      return;
    }

    await this.setProviderMode(choice.value);

    if (choice.value === ProviderMode.API_KEYS) {
      await this.promptForApiKeys();
    } else {
      void vscode.window.showInformationMessage(
        'AI Roundtable: Using GitHub Copilot. Ensure Copilot is installed and signed in.',
      );
    }
  }

  private async promptForApiKeys(): Promise<void> {
    const providers: Array<{
      name: string;
      key: 'anthropic' | 'openai' | 'google' | 'deepseek';
      prompt: string;
      placeholder: string;
    }> = [
      {
        name: 'Anthropic (Claude)',
        key: 'anthropic',
        prompt: 'Enter your Anthropic API key (starts with sk-ant-)',
        placeholder: 'sk-ant-...',
      },
      {
        name: 'OpenAI (GPT)',
        key: 'openai',
        prompt: 'Enter your OpenAI API key (starts with sk-)',
        placeholder: 'sk-...',
      },
      {
        name: 'Google (Gemini)',
        key: 'google',
        prompt: 'Enter your Google AI API key',
        placeholder: 'AIza...',
      },
      {
        name: 'DeepSeek',
        key: 'deepseek',
        prompt: 'Enter your DeepSeek API key',
        placeholder: 'sk-...',
      },
    ];

    let configuredCount = 0;

    for (const provider of providers) {
      const key = await vscode.window.showInputBox({
        title: `AI Roundtable: ${provider.name} API Key`,
        prompt: `${provider.prompt} (press Escape to skip)`,
        placeHolder: provider.placeholder,
        password: true,
        ignoreFocusOut: true,
        validateInput: (value) => {
          if (value && value.trim().length < MIN_API_KEY_LENGTH) {
            return 'API key appears too short. Double-check your key.';
          }
          return undefined;
        },
      });

      if (key && key.trim().length > 0) {
        try {
          await this.storeApiKey(provider.key, key.trim());
          configuredCount++;
        } catch {
          // Failure to store one key should not abort the loop for remaining providers
          void vscode.window.showWarningMessage(
            `AI Roundtable: Failed to save ${provider.name} key. Please try again.`,
          );
        }
      }
    }

    if (configuredCount > 0) {
      void vscode.window.showInformationMessage(
        `AI Roundtable: ${configuredCount} API key(s) saved securely. You can now select the corresponding agents in the panel.`,
      );
    } else {
      void vscode.window.showWarningMessage(
        'AI Roundtable: No API keys were saved. You can configure them later via the command palette.',
      );
    }
  }
}

/** Scheme used for virtual diff documents (proposed file content). */
export const DIFF_SCHEME = 'ai-roundtable-diff';

/**
 * In-memory store for virtual diff document content.
 * Key: URI path, Value: file content string.
 */
export const diffContentStore = new Map<string, string>();

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const configManager = new ConfigManager(context.secrets);

  // Register virtual document provider for diff previews
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, {
      provideTextDocumentContent(uri: vscode.Uri): string {
        return diffContentStore.get(uri.path) ?? '';
      },
    }),
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMANDS.OPEN_PANEL, () => {
      ChatPanel.createOrReveal(context, configManager);
    }),

    vscode.commands.registerCommand(COMMANDS.CONFIGURE_PROVIDER, () => {
      void configManager.configureProvider().then(() => {
        return ChatPanel.refreshConfig();
      }).catch((err: unknown) => {
        void vscode.window.showErrorMessage(
          `AI Roundtable: Failed to configure provider. ${err instanceof Error ? err.message : 'Unknown error.'}`,
        );
      });
    }),

    vscode.commands.registerCommand(COMMANDS.CLEAR_API_KEYS, () => {
      void (async () => {
        const confirm = await vscode.window.showWarningMessage(
          'Clear all stored AI Roundtable API keys?',
          { modal: true },
          'Clear Keys',
        );
        if (confirm === 'Clear Keys') {
          try {
            await configManager.clearAllApiKeys();
            await configManager.setProviderMode(ProviderMode.COPILOT);
            void vscode.window.showInformationMessage(
              'AI Roundtable: All API keys have been cleared.',
            );
          } catch (err) {
            void vscode.window.showErrorMessage(
              `AI Roundtable: Failed to clear API keys. ${err instanceof Error ? err.message : 'Unknown error.'}`,
            );
          }
        }
      })();
    }),

    vscode.commands.registerCommand(COMMANDS.SHOW_AB_REPORT, () => {
      void (async () => {
        try {
          const config = await configManager.getConfig();
          if (!config.enableMetrics) {
            void vscode.window.showInformationMessage(
              'AI Roundtable: Metrics collection is disabled. Enable "AI Roundtable › Enable Metrics" in Settings, run a few turns, then try again.',
            );
            return;
          }

          const logger = new RoundMetricsLogger(context.globalStorageUri);
          const { markdown, summary } = await logger.buildMarkdownReport();
          if (summary.totalRuns === 0) {
            void vscode.window.showInformationMessage(
              'AI Roundtable: No round metrics recorded yet. Run a few turns first.',
            );
            return;
          }
          const doc = await vscode.workspace.openTextDocument({
            content: markdown,
            language: 'markdown',
          });
          await vscode.window.showTextDocument(doc, { preview: false });
        } catch (err) {
          void vscode.window.showErrorMessage(
            `AI Roundtable: Failed to build A/B report. ${err instanceof Error ? err.message : 'Unknown error.'}`,
          );
        }
      })();
    }),

    vscode.commands.registerCommand(COMMANDS.CLEAR_METRICS, () => {
      void (async () => {
        try {
          const logger = new RoundMetricsLogger(context.globalStorageUri);
          await logger.clear();
          void vscode.window.showInformationMessage(
            'AI Roundtable: Metrics for this workspace were cleared.',
          );
        } catch (err) {
          void vscode.window.showErrorMessage(
            `AI Roundtable: Failed to clear metrics. ${err instanceof Error ? err.message : 'Unknown error.'}`,
          );
        }
      })();
    }),
  );

  // First-run check: if no provider is configured, prompt the user
  await runFirstTimeSetupIfNeeded(configManager);
}

async function runFirstTimeSetupIfNeeded(
  configManager: ConfigManager,
): Promise<void> {
  let config: ExtensionConfig;
  try {
    config = await configManager.getConfig();
  } catch {
    // Non-fatal — silently skip first-run setup if config is unavailable
    return;
  }

  // If mode is COPILOT (default), check if Copilot is actually available
  if (config.providerMode === ProviderMode.COPILOT) {
    // Defer the check slightly so VS Code finishes loading extensions
    setTimeout(() => {
      void (async () => {
        try {
          const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
          if (models.length === 0) {
            const choice = await vscode.window.showInformationMessage(
              'AI Roundtable: GitHub Copilot was not found. Would you like to configure API keys instead?',
              'Configure API Keys',
              'Later',
            );
            if (choice === 'Configure API Keys') {
              await configManager.configureProvider();
            }
          }
        } catch {
          // vscode.lm may not be available in some VS Code versions — silently ignore
        }
      })();
    }, 2000);
  }
}

export function deactivate(): void {
  // Cleanup is handled by the disposables registered in activate()
}
