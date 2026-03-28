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
      expect(context.files[0].content).toBe('const app = 1;');
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
      expect(context.files[0].content).toContain('[... truncated at 50000 bytes ...]');
      expect(context.files[0].content.length).toBeLessThan(largeContent.length);
    });

    it('respects MAX_FILES_TO_INCLUDE (20 files)', async () => {
      setupWorkspaceRoot('/workspace');
      // Return 30 files
      const files: [string, FileType][] = Array.from({ length: 30 }, (_, i) => [
        `file${i}.ts`,
        FileType.File,
      ]);
      mockWorkspace.fs.readDirectory = jest.fn().mockResolvedValue(files);
      mockWorkspace.fs.stat = jest.fn().mockResolvedValue({ size: 100, type: FileType.File });
      mockWorkspace.fs.readFile = jest.fn().mockResolvedValue(Buffer.from('code'));

      const reader = new WorkspaceReader();
      const context = await reader.buildContext();
      expect(context.files.length).toBeLessThanOrEqual(20);
    });

    it('stops adding files when total bytes would exceed MAX_TOTAL_CONTEXT_BYTES', async () => {
      setupWorkspaceRoot('/workspace');
      // Each file is 50000 bytes; after 4 files we hit 200000 — 5th should not be included
      const files: [string, FileType][] = Array.from({ length: 10 }, (_, i) => [
        `file${i}.ts`,
        FileType.File,
      ]);
      mockWorkspace.fs.readDirectory = jest.fn().mockResolvedValue(files);
      mockWorkspace.fs.stat = jest.fn().mockResolvedValue({ size: 49999, type: FileType.File });
      const content = 'x'.repeat(49999);
      mockWorkspace.fs.readFile = jest.fn().mockResolvedValue(Buffer.from(content));

      const reader = new WorkspaceReader();
      const context = await reader.buildContext();

      const totalBytes = context.files.reduce(
        (sum, f) => sum + Buffer.byteLength(f.content, 'utf-8'),
        0,
      );
      expect(totalBytes).toBeLessThanOrEqual(200_000);
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
  });
});
