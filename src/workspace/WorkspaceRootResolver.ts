import * as path from 'path';
import * as vscode from 'vscode';
import { getWorkspaceFolderPrefix } from './WorkspacePath';

interface ResolveWorkspaceRootOptions {
  candidateFilePaths?: readonly string[];
}

export function resolveWorkspaceRootForCommand(
  options: ResolveWorkspaceRootOptions = {},
): string | undefined {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return undefined;
  }

  if (workspaceFolders.length === 1) {
    return workspaceFolders[0].uri.fsPath;
  }

  const fromCandidates = resolveFromCandidateFilePaths(
    workspaceFolders,
    options.candidateFilePaths ?? [],
  );
  if (fromCandidates) {
    return fromCandidates;
  }

  const fromActiveEditor = resolveFromActiveEditor(workspaceFolders);
  if (fromActiveEditor) {
    return fromActiveEditor;
  }

  return workspaceFolders[0].uri.fsPath;
}

function resolveFromCandidateFilePaths(
  workspaceFolders: readonly vscode.WorkspaceFolder[],
  candidateFilePaths: readonly string[],
): string | undefined {
  for (const rawPath of candidateFilePaths) {
    if (!rawPath || typeof rawPath !== 'string') {
      continue;
    }

    if (path.isAbsolute(rawPath)) {
      for (const folder of workspaceFolders) {
        const rel = path.relative(folder.uri.fsPath, rawPath);
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
          return folder.uri.fsPath;
        }
      }
      continue;
    }

    const normalized = rawPath.replace(/\\/g, '/').replace(/^\.\//, '');
    for (const folder of workspaceFolders) {
      const prefix = `${getWorkspaceFolderPrefix(folder, workspaceFolders)}/`;
      if (!normalized.startsWith(prefix)) {
        continue;
      }
      const rel = normalized.slice(prefix.length);
      if (!rel || rel.includes('..') || path.isAbsolute(rel)) {
        continue;
      }
      return folder.uri.fsPath;
    }
  }

  return undefined;
}

function resolveFromActiveEditor(
  workspaceFolders: readonly vscode.WorkspaceFolder[],
): string | undefined {
  const activeUri = vscode.window.activeTextEditor?.document?.uri;
  if (!activeUri || activeUri.scheme !== 'file') {
    return undefined;
  }

  for (const folder of workspaceFolders) {
    const rel = path.relative(folder.uri.fsPath, activeUri.fsPath);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      return folder.uri.fsPath;
    }
  }

  return undefined;
}
