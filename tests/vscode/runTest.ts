import * as path from 'node:path';

import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  try {
    // Some shells (or parent extension hosts) export this variable, which forces
    // Electron to run as Node and causes "bad option" failures for VS Code flags.
    delete process.env.ELECTRON_RUN_AS_NODE;

    const version = process.env.VS_CODE_VERSION?.trim() || '1.88.0';

    const extensionDevelopmentPath = path.resolve(__dirname, '../../..');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');

    await runTests({
      version,
      extensionDevelopmentPath,
      extensionTestsPath,
    });
  } catch (error) {
    console.error('Failed to run VS Code extension tests', error);
    process.exit(1);
  }
}

void main();
