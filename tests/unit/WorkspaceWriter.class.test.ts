import * as vscode from 'vscode';
import { WorkspaceWriter, WorkspaceWriterError } from '../../src/workspace/WorkspaceWriter';

// ── Helpers ───────────────────────────────────────────────────────────────────

function setWorkspace(rootPath = '/workspace/project') {
  (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
    { uri: vscode.Uri.file(rootPath), name: 'project', index: 0 },
  ];
}

function clearWorkspace() {
  (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
}

const existingChange = { filePath: 'src/app.ts', content: 'const x = 1;', isNew: false };
const newChange = { filePath: 'src/new.ts', content: 'export {};', isNew: false };

// ── previewChange ─────────────────────────────────────────────────────────────

describe('WorkspaceWriter.previewChange', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setWorkspace();
    // Default: file exists
    (vscode.workspace.fs.stat as jest.Mock).mockResolvedValue({ size: 100 });
  });

  afterEach(() => clearWorkspace());

  it('throws WorkspaceWriterError when no workspace folder is open', async () => {
    clearWorkspace();
    const writer = new WorkspaceWriter();
    await expect(writer.previewChange(existingChange))
      .rejects.toBeInstanceOf(WorkspaceWriterError);
  });

  it('calls vscode.diff for an existing file', async () => {
    const writer = new WorkspaceWriter();
    await writer.previewChange(existingChange);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'vscode.diff',
      expect.anything(),
      expect.anything(),
      expect.stringContaining('(modified)'),
      expect.anything(),
    );
  });

  it('calls vscode.diff for a new file with (new file) title', async () => {
    (vscode.workspace.fs.stat as jest.Mock).mockRejectedValue(new Error('not found'));
    const writer = new WorkspaceWriter();
    await writer.previewChange(newChange);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'vscode.diff',
      expect.anything(),
      expect.anything(),
      expect.stringContaining('(new file)'),
      expect.anything(),
    );
  });
});

// ── applyChanges ──────────────────────────────────────────────────────────────

describe('WorkspaceWriter.applyChanges', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setWorkspace();
    // Default: file exists
    (vscode.workspace.fs.stat as jest.Mock).mockResolvedValue({ size: 100 });
    (vscode.workspace.applyEdit as jest.Mock).mockResolvedValue(true);
  });

  afterEach(() => clearWorkspace());

  it('throws WorkspaceWriterError when no workspace folder is open', async () => {
    clearWorkspace();
    const writer = new WorkspaceWriter();
    await expect(writer.applyChanges([existingChange]))
      .rejects.toBeInstanceOf(WorkspaceWriterError);
  });

  it('returns empty lists for empty fileChanges array', async () => {
    const writer = new WorkspaceWriter();
    const result = await writer.applyChanges([]);
    expect(result.appliedFiles).toEqual([]);
    expect(result.newFiles).toEqual([]);
    expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
  });

  it('applies edit to existing file and returns appliedFiles', async () => {
    const writer = new WorkspaceWriter();
    const result = await writer.applyChanges([existingChange]);
    expect(result.appliedFiles).toContain('src/app.ts');
    expect(result.newFiles).toHaveLength(0);
    expect(vscode.workspace.applyEdit).toHaveBeenCalledTimes(1);
  });

  it('creates new file and returns newFiles', async () => {
    (vscode.workspace.fs.stat as jest.Mock).mockRejectedValue(new Error('not found'));
    const writer = new WorkspaceWriter();
    const result = await writer.applyChanges([newChange]);
    expect(result.newFiles).toContain('src/new.ts');
    expect(result.appliedFiles).toHaveLength(0);
  });

  it('handles mix of existing and new files', async () => {
    (vscode.workspace.fs.stat as jest.Mock)
      .mockResolvedValueOnce({ size: 100 }) // existing
      .mockRejectedValueOnce(new Error('not found')); // new
    const writer = new WorkspaceWriter();
    const result = await writer.applyChanges([existingChange, newChange]);
    expect(result.appliedFiles).toHaveLength(1);
    expect(result.newFiles).toHaveLength(1);
  });

  it('throws WorkspaceWriterError when applyEdit returns false', async () => {
    (vscode.workspace.applyEdit as jest.Mock).mockResolvedValue(false);
    const writer = new WorkspaceWriter();
    await expect(writer.applyChanges([existingChange]))
      .rejects.toBeInstanceOf(WorkspaceWriterError);
  });

  it('applies multiple file changes in a single WorkspaceEdit', async () => {
    const writer = new WorkspaceWriter();
    await writer.applyChanges([existingChange, { ...existingChange, filePath: 'src/b.ts' }]);
    expect(vscode.workspace.applyEdit).toHaveBeenCalledTimes(1);
  });
});

// ── applySingleChange ─────────────────────────────────────────────────────────

describe('WorkspaceWriter.applySingleChange', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setWorkspace();
    (vscode.workspace.fs.stat as jest.Mock).mockResolvedValue({ size: 100 });
    (vscode.workspace.applyEdit as jest.Mock).mockResolvedValue(true);
  });

  afterEach(() => clearWorkspace());

  it('throws WorkspaceWriterError when no workspace folder', async () => {
    clearWorkspace();
    const writer = new WorkspaceWriter();
    await expect(writer.applySingleChange(existingChange))
      .rejects.toBeInstanceOf(WorkspaceWriterError);
  });

  it('applies to existing file successfully', async () => {
    const writer = new WorkspaceWriter();
    await expect(writer.applySingleChange(existingChange)).resolves.toBeUndefined();
    expect(vscode.workspace.applyEdit).toHaveBeenCalledTimes(1);
  });

  it('creates new file when it does not exist', async () => {
    (vscode.workspace.fs.stat as jest.Mock).mockRejectedValue(new Error('not found'));
    const writer = new WorkspaceWriter();
    await expect(writer.applySingleChange(newChange)).resolves.toBeUndefined();
  });

  it('throws WorkspaceWriterError when applyEdit returns false', async () => {
    (vscode.workspace.applyEdit as jest.Mock).mockResolvedValue(false);
    const writer = new WorkspaceWriter();
    await expect(writer.applySingleChange(existingChange))
      .rejects.toBeInstanceOf(WorkspaceWriterError);
  });
});
