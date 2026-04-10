import * as vscode from 'vscode';
import { resolveWorkspaceRootForCommand } from '../../src/workspace/WorkspaceRootResolver';

describe('resolveWorkspaceRootForCommand', () => {
  afterEach(() => {
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
    (vscode.window as { activeTextEditor: unknown }).activeTextEditor = undefined;
  });

  it('returns undefined when no workspace is open', () => {
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
    expect(resolveWorkspaceRootForCommand()).toBeUndefined();
  });

  it('returns the only workspace root in single-root mode', () => {
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: vscode.Uri.file('/workspace'), name: 'workspace', index: 0 },
    ];
    expect(resolveWorkspaceRootForCommand()).toBe('/workspace');
  });

  it('prefers a candidate path with workspace-folder prefix in multi-root mode', () => {
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: vscode.Uri.file('/repo-a'), name: 'repoA', index: 0 },
      { uri: vscode.Uri.file('/repo-b'), name: 'repoB', index: 1 },
    ];
    const root = resolveWorkspaceRootForCommand({
      candidateFilePaths: ['repoB/src/app.ts'],
    });
    expect(root).toBe('/repo-b');
  });

  it('supports indexed workspace-folder prefixes when names collide', () => {
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: vscode.Uri.file('/repo-a'), name: 'repo', index: 0 },
      { uri: vscode.Uri.file('/repo-b'), name: 'repo', index: 1 },
    ];
    const root = resolveWorkspaceRootForCommand({
      candidateFilePaths: ['1:repo/src/app.ts'],
    });
    expect(root).toBe('/repo-b');
  });

  it('falls back to active editor workspace root when candidate paths do not map', () => {
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: vscode.Uri.file('/repo-a'), name: 'repoA', index: 0 },
      { uri: vscode.Uri.file('/repo-b'), name: 'repoB', index: 1 },
    ];
    (vscode.window as { activeTextEditor: unknown }).activeTextEditor = {
      document: { uri: vscode.Uri.file('/repo-b/src/current.ts'), isUntitled: false },
    };

    const root = resolveWorkspaceRootForCommand({
      candidateFilePaths: ['src/no-prefix.ts'],
    });
    expect(root).toBe('/repo-b');
  });

  it('falls back to the first workspace root when no hint resolves', () => {
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: vscode.Uri.file('/repo-a'), name: 'repoA', index: 0 },
      { uri: vscode.Uri.file('/repo-b'), name: 'repoB', index: 1 },
    ];

    const root = resolveWorkspaceRootForCommand({
      candidateFilePaths: ['src/no-prefix.ts'],
    });
    expect(root).toBe('/repo-a');
  });
});
