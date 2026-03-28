import * as vscode from 'vscode';
import * as path from 'path';
import type { FileChange } from '../types';
import { WorkspaceError } from '../errors';

const FILE_BLOCK_PATTERN =
  /^FILE:\s*(.+?)\s*\n```(?:\w+)?\n([\s\S]*?)```/gm;

/** Maximum number of file changes accepted from a single agent response. */
const MAX_FILE_CHANGES = 50;

/** Re-exported for backwards compatibility */
export class WorkspaceWriterError extends WorkspaceError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'WorkspaceWriterError';
  }
}

export function parseFileChanges(agentResponse: string): FileChange[] {
  if (typeof agentResponse !== 'string') {
    return [];
  }

  const changes: FileChange[] = [];
  const seen = new Set<string>();

  let match: RegExpExecArray | null;
  FILE_BLOCK_PATTERN.lastIndex = 0;

  while ((match = FILE_BLOCK_PATTERN.exec(agentResponse)) !== null) {
    if (changes.length >= MAX_FILE_CHANGES) {
      break;
    }

    const rawPath = match[1].trim();
    const content = match[2];

    // Normalize path separators and remove leading slashes or ./
    const normalizedPath = rawPath
      .replace(/\\/g, '/')
      .replace(/^\.\//, '')
      .replace(/^\//, '');

    if (!normalizedPath || seen.has(normalizedPath)) {
      continue;
    }

    // Security: reject paths with directory traversal
    if (normalizedPath.includes('..')) {
      continue;
    }

    // Security: reject absolute paths that slipped through
    if (path.isAbsolute(normalizedPath)) {
      continue;
    }

    seen.add(normalizedPath);
    changes.push({
      filePath: normalizedPath,
      content,
      isNew: false, // Determined at write time by checking if file exists
    });
  }

  return changes;
}

export class WorkspaceWriter {
  async previewChange(fileChange: FileChange): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      throw new WorkspaceWriterError(
        'No workspace folder is open. Open a folder before applying changes.',
      );
    }

    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    const targetUri = vscode.Uri.file(
      path.join(workspaceRoot, fileChange.filePath),
    );

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
      return { appliedFiles: [], newFiles: [] };
    }

    const workspaceRoot = workspaceFolders[0].uri;
    const edit = new vscode.WorkspaceEdit();
    const appliedFiles: string[] = [];
    const newFiles: string[] = [];

    for (const change of fileChanges) {
      const targetUri = vscode.Uri.joinPath(
        workspaceRoot,
        change.filePath,
      );

      const fileExists = await this.fileExists(targetUri);
      const encodedContent = Buffer.from(change.content, 'utf-8');

      if (fileExists) {
        // Replace entire file content
        const fullRange = new vscode.Range(
          new vscode.Position(0, 0),
          new vscode.Position(Number.MAX_SAFE_INTEGER, 0),
        );
        edit.replace(
          targetUri,
          fullRange,
          change.content,
        );
        appliedFiles.push(change.filePath);
      } else {
        // Create new file (including parent directories)
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

    return { appliedFiles, newFiles };
  }

  async applySingleChange(fileChange: FileChange): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      throw new WorkspaceWriterError(
        'No workspace folder is open.',
      );
    }

    const workspaceRoot = workspaceFolders[0].uri;
    const targetUri = vscode.Uri.joinPath(workspaceRoot, fileChange.filePath);
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

  private createVirtualDocument(label: string, _content: string): vscode.Uri {
    return vscode.Uri.parse(
      `untitled:${label.replace(/[/\\]/g, '_')}`,
    );
  }
}

export interface ApplyResult {
  appliedFiles: string[];
  newFiles: string[];
}
