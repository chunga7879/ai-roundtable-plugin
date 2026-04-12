import * as vscode from 'vscode';
import * as path from 'path';
import type { WorkspaceContext, WorkspaceFile } from '../types';
import { WorkspaceError } from '../errors';
import {
  formatWorkspacePath as formatWorkspacePathWithPrefix,
  resolveWorkspacePath as resolveWorkspacePathWithPrefix,
} from './WorkspacePath';

const MAX_FILE_SIZE_BYTES = 80_000;
const MAX_FILES_TO_INCLUDE = 80;

const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  'coverage',
  '__pycache__',
  '.pytest_cache',
  'venv',
  '.venv',
  '.tox',
  'vendor',
  'target',
  '.gradle',
]);

const EXCLUDED_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.mp4',
  '.mp3',
  '.wav',
  '.zip',
  '.tar',
  '.gz',
  '.pdf',
  '.bin',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.lock',
  '.map',
]);

/** File extensions that may contain credentials or private keys. */
const EXCLUDED_SENSITIVE_EXTENSIONS = new Set([
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.cer',
  '.crt',
  '.der',
]);

/** Files whose base name must be excluded regardless of extension. */
const EXCLUDED_FILENAMES = new Set([
  '.env',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.htpasswd',
]);

/** Patterns matched against the lowercased basename to catch secrets/credentials files. */
const EXCLUDED_FILENAME_PATTERNS: ReadonlyArray<RegExp> = [
  /^\.env\./,           // .env.local, .env.production, .env.staging, etc.
  /secret/,             // *secret*, secrets.json, etc.
  /credential/,         // *credential*, credentials.json, etc.
  /password/,           // *password*, passwords.txt, etc.
  /private[-_.]key/,    // private.key, private_key.pem, etc.
];

const EXTENSION_TO_LANGUAGE: Readonly<Record<string, string>> = {
  '.ts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.jsx': 'javascriptreact',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.cs': 'csharp',
  '.cpp': 'cpp',
  '.c': 'c',
  '.h': 'c',
  '.hpp': 'cpp',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.scala': 'scala',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.json': 'json',
  '.toml': 'toml',
  '.xml': 'xml',
  '.html': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.md': 'markdown',
  '.sql': 'sql',
  '.dockerfile': 'dockerfile',
  '.env': 'dotenv',
};

/** Maximum number of tool-initiated file reads per agent turn. */
export const MAX_TOOL_CALLS = 140;

/** Re-exported for backwards compatibility */
export class WorkspaceReaderError extends WorkspaceError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'WorkspaceReaderError';
  }
}

