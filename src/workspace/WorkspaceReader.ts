import * as vscode from 'vscode';
import * as path from 'path';
import type { WorkspaceContext, WorkspaceFile } from '../types';
import { WorkspaceError } from '../errors';

const MAX_FILE_SIZE_BYTES = 50_000;
const MAX_TOTAL_CONTEXT_BYTES = 200_000;
const MAX_FILES_TO_INCLUDE = 50;

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
export const MAX_TOOL_CALLS = 100;

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

    let activeFilePath: string | undefined;
    let activeEditor: vscode.TextEditor | undefined;
    try {
      activeEditor = vscode.window.activeTextEditor;
      activeFilePath = activeEditor?.document.uri.fsPath;
    } catch {
      // activeTextEditor may throw in some environments — degrade gracefully
    }

    const filesToRead: vscode.Uri[] = [];

    // Priority 1: Currently open/active file
    if (activeEditor && !activeEditor.document.isUntitled) {
      filesToRead.push(activeEditor.document.uri);
    }

    // Priority 2: All visible editors
    try {
      for (const editor of vscode.window.visibleTextEditors) {
        if (!editor.document.isUntitled && editor !== activeEditor) {
          const uri = editor.document.uri;
          if (!filesToRead.some((f) => f.fsPath === uri.fsPath)) {
            filesToRead.push(uri);
          }
        }
      }
    } catch {
      // visibleTextEditors access may fail in tests — degrade gracefully
    }

    // Priority 3: Files in workspace (breadth-first, respecting limits)
    const rootUri = workspaceFolders[0].uri;
    const workspaceFiles = await this.collectWorkspaceFiles(
      rootUri,
      MAX_FILES_TO_INCLUDE - filesToRead.length,
      filesToRead.map((u) => u.fsPath),
    );

    for (const uri of workspaceFiles) {
      if (!filesToRead.some((f) => f.fsPath === uri.fsPath)) {
        filesToRead.push(uri);
      }
    }

    // Read files up to total context limit
    const files: WorkspaceFile[] = [];
    let totalBytes = 0;

    for (const uri of filesToRead) {
      if (files.length >= MAX_FILES_TO_INCLUDE) {
        break;
      }

      const workspaceFile = await this.readWorkspaceFile(uri, rootUri.fsPath);
      if (!workspaceFile) {
        continue;
      }

      const fileBytes = Buffer.byteLength(workspaceFile.content, 'utf-8');
      if (totalBytes + fileBytes > MAX_TOTAL_CONTEXT_BYTES) {
        break;
      }

      files.push(workspaceFile);
      totalBytes += fileBytes;
    }

    return {
      files,
      activeFilePath: activeFilePath
        ? this.toRelativePath(activeFilePath, rootUri.fsPath)
        : undefined,
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
    const rootUri = workspaceFolders[0].uri;
    const result: vscode.Uri[] = [];
    await this.traverseDirectory(rootUri, rootUri.fsPath, result, 2000, []);
    return result.map((u) => this.toRelativePath(u.fsPath, rootUri.fsPath));
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

    const rootUri = workspaceFolders[0].uri;
    const rootFsPath = rootUri.fsPath;

    // Normalize and validate path
    const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '');
    if (!normalized || normalized.includes('..') || path.isAbsolute(normalized)) {
      return { content: `Invalid file path: ${relativePath}`, isError: true };
    }

    const targetUri = vscode.Uri.joinPath(rootUri, normalized);
    const workspaceFile = await this.readWorkspaceFile(targetUri, rootFsPath);

    if (!workspaceFile) {
      return { content: `File not found or excluded: ${relativePath}`, isError: true };
    }

    return { content: workspaceFile.content, isError: false };
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
