import * as path from 'path';
import type * as vscode from 'vscode';

export function getWorkspaceFolderPrefix(
  folder: vscode.WorkspaceFolder,
  workspaceFolders: readonly vscode.WorkspaceFolder[],
): string {
  const sameNameCount = workspaceFolders.filter((f) => f.name === folder.name).length;
  if (sameNameCount <= 1) {
    return folder.name;
  }
  return `${folder.index}:${folder.name}`;
}

export function formatWorkspacePath(
  relativePath: string,
  folder: vscode.WorkspaceFolder,
  workspaceFolders: readonly vscode.WorkspaceFolder[],
): string {
  if (workspaceFolders.length <= 1) {
    return relativePath;
  }
  return `${getWorkspaceFolderPrefix(folder, workspaceFolders)}/${relativePath}`;
}

export function resolveWorkspacePath(
  normalizedPath: string,
  workspaceFolders: readonly vscode.WorkspaceFolder[],
): { folder: vscode.WorkspaceFolder; relativePath: string } | null {
  if (workspaceFolders.length === 1) {
    return { folder: workspaceFolders[0], relativePath: normalizedPath };
  }

  for (const folder of workspaceFolders) {
    const prefix = `${getWorkspaceFolderPrefix(folder, workspaceFolders)}/`;
    if (!normalizedPath.startsWith(prefix)) {
      continue;
    }
    const relativePath = normalizedPath.slice(prefix.length);
    if (!relativePath || relativePath.includes('..') || path.isAbsolute(relativePath)) {
      return null;
    }
    return { folder, relativePath };
  }

  return null;
}