export class WorkspaceReader {
  async buildContext(): Promise<WorkspaceContext> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return { files: [] };
    }
    const useRootPrefix = workspaceFolders.length > 1;

    let activeFilePath: string | undefined;
    let activeEditor: vscode.TextEditor | undefined;
    let activeEditorRoot: vscode.WorkspaceFolder | undefined;
    try {
      activeEditor = vscode.window.activeTextEditor;
      if (activeEditor?.document.uri) {
        activeEditorRoot = this.findContainingWorkspaceFolder(
          activeEditor.document.uri.fsPath,
          workspaceFolders,
        );
        if (activeEditorRoot) {
          const rel = this.toRelativePath(activeEditor.document.uri.fsPath, activeEditorRoot.uri.fsPath);
          if (!this.isExcludedRelativePath(rel, activeEditorRoot.uri.fsPath)) {
            activeFilePath = this.formatWorkspacePath(rel, activeEditorRoot, useRootPrefix, workspaceFolders);
          }
        }
      }
    } catch {
      // activeTextEditor may throw in some environments — degrade gracefully
    }

    const filesToInclude: Array<{ uri: vscode.Uri; root: vscode.WorkspaceFolder }> = [];
    const includedFsPaths = new Set<string>();

    // Priority 1: Currently open/active file
    if (
      activeEditor &&
      !activeEditor.document.isUntitled &&
      activeEditorRoot &&
      !includedFsPaths.has(activeEditor.document.uri.fsPath)
    ) {
      filesToInclude.push({ uri: activeEditor.document.uri, root: activeEditorRoot });
      includedFsPaths.add(activeEditor.document.uri.fsPath);
    }

    // Priority 2: All visible editors
    try {
      for (const editor of vscode.window.visibleTextEditors) {
        if (!editor.document.isUntitled && editor !== activeEditor) {
          const uri = editor.document.uri;
          const root = this.findContainingWorkspaceFolder(uri.fsPath, workspaceFolders);
          if (root && !includedFsPaths.has(uri.fsPath)) {
            filesToInclude.push({ uri, root });
            includedFsPaths.add(uri.fsPath);
          }
        }
      }
    } catch {
      // visibleTextEditors access may fail in tests — degrade gracefully
    }

    // Priority 3: Files in workspace (breadth-first, respecting limits across all roots)
    let remaining = Math.max(0, MAX_FILES_TO_INCLUDE - filesToInclude.length);
    for (const folder of workspaceFolders) {
      if (remaining <= 0) {
        break;
      }
      const workspaceFiles = await this.collectWorkspaceFiles(
        folder.uri,
        remaining,
        Array.from(includedFsPaths),
      );
      for (const uri of workspaceFiles) {
        if (!includedFsPaths.has(uri.fsPath)) {
          filesToInclude.push({ uri, root: folder });
          includedFsPaths.add(uri.fsPath);
          remaining--;
          if (remaining <= 0) {
            break;
          }
        }
      }
    }

    // Build file list without reading content — agent reads what it needs via read_file tool
    const files: WorkspaceFile[] = [];
    for (const { uri, root } of filesToInclude) {
      if (files.length >= MAX_FILES_TO_INCLUDE) {
        break;
      }
      const fsPath = uri.fsPath;
      const relativePath = this.toRelativePath(fsPath, root.uri.fsPath);
      if (this.isExcludedRelativePath(relativePath, root.uri.fsPath)) {
        continue;
      }
      const ext = path.extname(fsPath).toLowerCase();
      files.push({
        path: this.formatWorkspacePath(relativePath, root, useRootPrefix, workspaceFolders),
        content: '',
        language: this.getLanguage(ext),
      });
    }

    return {
      files,
      activeFilePath,
    };
  }

  /**
   * Returns a flat list of all non-excluded file paths relative to the workspace root.
   * Used to give the AI the full file tree without reading content upfront.
   */
  async listWorkspaceFiles(): Promise<string[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return [];
    }
    const useRootPrefix = workspaceFolders.length > 1;
    const result: string[] = [];
    const seen = new Set<string>();

    for (const folder of workspaceFolders) {
      const uris: vscode.Uri[] = [];
      await this.traverseDirectory(folder.uri, folder.uri.fsPath, uris, 2000, []);
      for (const uri of uris) {
        const rel = this.toRelativePath(uri.fsPath, folder.uri.fsPath);
        if (this.isExcludedRelativePath(rel, folder.uri.fsPath)) {
          continue;
        }
        const display = this.formatWorkspacePath(rel, folder, useRootPrefix, workspaceFolders);
        if (!seen.has(display)) {
          seen.add(display);
          result.push(display);
        }
      }
    }
    return result;
  }

  /**
   * Reads a single file by relative path, applying all security exclusion checks.
   * Returns file content (truncated to MAX_FILE_SIZE_BYTES) or an error string.
   */
  async readFileForTool(relativePath: string): Promise<{ content: string; isError: boolean }> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return { content: 'No workspace folder is open.', isError: true };
    }

    // Reject absolute paths and traversal before any normalization
    if (path.isAbsolute(relativePath) || relativePath.includes('..')) {
      return { content: `Invalid file path: ${relativePath}`, isError: true };
    }

    // Normalize and validate path
    const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!normalized || normalized.includes('..') || path.isAbsolute(normalized)) {
      return { content: `Invalid file path: ${relativePath}`, isError: true };
    }

    const resolved = this.resolveWorkspacePath(normalized, workspaceFolders);
    if (!resolved) {
      if (workspaceFolders.length > 1) {
        return {
          content: `Ambiguous file path: ${relativePath}. Use "<workspace-folder-prefix>/<path>" in multi-root workspaces.`,
          isError: true,
        };
      }
      return { content: `Invalid file path: ${relativePath}`, isError: true };
    }

    if (this.isExcludedRelativePath(resolved.relativePath, resolved.rootFsPath)) {
      return { content: `File not found or excluded: ${relativePath}`, isError: true };
    }

    // Prefer unsaved in-editor content when available so tool reads reflect the latest edits.
    const dirtyContent = this.getDirtyEditorContent(resolved.rootFsPath, resolved.relativePath);
    if (dirtyContent !== undefined) {
      return { content: dirtyContent, isError: false };
    }

    const targetUri = vscode.Uri.joinPath(resolved.rootUri, resolved.relativePath);
    const workspaceFile = await this.readWorkspaceFile(targetUri, resolved.rootFsPath);

    if (!workspaceFile) {
      return { content: `File not found or excluded: ${relativePath}`, isError: true };
    }

    return { content: workspaceFile.content, isError: false };
  }

  private resolveWorkspacePath(
    normalizedPath: string,
    workspaceFolders: readonly vscode.WorkspaceFolder[],
  ): { rootUri: vscode.Uri; rootFsPath: string; relativePath: string } | null {
    const resolved = resolveWorkspacePathWithPrefix(normalizedPath, workspaceFolders);
    if (!resolved) {
      return null;
    }
    return {
      rootUri: resolved.folder.uri,
      rootFsPath: resolved.folder.uri.fsPath,
      relativePath: resolved.relativePath,
    };
  }

  private findContainingWorkspaceFolder(
    fsPath: string,
    workspaceFolders: readonly vscode.WorkspaceFolder[],
  ): vscode.WorkspaceFolder | undefined {
    for (const folder of workspaceFolders) {
      const rel = path.relative(folder.uri.fsPath, fsPath);
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
        return folder;
      }
    }
    return undefined;
  }

  private formatWorkspacePath(
    relativePath: string,
    root: vscode.WorkspaceFolder,
    useRootPrefix: boolean,
    workspaceFolders: readonly vscode.WorkspaceFolder[],
  ): string {
    return useRootPrefix
      ? formatWorkspacePathWithPrefix(relativePath, root, workspaceFolders)
      : relativePath;
  }

  private isExcludedRelativePath(relativePath: string, workspaceRoot: string): boolean {
    const ext = path.extname(relativePath).toLowerCase();
    const basename = path.basename(relativePath);
    const lowerBasename = basename.toLowerCase();
    if (
      EXCLUDED_EXTENSIONS.has(ext) ||
      EXCLUDED_SENSITIVE_EXTENSIONS.has(ext) ||
      EXCLUDED_FILENAMES.has(basename) ||
      EXCLUDED_FILENAME_PATTERNS.some((p) => p.test(lowerBasename))
    ) {
      return true;
    }

    const absolutePath = path.join(workspaceRoot, relativePath);
    return this.isInExcludedDir(absolutePath, workspaceRoot);
  }

  /**
   * Returns unsaved editor content for a workspace-relative path, if present.
   * This keeps AI reads aligned with what the user currently sees in the editor.
   */
  private getDirtyEditorContent(
    workspaceRoot: string,
    normalizedRelativePath: string,
  ): string | undefined {
    let textDocuments: readonly vscode.TextDocument[];
    try {
      textDocuments = vscode.workspace.textDocuments ?? [];
    } catch {
      return undefined;
    }

    for (const doc of textDocuments) {
      if (doc.isUntitled || !doc.isDirty || typeof doc.getText !== 'function') {
        continue;
      }

      const relative = this.toRelativePath(doc.uri.fsPath, workspaceRoot);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        continue;
      }

      if (relative === normalizedRelativePath) {
        return doc.getText();
      }
    }
    return undefined;
  }

  private async readWorkspaceFile(
    uri: vscode.Uri,
    workspaceRoot: string,
  ): Promise<WorkspaceFile | undefined> {
    const fsPath = uri.fsPath;
    const ext = path.extname(fsPath).toLowerCase();
    const basename = path.basename(fsPath);

    // Exclude by extension
    if (EXCLUDED_EXTENSIONS.has(ext)) {
      return undefined;
    }

    // Exclude sensitive file extensions (private keys, certificates)
    if (EXCLUDED_SENSITIVE_EXTENSIONS.has(ext)) {
      return undefined;
    }

    // Exclude by exact filename (.env, .npmrc, etc.)
    if (EXCLUDED_FILENAMES.has(basename)) {
      return undefined;
    }

    // Exclude by filename pattern (.env.local, *secret*, *credential*, etc.)
    const lowerBasename = basename.toLowerCase();
    if (EXCLUDED_FILENAME_PATTERNS.some((pattern) => pattern.test(lowerBasename))) {
      return undefined;
    }

    // Security: ensure the file is inside the workspace root (prevents symlink escapes)
    const relativeCheck = path.relative(workspaceRoot, fsPath);
    if (relativeCheck.startsWith('..') || path.isAbsolute(relativeCheck)) {
      return undefined;
    }

    if (this.isInExcludedDir(fsPath, workspaceRoot)) {
      return undefined;
    }

    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > MAX_FILE_SIZE_BYTES) {
        // Include truncated version with notice
        const bytes = await vscode.workspace.fs.readFile(uri);
        const fullContent = Buffer.from(bytes).toString('utf-8');
        const truncated = fullContent.slice(0, MAX_FILE_SIZE_BYTES);
        const relativePath = this.toRelativePath(fsPath, workspaceRoot);

        return {
          path: relativePath,
          content: `${truncated}\n\n[... truncated at ${MAX_FILE_SIZE_BYTES} bytes ...]`,
          language: this.getLanguage(ext),
          truncated: true,
        };
      }

      const bytes = await vscode.workspace.fs.readFile(uri);
      const content = Buffer.from(bytes).toString('utf-8');

      return {
        path: this.toRelativePath(fsPath, workspaceRoot),
        content,
        language: this.getLanguage(ext),
      };
    } catch {
      // File may have been deleted or is unreadable — skip silently
      return undefined;
    }
  }

  private async collectWorkspaceFiles(
    rootUri: vscode.Uri,
    maxFiles: number,
    alreadyIncluded: string[],
  ): Promise<vscode.Uri[]> {
    if (maxFiles <= 0) {
      return [];
    }

    const result: vscode.Uri[] = [];
    await this.traverseDirectory(
      rootUri,
      rootUri.fsPath,
      result,
      maxFiles,
      alreadyIncluded,
    );
    return result;
  }

  private async traverseDirectory(
    dirUri: vscode.Uri,
    workspaceRoot: string,
    result: vscode.Uri[],
    maxFiles: number,
    alreadyIncluded: string[],
  ): Promise<void> {
    if (result.length >= maxFiles) {
      return;
    }

    const dirPath = dirUri.fsPath;
    const dirName = path.basename(dirPath);

    if (EXCLUDED_DIRS.has(dirName)) {
      return;
    }

    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dirUri);
    } catch {
      return;
    }

    // Sort: files before directories, then alphabetically
    entries.sort(([nameA, typeA], [nameB, typeB]) => {
      if (typeA !== typeB) {
        return typeA === vscode.FileType.File ? -1 : 1;
      }
      return nameA.localeCompare(nameB);
    });

    for (const [name, type] of entries) {
      if (result.length >= maxFiles) {
        break;
      }

      const entryUri = vscode.Uri.joinPath(dirUri, name);
      const entryPath = entryUri.fsPath;

      if (type === vscode.FileType.File) {
        if (!alreadyIncluded.includes(entryPath)) {
          const ext = path.extname(name).toLowerCase();
          const lowerName = name.toLowerCase();
          const isSafe =
            !EXCLUDED_EXTENSIONS.has(ext) &&
            !EXCLUDED_SENSITIVE_EXTENSIONS.has(ext) &&
            !EXCLUDED_FILENAMES.has(name) &&
            !EXCLUDED_FILENAME_PATTERNS.some((p) => p.test(lowerName));
          if (isSafe) {
            result.push(entryUri);
          }
        }
      } else if (type === vscode.FileType.Directory) {
        if (!EXCLUDED_DIRS.has(name)) {
          await this.traverseDirectory(
            entryUri,
            workspaceRoot,
            result,
            maxFiles,
            alreadyIncluded,
          );
        }
      }
    }
  }

  private isInExcludedDir(filePath: string, workspaceRoot: string): boolean {
    const relative = path.relative(workspaceRoot, filePath);
    const parts = relative.split(path.sep);

    for (const part of parts.slice(0, -1)) {
      if (EXCLUDED_DIRS.has(part)) {
        return true;
      }
    }

    return false;
  }

  private toRelativePath(filePath: string, workspaceRoot: string): string {
    const relative = path.relative(workspaceRoot, filePath);
    // Normalize to forward slashes for consistency
    return relative.split(path.sep).join('/');
  }

  private getLanguage(ext: string): string {
    return EXTENSION_TO_LANGUAGE[ext] ?? 'plaintext';
  }
}
