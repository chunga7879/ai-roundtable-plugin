import { WorkspaceReader } from '../../src/workspace/WorkspaceReader';
import { workspace, window, Uri, FileType } from 'vscode';

const mockWorkspace = workspace as jest.Mocked<typeof workspace>;
const mockWindow = window as unknown as {
  activeTextEditor: typeof window.activeTextEditor;
  visibleTextEditors: typeof window.visibleTextEditors;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeUri(path: string) {
  return Uri.file(path);
}

function setupWorkspaceRoot(rootPath = '/workspace') {
  (mockWorkspace as { workspaceFolders: unknown }).workspaceFolders = [
    { uri: makeUri(rootPath), name: 'test', index: 0 },
  ];
}

function resetWorkspace() {
  (mockWorkspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
  mockWindow.activeTextEditor = undefined;
  mockWindow.visibleTextEditors = [];
  jest.clearAllMocks();
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('WorkspaceReader', () => {
  beforeEach(() => {
    resetWorkspace();
  });

  describe('buildContext', () => {
    it('returns empty context when no workspace folders are open', async () => {
      const reader = new WorkspaceReader();
      const context = await reader.buildContext();
      expect(context.files).toHaveLength(0);
      expect(context.activeFilePath).toBeUndefined();
    });

    it('returns empty context when workspace has no files', async () => {
      setupWorkspaceRoot('/workspace');
      mockWorkspace.fs.readDirectory = jest.fn().mockResolvedValue([]);

      const reader = new WorkspaceReader();
      const context = await reader.buildContext();
      expect(context.files).toHaveLength(0);
    });

    it('reads files from the workspace root', async () => {
      setupWorkspaceRoot('/workspace');
      mockWorkspace.fs.readDirectory = jest.fn().mockResolvedValue([
        ['app.ts', FileType.File],
      ]);
      mockWorkspace.fs.stat = jest.fn().mockResolvedValue({ size: 100, type: FileType.File });
      mockWorkspace.fs.readFile = jest.fn().mockResolvedValue(
        Buffer.from('const app = 1;'),
      );

      const reader = new WorkspaceReader();
      const context = await reader.buildContext();
      expect(context.files).toHaveLength(1);
      expect(context.files[0].path).toBe('app.ts');
      expect(context.files[0].content).toBe('');
      expect(context.files[0].language).toBe('typescript');
    });

    it('excludes files with binary/media extensions', async () => {
      setupWorkspaceRoot('/workspace');
      mockWorkspace.fs.readDirectory = jest.fn().mockResolvedValue([
        ['image.png', FileType.File],
        ['video.mp4', FileType.File],
        ['archive.zip', FileType.File],
        ['app.ts', FileType.File],
      ]);
      mockWorkspace.fs.stat = jest.fn().mockResolvedValue({ size: 100, type: FileType.File });
      mockWorkspace.fs.readFile = jest.fn().mockResolvedValue(Buffer.from('code'));

      const reader = new WorkspaceReader();
      const context = await reader.buildContext();
      // Only app.ts should be included
      const paths = context.files.map((f) => f.path);
      expect(paths).toContain('app.ts');
      expect(paths).not.toContain('image.png');
      expect(paths).not.toContain('video.mp4');
      expect(paths).not.toContain('archive.zip');
    });

    it('excludes .env files', async () => {
      setupWorkspaceRoot('/workspace');
      mockWorkspace.fs.readDirectory = jest.fn().mockResolvedValue([
        ['.env', FileType.File],
        ['app.ts', FileType.File],
      ]);
      mockWorkspace.fs.stat = jest.fn().mockResolvedValue({ size: 100, type: FileType.File });
      mockWorkspace.fs.readFile = jest.fn().mockResolvedValue(Buffer.from('code'));

      const reader = new WorkspaceReader();
      const context = await reader.buildContext();
      const paths = context.files.map((f) => f.path);
      expect(paths).not.toContain('.env');
      expect(paths).toContain('app.ts');
    });

    it('excludes files in node_modules directory', async () => {
      setupWorkspaceRoot('/workspace');
      // Simulate traversal: root has node_modules dir and app.ts
      mockWorkspace.fs.readDirectory = jest.fn().mockImplementation((uri: Uri) => {
        if (uri.fsPath === '/workspace') {
          return Promise.resolve([
            ['node_modules', FileType.Directory],
            ['app.ts', FileType.File],
          ]);
        }
        return Promise.resolve([]);
      });
      mockWorkspace.fs.stat = jest.fn().mockResolvedValue({ size: 100, type: FileType.File });
      mockWorkspace.fs.readFile = jest.fn().mockResolvedValue(Buffer.from('code'));

      const reader = new WorkspaceReader();
      const context = await reader.buildContext();
      // node_modules should not be traversed
      expect(mockWorkspace.fs.readDirectory).not.toHaveBeenCalledWith(
        expect.objectContaining({ fsPath: '/workspace/node_modules' }),
      );
      expect(context.files).toHaveLength(1);
      expect(context.files[0].path).toBe('app.ts');
    });

    it('truncates files larger than MAX_FILE_SIZE_BYTES (50000 bytes)', async () => {
      setupWorkspaceRoot('/workspace');
      mockWorkspace.fs.readDirectory = jest.fn().mockResolvedValue([
        ['large.ts', FileType.File],
      ]);
      const largeContent = 'x'.repeat(60000);
      mockWorkspace.fs.stat = jest.fn().mockResolvedValue({ size: 60000, type: FileType.File });
      mockWorkspace.fs.readFile = jest.fn().mockResolvedValue(Buffer.from(largeContent));

      const reader = new WorkspaceReader();
      const context = await reader.buildContext();
      expect(context.files).toHaveLength(1);
      expect(context.files[0].content).toBe('');
    });

    it('respects MAX_FILES_TO_INCLUDE (50 files)', async () => {
      setupWorkspaceRoot('/workspace');
      // Return 60 files
      const files: [string, FileType][] = Array.from({ length: 60 }, (_, i) => [
        `file${i}.ts`,
        FileType.File,
      ]);
      mockWorkspace.fs.readDirectory = jest.fn().mockResolvedValue(files);
      mockWorkspace.fs.stat = jest.fn().mockResolvedValue({ size: 100, type: FileType.File });
      mockWorkspace.fs.readFile = jest.fn().mockResolvedValue(Buffer.from('code'));

      const reader = new WorkspaceReader();
      const context = await reader.buildContext();
      expect(context.files.length).toBeLessThanOrEqual(50);
    });

    it('returns empty content for all files (content is read on-demand via tool calls)', async () => {
      setupWorkspaceRoot('/workspace');
      const files: [string, FileType][] = Array.from({ length: 5 }, (_, i) => [
        `file${i}.ts`,
        FileType.File,
      ]);
      mockWorkspace.fs.readDirectory = jest.fn().mockResolvedValue(files);
      mockWorkspace.fs.stat = jest.fn().mockResolvedValue({ size: 100, type: FileType.File });
      mockWorkspace.fs.readFile = jest.fn().mockResolvedValue(Buffer.from('should not be read'));

      const reader = new WorkspaceReader();
      const context = await reader.buildContext();

      // buildContext never reads file contents — agent uses read_file tool on demand
      expect(context.files.every((f) => f.content === '')).toBe(true);
      expect(mockWorkspace.fs.readFile).not.toHaveBeenCalled();
    });
  });

  // ── readFileForTool ───────────────────────────────────────────────────────────

  describe('readFileForTool', () => {
    it('returns file content for a valid path', async () => {
      setupWorkspaceRoot('/workspace');
      mockWorkspace.fs.stat = jest.fn().mockResolvedValue({ size: 100, type: FileType.File });
      mockWorkspace.fs.readFile = jest.fn().mockResolvedValue(Buffer.from('const x = 1;'));

      const reader = new WorkspaceReader();
      const result = await reader.readFileForTool('src/app.ts');

      expect(result.isError).toBe(false);
      expect(result.content).toBe('const x = 1;');
    });

    it('truncates files exceeding MAX_FILE_SIZE_BYTES (50000 bytes)', async () => {
      setupWorkspaceRoot('/workspace');
      const largeContent = 'x'.repeat(60_000);
      mockWorkspace.fs.stat = jest.fn().mockResolvedValue({ size: 60_000, type: FileType.File });
      mockWorkspace.fs.readFile = jest.fn().mockResolvedValue(Buffer.from(largeContent));

      const reader = new WorkspaceReader();
      const result = await reader.readFileForTool('large.ts');

      expect(result.isError).toBe(false);
      expect(result.content).toContain('[... truncated at 50000 bytes ...]');
      expect(result.content.length).toBeLessThan(largeContent.length);
    });

    it('returns error for path traversal attempt', async () => {
      setupWorkspaceRoot('/workspace');

      const reader = new WorkspaceReader();
      const result = await reader.readFileForTool('../etc/passwd');

      expect(result.isError).toBe(true);
      expect(result.content).toContain('Invalid file path');
    });

    it('returns error for absolute path', async () => {
      setupWorkspaceRoot('/workspace');

      const reader = new WorkspaceReader();
      const result = await reader.readFileForTool('/etc/passwd');

      expect(result.isError).toBe(true);
    });

    it('returns error for excluded extension', async () => {
      setupWorkspaceRoot('/workspace');
      mockWorkspace.fs.stat = jest.fn().mockResolvedValue({ size: 100, type: FileType.File });
      mockWorkspace.fs.readFile = jest.fn().mockResolvedValue(Buffer.from('data'));

      const reader = new WorkspaceReader();
      const result = await reader.readFileForTool('key.pem');

      expect(result.isError).toBe(true);
    });

    it('returns error for excluded filename (.env)', async () => {
      setupWorkspaceRoot('/workspace');
      mockWorkspace.fs.stat = jest.fn().mockResolvedValue({ size: 100, type: FileType.File });

      const reader = new WorkspaceReader();
      const result = await reader.readFileForTool('.env');

      expect(result.isError).toBe(true);
    });

    it('returns error when no workspace is open', async () => {
      (mockWorkspace as { workspaceFolders: unknown }).workspaceFolders = undefined;

      const reader = new WorkspaceReader();
      const result = await reader.readFileForTool('app.ts');

      expect(result.isError).toBe(true);
      expect(result.content).toContain('No workspace folder');
    });
  });

    it('sets activeFilePath relative to workspace root', async () => {
      setupWorkspaceRoot('/workspace');
      mockWindow.activeTextEditor = {
        document: {
          uri: makeUri('/workspace/src/app.ts'),
          isUntitled: false,
        },
      } as unknown as typeof window.activeTextEditor;
      mockWorkspace.fs.readDirectory = jest.fn().mockResolvedValue([]);

      const reader = new WorkspaceReader();
      const context = await reader.buildContext();
      expect(context.activeFilePath).toBe('src/app.ts');
    });

    // ── Security regression: workspace containment ──────────────────────────────

    it('excludes active editor file located outside the workspace root', async () => {
      setupWorkspaceRoot('/workspace');
      mockWindow.activeTextEditor = {
        document: {
          uri: makeUri('/etc/passwd'),
          isUntitled: false,
        },
      } as unknown as typeof window.activeTextEditor;
      mockWorkspace.fs.readDirectory = jest.fn().mockResolvedValue([]);

      const reader = new WorkspaceReader();
      const context = await reader.buildContext();

      const paths = context.files.map((f) => f.path);
      expect(paths).not.toContain('../etc/passwd');
      expect(paths).not.toContain('/etc/passwd');
      expect(context.files).toHaveLength(0);
    });

    it('excludes visible editor file located outside the workspace root', async () => {
      setupWorkspaceRoot('/workspace');
      mockWindow.visibleTextEditors = [
        {
          document: {
            uri: makeUri('/home/user/.ssh/id_rsa'),
            isUntitled: false,
          },
        },
      ] as unknown as typeof window.visibleTextEditors;
      mockWorkspace.fs.readDirectory = jest.fn().mockResolvedValue([]);

      const reader = new WorkspaceReader();
      const context = await reader.buildContext();

      expect(context.files).toHaveLength(0);
    });

    it('includes active editor file inside the workspace root', async () => {
      setupWorkspaceRoot('/workspace');
      mockWindow.activeTextEditor = {
        document: {
          uri: makeUri('/workspace/src/index.ts'),
          isUntitled: false,
        },
      } as unknown as typeof window.activeTextEditor;
      mockWorkspace.fs.readDirectory = jest.fn().mockResolvedValue([]);

      const reader = new WorkspaceReader();
      const context = await reader.buildContext();

      expect(context.files.map((f) => f.path)).toContain('src/index.ts');
    });

    // ── Security regression: excluded directory check in buildContext ───────────

    it('excludes active editor file inside node_modules', async () => {
      setupWorkspaceRoot('/workspace');
      mockWindow.activeTextEditor = {
        document: {
          uri: makeUri('/workspace/node_modules/lodash/lodash.js'),
          isUntitled: false,
        },
      } as unknown as typeof window.activeTextEditor;
      mockWorkspace.fs.readDirectory = jest.fn().mockResolvedValue([]);

      const reader = new WorkspaceReader();
      const context = await reader.buildContext();

      expect(context.files.map((f) => f.path)).not.toContain('node_modules/lodash/lodash.js');
    });

    it('excludes active editor file inside .git directory', async () => {
      setupWorkspaceRoot('/workspace');
      mockWindow.activeTextEditor = {
        document: {
          uri: makeUri('/workspace/.git/config'),
          isUntitled: false,
        },
      } as unknown as typeof window.activeTextEditor;
      mockWorkspace.fs.readDirectory = jest.fn().mockResolvedValue([]);

      const reader = new WorkspaceReader();
      const context = await reader.buildContext();

      expect(context.files.map((f) => f.path)).not.toContain('.git/config');
    });
});
