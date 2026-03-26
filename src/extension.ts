import * as vscode from 'vscode';
import type { ExtensionConfig } from './types';
import { ProviderMode } from './types';
import { ChatPanel } from './panels/ChatPanel';

const CONFIG_SECTION = 'aiRoundtable';
const SECRET_ANTHROPIC_KEY = 'aiRoundtable.anthropicApiKey';
const SECRET_OPENAI_KEY = 'aiRoundtable.openaiApiKey';
const SECRET_GOOGLE_KEY = 'aiRoundtable.googleApiKey';

const COMMANDS = {
  OPEN_PANEL: 'aiRoundtable.openPanel',
  CONFIGURE_PROVIDER: 'aiRoundtable.configureProvider',
  CLEAR_API_KEYS: 'aiRoundtable.clearApiKeys',
} as const;

export class ConfigManager {
  constructor(private readonly secretStorage: vscode.SecretStorage) {}

  async getConfig(): Promise<ExtensionConfig> {
    const vsConfig = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const rawMode = vsConfig.get<string>('providerMode');
    const providerMode: ProviderMode =
      rawMode === ProviderMode.API_KEYS ? ProviderMode.API_KEYS : ProviderMode.COPILOT;

    const [anthropicApiKey, openaiApiKey, googleApiKey] = await Promise.all([
      this.secretStorage.get(SECRET_ANTHROPIC_KEY),
      this.secretStorage.get(SECRET_OPENAI_KEY),
      this.secretStorage.get(SECRET_GOOGLE_KEY),
    ]);

    return {
      providerMode,
      anthropicApiKey: anthropicApiKey ?? undefined,
      openaiApiKey: openaiApiKey ?? undefined,
      googleApiKey: googleApiKey ?? undefined,
    };
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
    provider: 'anthropic' | 'openai' | 'google',
    key: string,
  ): Promise<void> {
    const secretKey = {
      anthropic: SECRET_ANTHROPIC_KEY,
      openai: SECRET_OPENAI_KEY,
      google: SECRET_GOOGLE_KEY,
    }[provider];

    await this.secretStorage.store(secretKey, key);
  }

  async clearAllApiKeys(): Promise<void> {
    await Promise.all([
      this.secretStorage.delete(SECRET_ANTHROPIC_KEY),
      this.secretStorage.delete(SECRET_OPENAI_KEY),
      this.secretStorage.delete(SECRET_GOOGLE_KEY),
    ]);
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
          label: '$(key) API Keys (Anthropic / OpenAI / Google)',
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
      key: 'anthropic' | 'openai' | 'google';
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
          if (value && value.trim().length < 10) {
            return 'API key appears too short. Double-check your key.';
          }
          return undefined;
        },
      });

      if (key && key.trim().length > 0) {
        await this.storeApiKey(provider.key, key.trim());
        configuredCount++;
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

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const configManager = new ConfigManager(context.secrets);

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMANDS.OPEN_PANEL, () => {
      ChatPanel.createOrReveal(context.extensionUri, configManager);
    }),

    vscode.commands.registerCommand(COMMANDS.CONFIGURE_PROVIDER, () => {
      void configManager.configureProvider();
    }),

    vscode.commands.registerCommand(COMMANDS.CLEAR_API_KEYS, () => {
      void (async () => {
        const confirm = await vscode.window.showWarningMessage(
          'Clear all stored AI Roundtable API keys?',
          { modal: true },
          'Clear Keys',
        );
        if (confirm === 'Clear Keys') {
          await configManager.clearAllApiKeys();
          await configManager.setProviderMode(ProviderMode.COPILOT);
          void vscode.window.showInformationMessage(
            'AI Roundtable: All API keys have been cleared.',
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
  const config = await configManager.getConfig();

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
