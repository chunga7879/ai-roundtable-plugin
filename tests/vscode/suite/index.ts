import assert from 'node:assert/strict';
import * as vscode from 'vscode';

const EXTENSION_ID = 'chungalee.ai-roundtable';
const REQUIRED_COMMANDS = [
  'aiRoundtable.openPanel',
  'aiRoundtable.configureProvider',
  'aiRoundtable.clearApiKeys',
  'aiRoundtable.showAbReport',
  'aiRoundtable.clearMetrics',
];

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `Extension "${EXTENSION_ID}" must be discoverable in host`);

  await extension.activate();

  const commands = await vscode.commands.getCommands(true);
  for (const command of REQUIRED_COMMANDS) {
    assert.ok(commands.includes(command), `Missing command registration: ${command}`);
  }

  const lmAvailable = typeof (vscode as unknown as { lm?: unknown }).lm !== 'undefined';
  console.log(`VS Code ${vscode.version} loaded ${EXTENSION_ID}; vscode.lm available: ${lmAvailable}`);
}
