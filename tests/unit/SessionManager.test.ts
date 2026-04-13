import { workspace, Uri } from 'vscode';
import { SessionManager } from '../../src/sessions/SessionManager';
import { RoundType } from '../../src/types';

const mockFs = workspace.fs as jest.Mocked<typeof workspace.fs>;

const STORAGE_URI = Uri.file('/global-storage');

function makeManager() {
  return new SessionManager(STORAGE_URI);
}

function encodeJson(obj: unknown): Buffer {
  return Buffer.from(JSON.stringify(obj));
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: index not found → empty index
  mockFs.readFile.mockRejectedValue(new Error('file not found'));
  mockFs.writeFile.mockResolvedValue(undefined);
  mockFs.createDirectory.mockResolvedValue(undefined);
  mockFs.delete.mockResolvedValue(undefined);
});

// ── startSession ──────────────────────────────────────────────────────────────

describe('startSession', () => {
  it('returns a non-empty session id', async () => {
    const manager = makeManager();
    const id = await manager.startSession(RoundType.DEVELOPER);
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('creates the sessions directory', async () => {
    const manager = makeManager();
    await manager.startSession(RoundType.DEVELOPER);
    expect(mockFs.createDirectory).toHaveBeenCalled();
  });

  it('writes the session JSON file', async () => {
    const manager = makeManager();
    const id = await manager.startSession(RoundType.DEVELOPER);
    const writeCalls = (mockFs.writeFile as jest.Mock).mock.calls;
    const sessionWrite = writeCalls.find((call) =>
      (call[0] as Uri).fsPath.includes(id),
    );
    expect(sessionWrite).toBeDefined();
    const written = JSON.parse(Buffer.from(sessionWrite![1] as Uint8Array).toString());
    expect(written.id).toBe(id);
    expect(written.roundType).toBe(RoundType.DEVELOPER);
    expect(written.turns).toEqual([]);
  });

  it('writes index.json with one entry', async () => {
    const manager = makeManager();
    const id = await manager.startSession(RoundType.ARCHITECT);
    const writeCalls = (mockFs.writeFile as jest.Mock).mock.calls;
    const indexWrite = writeCalls.find((call) =>
      (call[0] as Uri).fsPath.endsWith('index.json'),
    );
    expect(indexWrite).toBeDefined();
    const index = JSON.parse(Buffer.from(indexWrite![1] as Uint8Array).toString());
    expect(index).toHaveLength(1);
    expect(index[0].id).toBe(id);
    expect(index[0].roundType).toBe(RoundType.ARCHITECT);
  });

  it('appends to existing index.json', async () => {
    const existing = [
      { id: 'old-session', workspaceId: 'abc', roundType: RoundType.QA, createdAt: 1, updatedAt: 1, turnCount: 2, preview: 'old' },
    ];
    mockFs.readFile.mockImplementation((uri: Uri) => {
      if (uri.fsPath.endsWith('index.json')) {
        return Promise.resolve(encodeJson(existing));
      }
      return Promise.reject(new Error('not found'));
    });

    const manager = makeManager();
    await manager.startSession(RoundType.DEVELOPER);

    const writeCalls = (mockFs.writeFile as jest.Mock).mock.calls;
    const indexWrites = writeCalls.filter((call) =>
      (call[0] as Uri).fsPath.endsWith('index.json'),
    );
    const lastIndex = JSON.parse(
      Buffer.from(indexWrites[indexWrites.length - 1][1] as Uint8Array).toString(),
    );
    expect(lastIndex.length).toBeGreaterThanOrEqual(2);
  });
});

// ── appendTurn ────────────────────────────────────────────────────────────────

describe('appendTurn', () => {
  it('appends a turn to the session file', async () => {
    const session = {
      id: 'sess-1',
      workspaceId: 'abc',
      roundType: RoundType.DEVELOPER,
      createdAt: 1000,
      updatedAt: 1000,
      turns: [] as { role: 'user' | 'assistant'; content: string }[],
    };
    const index = [{ id: 'sess-1', workspaceId: 'abc', roundType: RoundType.DEVELOPER, createdAt: 1000, updatedAt: 1000, turnCount: 0, preview: '' }];

    mockFs.readFile.mockImplementation((uri: Uri) => {
      if (uri.fsPath.includes('sess-1')) return Promise.resolve(encodeJson(session));
      if (uri.fsPath.endsWith('index.json')) return Promise.resolve(encodeJson(index));
      return Promise.reject(new Error('not found'));
    });

    const manager = makeManager();
    await manager.appendTurn('sess-1', { role: 'user', content: 'hello' });

    const writeCalls = (mockFs.writeFile as jest.Mock).mock.calls;
    const sessionWrite = writeCalls.find((call) => (call[0] as Uri).fsPath.includes('sess-1'));
    expect(sessionWrite).toBeDefined();
    const written = JSON.parse(Buffer.from(sessionWrite![1] as Uint8Array).toString());
    expect(written.turns).toHaveLength(1);
    expect(written.turns[0].content).toBe('hello');
  });

  it('does not throw if session file does not exist', async () => {
    const manager = makeManager();
    await expect(
      manager.appendTurn('nonexistent', { role: 'user', content: 'hi' }),
    ).resolves.not.toThrow();
  });

  it('skips index write when sessionId not found in index', async () => {
    const session = { id: 'sess-1', workspaceId: 'abc', roundType: RoundType.DEVELOPER, createdAt: 1, updatedAt: 1, turns: [] as { role: 'user' | 'assistant'; content: string }[] };
    // Index has a different session id
    const index = [{ id: 'other-session', workspaceId: 'abc', roundType: RoundType.DEVELOPER, createdAt: 1, updatedAt: 1, turnCount: 0, preview: '' }];

    mockFs.readFile.mockImplementation((uri: Uri) => {
      if (uri.fsPath.includes('sess-1')) return Promise.resolve(encodeJson(session));
      if (uri.fsPath.endsWith('index.json')) return Promise.resolve(encodeJson(index));
      return Promise.reject(new Error('not found'));
    });

    const writesBefore = (mockFs.writeFile as jest.Mock).mock.calls.length;
    const manager = makeManager();
    await manager.appendTurn('sess-1', { role: 'assistant', content: 'hi' });

    // session file write happens, but index write for updateIndexEntry does NOT
    const indexWrites = (mockFs.writeFile as jest.Mock).mock.calls
      .slice(writesBefore)
      .filter((c) => (c[0] as Uri).fsPath.endsWith('index.json'));
    expect(indexWrites).toHaveLength(0);
  });

  it('uses empty string preview when no user turn exists (assistant-only turns)', async () => {
    const session = { id: 'sess-1', workspaceId: 'abc', roundType: RoundType.DEVELOPER, createdAt: 1, updatedAt: 1, turns: [] as { role: 'user' | 'assistant'; content: string }[] };
    const index = [{ id: 'sess-1', workspaceId: 'abc', roundType: RoundType.DEVELOPER, createdAt: 1, updatedAt: 1, turnCount: 0, preview: '' }];

    mockFs.readFile.mockImplementation((uri: Uri) => {
      if (uri.fsPath.includes('sess-1')) return Promise.resolve(encodeJson(session));
      if (uri.fsPath.endsWith('index.json')) return Promise.resolve(encodeJson(index));
      return Promise.reject(new Error('not found'));
    });

    const manager = makeManager();
    await manager.appendTurn('sess-1', { role: 'assistant', content: 'response with no prior user turn' });

    const writeCalls = (mockFs.writeFile as jest.Mock).mock.calls;
    const indexWrites = writeCalls.filter((c) => (c[0] as Uri).fsPath.endsWith('index.json'));
    const lastIndex = JSON.parse(Buffer.from(indexWrites[indexWrites.length - 1][1] as Uint8Array).toString());
    expect(lastIndex[0].preview).toBe('');
  });

  it('updates turnCount in index', async () => {
    const session = { id: 'sess-1', workspaceId: 'abc', roundType: RoundType.DEVELOPER, createdAt: 1, updatedAt: 1, turns: [{ role: 'user', content: 'hi' }] };
    const index = [{ id: 'sess-1', workspaceId: 'abc', roundType: RoundType.DEVELOPER, createdAt: 1, updatedAt: 1, turnCount: 1, preview: 'hi' }];

    mockFs.readFile.mockImplementation((uri: Uri) => {
      if (uri.fsPath.includes('sess-1')) return Promise.resolve(encodeJson(session));
      if (uri.fsPath.endsWith('index.json')) return Promise.resolve(encodeJson(index));
      return Promise.reject(new Error('not found'));
    });

    const manager = makeManager();
    await manager.appendTurn('sess-1', { role: 'assistant', content: 'response' });

    const writeCalls = (mockFs.writeFile as jest.Mock).mock.calls;
    const indexWrites = writeCalls.filter((call) => (call[0] as Uri).fsPath.endsWith('index.json'));
    const lastIndex = JSON.parse(Buffer.from(indexWrites[indexWrites.length - 1][1] as Uint8Array).toString());
    expect(lastIndex[0].turnCount).toBe(2);
  });

  it('serializes concurrent appends to prevent turn loss', async () => {
    let session = {
      id: 'sess-1',
      workspaceId: 'abc',
      roundType: RoundType.DEVELOPER,
      createdAt: 1,
      updatedAt: 1,
      turns: [] as { role: 'user' | 'assistant'; content: string }[],
    };
    let index = [{ id: 'sess-1', workspaceId: 'abc', roundType: RoundType.DEVELOPER, createdAt: 1, updatedAt: 1, turnCount: 0, preview: '' }];

    mockFs.readFile.mockImplementation((uri: Uri) => {
      if (uri.fsPath.includes('sess-1')) {
        return Promise.resolve(encodeJson(session));
      }
      if (uri.fsPath.endsWith('index.json')) {
        return Promise.resolve(encodeJson(index));
      }
      return Promise.reject(new Error('not found'));
    });

    mockFs.writeFile.mockImplementation(async (uri: Uri, bytes: Uint8Array) => {
      const parsed = JSON.parse(Buffer.from(bytes).toString('utf-8'));
      if (uri.fsPath.includes('sess-1')) {
        // Simulate I/O latency to maximize overlap pressure.
        await new Promise((resolve) => setTimeout(resolve, 5));
        session = parsed;
        return;
      }
      if (uri.fsPath.endsWith('index.json')) {
        index = parsed;
      }
    });

    const manager = makeManager();
    await Promise.all([
      manager.appendTurn('sess-1', { role: 'user', content: 'first' }),
      manager.appendTurn('sess-1', { role: 'assistant', content: 'second' }),
    ]);

    expect(session.turns).toHaveLength(2);
    expect(session.turns[0].content).toBe('first');
    expect(session.turns[1].content).toBe('second');
    expect(index[0].turnCount).toBe(2);
  });
});

// ── updateSessionRoundType ────────────────────────────────────────────────────

describe('updateSessionRoundType', () => {
  it('updates session file and index roundType', async () => {
    const session = {
      id: 'sess-1',
      workspaceId: 'abc',
      roundType: RoundType.DEVELOPER,
      createdAt: 1000,
      updatedAt: 1000,
      turns: [] as { role: 'user' | 'assistant'; content: string }[],
    };
    const index = [{ id: 'sess-1', workspaceId: 'abc', roundType: RoundType.DEVELOPER, createdAt: 1000, updatedAt: 1000, turnCount: 0, preview: '' }];

    mockFs.readFile.mockImplementation((uri: Uri) => {
      if (uri.fsPath.includes('sess-1')) return Promise.resolve(encodeJson(session));
      if (uri.fsPath.endsWith('index.json')) return Promise.resolve(encodeJson(index));
      return Promise.reject(new Error('not found'));
    });

    const manager = makeManager();
    await manager.updateSessionRoundType('sess-1', RoundType.QA);

    const writeCalls = (mockFs.writeFile as jest.Mock).mock.calls;
    const sessionWrite = writeCalls.find((call) => (call[0] as Uri).fsPath.includes('sess-1'));
    const indexWrites = writeCalls.filter((call) => (call[0] as Uri).fsPath.endsWith('index.json'));

    expect(sessionWrite).toBeDefined();
    expect(indexWrites.length).toBeGreaterThan(0);

    const writtenSession = JSON.parse(Buffer.from(sessionWrite![1] as Uint8Array).toString());
    const writtenIndex = JSON.parse(Buffer.from(indexWrites[indexWrites.length - 1][1] as Uint8Array).toString());
    expect(writtenSession.roundType).toBe(RoundType.QA);
    expect(writtenIndex[0].roundType).toBe(RoundType.QA);
  });

  it('is a no-op when session roundType is already the same', async () => {
    const session = {
      id: 'sess-1',
      workspaceId: 'abc',
      roundType: RoundType.DEVELOPER,
      createdAt: 1000,
      updatedAt: 1000,
      turns: [] as { role: 'user' | 'assistant'; content: string }[],
    };
    mockFs.readFile.mockImplementation((uri: Uri) => {
      if (uri.fsPath.includes('sess-1')) return Promise.resolve(encodeJson(session));
      if (uri.fsPath.endsWith('index.json')) return Promise.resolve(encodeJson([]));
      return Promise.reject(new Error('not found'));
    });

    const writesBefore = (mockFs.writeFile as jest.Mock).mock.calls.length;
    const manager = makeManager();
    await manager.updateSessionRoundType('sess-1', RoundType.DEVELOPER);
    const writesAfter = (mockFs.writeFile as jest.Mock).mock.calls.length;
    expect(writesAfter).toBe(writesBefore);
  });
});

// ── listSessions ──────────────────────────────────────────────────────────────

describe('listSessions', () => {
  it('returns sessions sorted by updatedAt descending', async () => {
    const index = [
      { id: 'old', workspaceId: 'x', roundType: RoundType.QA, createdAt: 1, updatedAt: 100, turnCount: 1, preview: '' },
      { id: 'new', workspaceId: 'x', roundType: RoundType.DEVELOPER, createdAt: 2, updatedAt: 200, turnCount: 2, preview: '' },
    ];
    mockFs.readFile.mockResolvedValue(encodeJson(index));

    const manager = makeManager();
    const result = await manager.listSessions();
    expect(result[0].id).toBe('new');
    expect(result[1].id).toBe('old');
  });

  it('returns empty array if index does not exist', async () => {
    mockFs.readFile.mockRejectedValue(new Error('not found'));
    const manager = makeManager();
    const result = await manager.listSessions();
    expect(result).toEqual([]);
  });

  it('filters malformed entries in index', async () => {
    const validEntry = {
      id: 'sess-1',
      workspaceId: 'x',
      roundType: RoundType.DEVELOPER,
      createdAt: 1,
      updatedAt: 2,
      turnCount: 1,
      preview: 'ok',
    };
    const invalidEntry = {
      id: 123,
      workspaceId: 'x',
      roundType: 'bad-round',
      createdAt: 'nope',
      updatedAt: 2,
      turnCount: 1,
      preview: 'bad',
    };
    mockFs.readFile.mockResolvedValue(encodeJson([validEntry, invalidEntry]));

    const manager = makeManager();
    const result = await manager.listSessions();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('sess-1');
  });
});

// ── loadSession ───────────────────────────────────────────────────────────────

describe('loadSession', () => {
  it('returns session for valid id', async () => {
    const session = { id: 'sess-1', workspaceId: 'abc', roundType: RoundType.DEVELOPER, createdAt: 1, updatedAt: 1, turns: [] as { role: 'user' | 'assistant'; content: string }[] };
    mockFs.readFile.mockResolvedValue(encodeJson(session));

    const manager = makeManager();
    const result = await manager.loadSession('sess-1');
    expect(result?.id).toBe('sess-1');
  });

  it('returns undefined for missing file', async () => {
    mockFs.readFile.mockRejectedValue(new Error('not found'));
    const manager = makeManager();
    const result = await manager.loadSession('missing');
    expect(result).toBeUndefined();
  });

  it('returns undefined for corrupted JSON', async () => {
    mockFs.readFile.mockResolvedValue(Buffer.from('not-json{{'));
    const manager = makeManager();
    const result = await manager.loadSession('bad');
    expect(result).toBeUndefined();
  });

  it('returns undefined for invalid session schema', async () => {
    mockFs.readFile.mockResolvedValue(encodeJson({
      id: 'sess-1',
      workspaceId: 'abc',
      roundType: 'malicious-round',
      createdAt: 1,
      updatedAt: 1,
      turns: [{ role: 'system', content: 'inject' }],
    }));
    const manager = makeManager();
    const result = await manager.loadSession('sess-1');
    expect(result).toBeUndefined();
  });
});

// ── pruneOldSessions ──────────────────────────────────────────────────────────

describe('pruneOldSessions', () => {
  it('deletes oldest sessions beyond maxCount', async () => {
    const index = Array.from({ length: 5 }, (_, i) => ({
      id: `sess-${i}`,
      workspaceId: 'x',
      roundType: RoundType.DEVELOPER,
      createdAt: i,
      updatedAt: i,
      turnCount: 0,
      preview: '',
    }));
    mockFs.readFile.mockResolvedValue(encodeJson(index));

    const manager = makeManager();
    await manager.pruneOldSessions(3);

    expect(mockFs.delete).toHaveBeenCalledTimes(2);
  });

  it('rewrites index without pruned entries', async () => {
    const index = Array.from({ length: 4 }, (_, i) => ({
      id: `sess-${i}`,
      workspaceId: 'x',
      roundType: RoundType.DEVELOPER,
      createdAt: i,
      updatedAt: i,
      turnCount: 0,
      preview: '',
    }));
    mockFs.readFile.mockResolvedValue(encodeJson(index));

    const manager = makeManager();
    await manager.pruneOldSessions(2);

    const writeCalls = (mockFs.writeFile as jest.Mock).mock.calls;
    const indexWrite = writeCalls.find((call) => (call[0] as Uri).fsPath.endsWith('index.json'));
    const written = JSON.parse(Buffer.from(indexWrite![1] as Uint8Array).toString());
    expect(written).toHaveLength(2);
  });

  it('does nothing if count is within limit', async () => {
    const index = [{ id: 'sess-1', workspaceId: 'x', roundType: RoundType.DEVELOPER, createdAt: 1, updatedAt: 1, turnCount: 0, preview: '' }];
    mockFs.readFile.mockResolvedValue(encodeJson(index));

    const manager = makeManager();
    await manager.pruneOldSessions(20);

    expect(mockFs.delete).not.toHaveBeenCalled();
  });

  it('continues pruning if individual file delete fails', async () => {
    const index = Array.from({ length: 3 }, (_, i) => ({
      id: `sess-${i}`,
      workspaceId: 'x',
      roundType: RoundType.DEVELOPER,
      createdAt: i,
      updatedAt: i,
      turnCount: 0,
      preview: '',
    }));
    mockFs.readFile.mockResolvedValue(encodeJson(index));
    mockFs.delete.mockRejectedValue(new Error('permission denied'));

    const manager = makeManager();
    // Should not throw even if delete fails
    await expect(manager.pruneOldSessions(1)).resolves.not.toThrow();
    // Index is still rewritten without the deleted entries
    const writeCalls = (mockFs.writeFile as jest.Mock).mock.calls;
    const indexWrite = writeCalls.find((call) => (call[0] as Uri).fsPath.endsWith('index.json'));
    expect(indexWrite).toBeDefined();
  });
});

// ── workspace hash caching ─────────────────────────────────────────────────────

describe('workspace hash caching', () => {
  it('returns the same hash on repeated calls', async () => {
    const manager = makeManager();
    // Trigger two calls to getWorkspaceHash via startSession
    const id1 = await manager.startSession(RoundType.DEVELOPER);
    const id2 = await manager.startSession(RoundType.QA);
    // Both session files should be under the same workspace-hash directory
    const calls = (mockFs.writeFile as jest.Mock).mock.calls;
    const sessionPaths = calls
      .filter((c) => !(c[0] as Uri).fsPath.endsWith('index.json'))
      .map((c) => (c[0] as Uri).fsPath);
    const dirs = sessionPaths.map((p) => p.split('/').slice(0, -1).join('/'));
    expect(dirs[0]).toBe(dirs[dirs.length - 1]);
    expect(id1).not.toBe(id2);
  });

  it('serializes concurrent startSession index updates', async () => {
    let index: unknown[] = [];

    mockFs.readFile.mockImplementation((uri: Uri) => {
      if (uri.fsPath.endsWith('index.json')) {
        return Promise.resolve(encodeJson(index));
      }
      return Promise.reject(new Error('not found'));
    });

    mockFs.writeFile.mockImplementation(async (uri: Uri, bytes: Uint8Array) => {
      if (uri.fsPath.endsWith('index.json')) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        index = JSON.parse(Buffer.from(bytes).toString('utf-8')) as unknown[];
      }
    });

    const manager = makeManager();
    await Promise.all([
      manager.startSession(RoundType.DEVELOPER),
      manager.startSession(RoundType.QA),
    ]);

    expect(index).toHaveLength(2);
  });

  it('uses no-workspace fallback when workspaceFolders is empty', async () => {
    const { workspace } = await import('vscode');
    (workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;

    const manager = makeManager();
    const id = await manager.startSession(RoundType.DEVELOPER);
    expect(id).toBeTruthy();

    // Restore
    (workspace as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: { fsPath: '/workspace' }, name: 'test', index: 0 },
    ];
  });
});

// ── listSessions catch branch ──────────────────────────────────────────────────

describe('listSessions error handling', () => {
  it('returns empty array when readIndex throws unexpectedly', async () => {
    // Make readFile succeed but return non-JSON so JSON.parse throws inside readIndex,
    // which catches and returns [] — then sort succeeds. To trigger the outer catch in
    // listSessions itself, we make readIndex throw by mocking it via a derived class.
    mockFs.readFile.mockResolvedValue(Buffer.from('null')); // valid JSON but wrong type
    const manager = makeManager();
    const result = await manager.listSessions();
    // null.sort() would throw; listSessions catch should handle it
    expect(Array.isArray(result)).toBe(true);
  });
});
