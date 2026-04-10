import * as vscode from 'vscode';
import * as path from 'path';
import type { FileChange } from '../types';
import { WorkspaceError } from '../errors';
import { DIFF_SCHEME, diffContentStore } from '../extension';
import { resolveWorkspacePath as resolveWorkspacePathWithPrefix } from './WorkspacePath';

/** Re-exported for backwards compatibility */
export class WorkspaceWriterError extends WorkspaceError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'WorkspaceWriterError';
  }
}

export function normalizePath(rawPath: string): string | null {
  const normalized = rawPath
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\//, '');

  if (!normalized) {return null;}
  if (normalized.includes('..')) {return null;}
  if (path.isAbsolute(normalized)) {return null;}

  return normalized;
}


export class WorkspaceWriter {
  async previewChange(fileChange: FileChange): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      throw new WorkspaceWriterError(
        'No workspace folder is open. Open a folder before applying changes.',
      );
    }

    const targetUri = this.resolveTargetUri(fileChange.filePath, workspaceFolders);

    const newContentUri = this.createVirtualDocument(
      fileChange.filePath,
      fileChange.content,
    );

    let leftUri: vscode.Uri;
    const fileExists = await this.fileExists(targetUri);

    if (fileExists) {
      leftUri = targetUri;
    } else {
      // Show empty file on the left for new files
      leftUri = this.createVirtualDocument(fileChange.filePath + ' (new)', '');
    }

    const title = fileExists
      ? `${fileChange.filePath} (modified)`
      : `${fileChange.filePath} (new file)`;

    await vscode.commands.executeCommand(
      'vscode.diff',
      leftUri,
      newContentUri,
      title,
      { preview: true },
    );
  }

  async applyChanges(fileChanges: FileChange[]): Promise<ApplyResult> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      throw new WorkspaceWriterError(
        'No workspace folder is open. Open a folder before applying changes.',
      );
    }

    if (fileChanges.length === 0) {
      return { appliedFiles: [], newFiles: [], deletedFiles: [] };
    }

    const edit = new vscode.WorkspaceEdit();
    const appliedFiles: string[] = [];
    const newFiles: string[] = [];
    const deletedFiles: string[] = [];

    for (const change of fileChanges) {
      const targetUri = this.resolveTargetUri(change.filePath, workspaceFolders);

      if (change.isDeleted) {
        const fileExists = await this.fileExists(targetUri);
        if (fileExists) {
          edit.deleteFile(targetUri, { recursive: false, ignoreIfNotExists: true });
          deletedFiles.push(change.filePath);
        }
        continue;
      }

      const fileExists = await this.fileExists(targetUri);
      const encodedContent = Buffer.from(change.content, 'utf-8');

      if (fileExists) {
        const fullRange = new vscode.Range(
          new vscode.Position(0, 0),
          new vscode.Position(Number.MAX_SAFE_INTEGER, 0),
        );
        edit.replace(targetUri, fullRange, change.content);
        appliedFiles.push(change.filePath);
      } else {
        edit.createFile(targetUri, {
          overwrite: false,
          ignoreIfExists: false,
          contents: encodedContent,
        });
        newFiles.push(change.filePath);
      }
    }

    const success = await vscode.workspace.applyEdit(edit);
    if (!success) {
      throw new WorkspaceWriterError(
        'Failed to apply workspace edits. Some files may be read-only or have conflicts.',
      );
    }

    return { appliedFiles, newFiles, deletedFiles };
  }

  async applySingleChange(fileChange: FileChange): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      throw new WorkspaceWriterError(
        'No workspace folder is open.',
      );
    }

    const targetUri = this.resolveTargetUri(fileChange.filePath, workspaceFolders);
    const edit = new vscode.WorkspaceEdit();
    const fileExists = await this.fileExists(targetUri);
    const encodedContent = Buffer.from(fileChange.content, 'utf-8');

    if (fileExists) {
      const fullRange = new vscode.Range(
        new vscode.Position(0, 0),
        new vscode.Position(Number.MAX_SAFE_INTEGER, 0),
      );
      edit.replace(targetUri, fullRange, fileChange.content);
    } else {
      edit.createFile(targetUri, {
        overwrite: false,
        ignoreIfExists: false,
        contents: encodedContent,
      });
    }

    const success = await vscode.workspace.applyEdit(edit);
    if (!success) {
      throw new WorkspaceWriterError(
        `Failed to apply change to ${fileChange.filePath}.`,
      );
    }
  }

  private async fileExists(uri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  clearDiffContent(): void {
    diffContentStore.clear();
  }

  private createVirtualDocument(label: string, content: string): vscode.Uri {
    const key = '/' + label.replace(/[/\\]/g, '_');
    diffContentStore.set(key, content);
    return vscode.Uri.parse(`${DIFF_SCHEME}:${key}`);
  }

  private resolveTargetUri(
    rawPath: string,
    workspaceFolders: readonly vscode.WorkspaceFolder[],
  ): vscode.Uri {
    const normalized = normalizePath(rawPath);
    if (!normalized) {
      throw new WorkspaceWriterError(`Invalid file path: ${rawPath}`);
    }

    const resolved = resolveWorkspacePathWithPrefix(normalized, workspaceFolders);
    if (resolved) {
      return vscode.Uri.joinPath(resolved.folder.uri, resolved.relativePath);
    }

    throw new WorkspaceWriterError(
      `In multi-root workspaces, file paths must start with "<workspace-folder-prefix>/". Received: ${rawPath}`,
    );
  }
}

export interface ApplyResult {
  appliedFiles: string[];
  newFiles: string[];
  deletedFiles: string[];
}
