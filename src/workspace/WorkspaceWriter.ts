import * as vscode from 'vscode';
import * as path from 'path';
import type { FileChange } from '../types';
import { WorkspaceError } from '../errors';
import { DIFF_SCHEME, diffContentStore } from '../extension';

const FILE_LINE_PATTERN = /^FILE:\s*(.+?)\s*$/;
const DELETE_LINE_PATTERN = /^DELETE:\s*(.+?)\s*$/;
const OPEN_FENCE_PATTERN = /^(`{3,})\w*/;
const CLOSE_FENCE_PATTERN = /^(`{3,})\s*$/;

/** Maximum number of file changes accepted from a single agent response. */
const MAX_FILE_CHANGES = 50;

/** Re-exported for backwards compatibility */
export class WorkspaceWriterError extends WorkspaceError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'WorkspaceWriterError';
  }
}

function normalizePath(rawPath: string): string | null {
  const normalized = rawPath
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\//, '');

  if (!normalized) return null;
  if (normalized.includes('..')) return null;
  if (path.isAbsolute(normalized)) return null;

  return normalized;
}

/**
 * Parses FILE: and DELETE: blocks from an agent response.
 *
 * Uses a line-by-line parser with fence-depth tracking so that nested
 * code blocks inside a FILE: block (e.g. ```bash inside a README) do
 * not prematurely terminate the outer block.
 *
 * Expected format:
 *   FILE: path/to/file
 *   ```[lang]
 *   ...content...
 *   ```
 *
 *   DELETE: path/to/file
 */
export function parseFileChanges(agentResponse: string): FileChange[] {
  if (typeof agentResponse !== 'string') {
    return [];
  }

  const changes: FileChange[] = [];
  const seen = new Set<string>();
  const lines = agentResponse.split('\n');
  let i = 0;

  while (i < lines.length && changes.length < MAX_FILE_CHANGES) {
    const line = lines[i];

    // DELETE: line
    const deleteMatch = DELETE_LINE_PATTERN.exec(line);
    if (deleteMatch) {
      const normalizedPath = normalizePath(deleteMatch[1]);
      if (normalizedPath && !seen.has(normalizedPath)) {
        seen.add(normalizedPath);
        changes.push({ filePath: normalizedPath, content: '', isNew: false, isDelete: true });
      }
      i++;
      continue;
    }

    // FILE: line
    const fileMatch = FILE_LINE_PATTERN.exec(line);
    if (fileMatch) {
      const normalizedPath = normalizePath(fileMatch[1]);
      i++;

      // Next non-empty line must be the opening fence
      if (i >= lines.length) break;
      const openMatch = OPEN_FENCE_PATTERN.exec(lines[i]);
      if (!openMatch) {
        // Not a code fence — skip this FILE: block
        continue;
      }
      const fenceStr = openMatch[1]; // e.g. "```"
      i++;

      // Collect content lines until the matching closing fence, tracking depth
      const contentLines: string[] = [];
      let depth = 1;

      while (i < lines.length) {
        const contentLine = lines[i];
        const closeMatch = CLOSE_FENCE_PATTERN.exec(contentLine);
        if (closeMatch && closeMatch[1] === fenceStr) {
          // Bare fence of the same length → close
          depth--;
          if (depth === 0) {
            i++; // consume closing fence
            break;
          }
          contentLines.push(contentLine);
        } else if (OPEN_FENCE_PATTERN.exec(contentLine)?.[1] === fenceStr) {
          // Opening fence of the same length (e.g. ```bash) inside content → deepen
          depth++;
          contentLines.push(contentLine);
        } else {
          contentLines.push(contentLine);
        }
        i++;
      }

      if (normalizedPath && !seen.has(normalizedPath)) {
        seen.add(normalizedPath);
        changes.push({
          filePath: normalizedPath,
          content: contentLines.join('\n'),
          isNew: false,
        });
      }
      continue;
    }

    i++;
  }

  return changes;
}

/**
 * Remove FILE:/DELETE: blocks from agent response text, leaving only the
 * prose explanation. Used so the chat bubble doesn't show raw file contents
 * (those are already visible in the File Changes diff panel).
 */
export function stripFileBlocks(agentResponse: string): string {
  if (typeof agentResponse !== 'string') return agentResponse;

  const lines = agentResponse.split('\n');
  const kept: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // DELETE: line — skip it
    if (DELETE_LINE_PATTERN.exec(line)) {
      i++;
      continue;
    }

    // FILE: line — skip the FILE: header and its fenced block
    const fileMatch = FILE_LINE_PATTERN.exec(line);
    if (fileMatch) {
      i++;
      if (i >= lines.length) break;
      const openMatch = OPEN_FENCE_PATTERN.exec(lines[i]);
      if (!openMatch) continue; // no fence, skip just the FILE: line
      const fenceStr = openMatch[1];
      i++; // skip opening fence
      let depth = 1;
      while (i < lines.length) {
        const contentLine = lines[i];
        const closeMatch = CLOSE_FENCE_PATTERN.exec(contentLine);
        if (closeMatch && closeMatch[1] === fenceStr) {
          depth--;
          if (depth === 0) { i++; break; }
        } else if (OPEN_FENCE_PATTERN.exec(contentLine)?.[1] === fenceStr) {
          depth++;
        }
        i++;
      }
      continue;
    }

    kept.push(line);
    i++;
  }

  return kept.join('\n').trim();
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
      return { appliedFiles: [], newFiles: [], deletedFiles: [] };
    }

    const workspaceRoot = workspaceFolders[0].uri;
    const edit = new vscode.WorkspaceEdit();
    const appliedFiles: string[] = [];
    const newFiles: string[] = [];
    const deletedFiles: string[] = [];

    for (const change of fileChanges) {
      const targetUri = vscode.Uri.joinPath(workspaceRoot, change.filePath);

      if (change.isDelete) {
        const fileExists = await this.fileExists(targetUri);
        if (fileExists) {
          edit.deleteFile(targetUri, { ignoreIfNotExists: true });
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

  private createVirtualDocument(label: string, content: string): vscode.Uri {
    const key = '/' + label.replace(/[/\\]/g, '_');
    diffContentStore.set(key, content);
    return vscode.Uri.parse(`${DIFF_SCHEME}:${key}`);
  }
}

export interface ApplyResult {
  appliedFiles: string[];
  newFiles: string[];
  deletedFiles: string[];
}
