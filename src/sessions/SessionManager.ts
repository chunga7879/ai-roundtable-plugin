import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { RoundType } from '../types';
import type { ConversationTurn, PersistedSession, SessionIndexEntry } from '../types';

const MAX_SESSIONS = 20;
const PREVIEW_LENGTH = 80;
const VALID_ROUND_TYPES = new Set<string>(Object.values(RoundType));
const VALID_TURN_ROLES = new Set<ConversationTurn['role']>(['user', 'assistant']);

export class SessionManager {
  private workspaceHash: string | undefined;
  private appendQueues = new Map<string, Promise<void>>();
  private indexMutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly storageUri: vscode.Uri) {}

  // ── Public API ──────────────────────────────────────────────────────────────

  async startSession(roundType: RoundType): Promise<string> {
    const id = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    const workspaceId = this.getWorkspaceHash();

    const session: PersistedSession = {
      id,
      workspaceId,
      roundType,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      turns: [],
    };

    await this.ensureDir(this.sessionsDir());
    await this.writeSession(session);

    const entry: SessionIndexEntry = {
      id,
      workspaceId,
      roundType,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      turnCount: 0,
      preview: '',
    };
    await this.appendToIndex(entry);
    await this.pruneOldSessions(MAX_SESSIONS);

    return id;
  }

  async appendTurn(sessionId: string, turn: ConversationTurn): Promise<void> {
    const previous = this.appendQueues.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => {
        // Keep queue alive even if an earlier append failed.
      })
      .then(async () => {
        try {
          const session = await this.loadSession(sessionId);
          if (!session) {
            return;
          }
          session.turns.push(turn);
          session.updatedAt = Date.now();
          await this.writeSession(session);
          await this.updateIndexEntry(sessionId, {
            updatedAt: session.updatedAt,
            turnCount: session.turns.length,
            preview: this.extractPreview(session.turns),
          });
        } catch {
          // Non-fatal — session saving must never break the chat
        }
      });

    this.appendQueues.set(sessionId, next);
    await next;
    if (this.appendQueues.get(sessionId) === next) {
      this.appendQueues.delete(sessionId);
    }
  }

  async updateSessionRoundType(sessionId: string, roundType: RoundType): Promise<void> {
    try {
      const session = await this.loadSession(sessionId);
      if (!session) {
        return;
      }
      if (session.roundType === roundType) {
        return;
      }
      session.roundType = roundType;
      session.updatedAt = Date.now();
      await this.writeSession(session);
      await this.updateIndexEntry(sessionId, {
        roundType,
        updatedAt: session.updatedAt,
      });
    } catch {
      // Non-fatal — session updates must never break the chat
    }
  }

  async listSessions(): Promise<SessionIndexEntry[]> {
    try {
      // Read after prior index write jobs have settled.
      await this.indexMutationQueue;
      const index = await this.readIndex();
      return index.sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
      return [];
    }
  }

  async loadSession(sessionId: string): Promise<PersistedSession | undefined> {
    try {
      const uri = this.sessionFileUri(sessionId);
      const bytes = await vscode.workspace.fs.readFile(uri);
      const raw: unknown = JSON.parse(Buffer.from(bytes).toString('utf-8'));
      return this.parsePersistedSession(raw);
    } catch {
      return undefined;
    }
  }

  async pruneOldSessions(maxCount: number): Promise<void> {
    await this.withIndexMutation(async () => {
      try {
        const index = await this.readIndex();
        if (index.length <= maxCount) {
          return;
        }
        const sorted = index.sort((a, b) => b.updatedAt - a.updatedAt);
        const toKeep = sorted.slice(0, maxCount);
        const toDelete = sorted.slice(maxCount);

        await Promise.all(
          toDelete.map(async (entry) => {
            try {
              await vscode.workspace.fs.delete(this.sessionFileUri(entry.id));
            } catch {
              // File may already be gone — continue
            }
          }),
        );

        await this.writeIndex(toKeep);
      } catch {
        // Non-fatal
      }
    });
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private getWorkspaceHash(): string {
    if (this.workspaceHash) {
      return this.workspaceHash;
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'no-workspace';
    this.workspaceHash = crypto.createHash('sha1').update(root).digest('hex').slice(0, 12);
    return this.workspaceHash;
  }

  private sessionsDir(): vscode.Uri {
    return vscode.Uri.joinPath(this.storageUri, 'sessions', this.getWorkspaceHash());
  }

  private sessionFileUri(sessionId: string): vscode.Uri {
    return vscode.Uri.joinPath(this.sessionsDir(), `${sessionId}.json`);
  }

  private indexUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.sessionsDir(), 'index.json');
  }

  private async ensureDir(uri: vscode.Uri): Promise<void> {
    await vscode.workspace.fs.createDirectory(uri);
  }

  private async writeSession(session: PersistedSession): Promise<void> {
    const uri = this.sessionFileUri(session.id);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(session, null, 2)));
  }

  private async readIndex(): Promise<SessionIndexEntry[]> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.indexUri());
      const raw: unknown = JSON.parse(Buffer.from(bytes).toString('utf-8'));
      return this.parseSessionIndex(raw);
    } catch {
      return [];
    }
  }

  private async writeIndex(entries: SessionIndexEntry[]): Promise<void> {
    await vscode.workspace.fs.writeFile(
      this.indexUri(),
      Buffer.from(JSON.stringify(entries, null, 2)),
    );
  }

  private async appendToIndex(entry: SessionIndexEntry): Promise<void> {
    await this.withIndexMutation(async () => {
      const index = await this.readIndex();
      index.push(entry);
      await this.writeIndex(index);
    });
  }

  private async updateIndexEntry(
    sessionId: string,
    updates: Partial<SessionIndexEntry>,
  ): Promise<void> {
    await this.withIndexMutation(async () => {
      const index = await this.readIndex();
      const i = index.findIndex((e) => e.id === sessionId);
      if (i !== -1) {
        index[i] = { ...index[i], ...updates };
        await this.writeIndex(index);
      }
    });
  }

  private extractPreview(turns: ConversationTurn[]): string {
    const firstUser = turns.find((t) => t.role === 'user');
    return firstUser ? firstUser.content.slice(0, PREVIEW_LENGTH) : '';
  }

  private withIndexMutation<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.indexMutationQueue
      .catch((): void => undefined)
      .then(operation);
    this.indexMutationQueue = next.then(
      (): void => undefined,
      (): void => undefined,
    );
    return next;
  }

  private parsePersistedSession(raw: unknown): PersistedSession | undefined {
    if (!this.isRecord(raw)) {
      return undefined;
    }
    const id = this.readString(raw['id']);
    const workspaceId = this.readString(raw['workspaceId']);
    const roundTypeRaw = this.readString(raw['roundType']);
    const createdAt = this.readNumber(raw['createdAt']);
    const updatedAt = this.readNumber(raw['updatedAt']);
    const turnsRaw = raw['turns'];
    if (
      !id
      || !workspaceId
      || !roundTypeRaw
      || !VALID_ROUND_TYPES.has(roundTypeRaw)
      || createdAt === undefined
      || updatedAt === undefined
      || !Array.isArray(turnsRaw)
    ) {
      return undefined;
    }

    const turns: ConversationTurn[] = [];
    for (const turnRaw of turnsRaw) {
      if (!this.isRecord(turnRaw)) {
        return undefined;
      }
      const role = turnRaw['role'];
      const content = this.readString(turnRaw['content']);
      if (
        (role !== 'user' && role !== 'assistant')
        || !VALID_TURN_ROLES.has(role)
        || content === undefined
      ) {
        return undefined;
      }
      turns.push({ role, content });
    }

    return {
      id,
      workspaceId,
      roundType: roundTypeRaw as RoundType,
      createdAt,
      updatedAt,
      turns,
    };
  }

  private parseSessionIndex(raw: unknown): SessionIndexEntry[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    const entries: SessionIndexEntry[] = [];
    for (const entryRaw of raw) {
      const parsed = this.parseSessionIndexEntry(entryRaw);
      if (parsed) {
        entries.push(parsed);
      }
    }
    return entries;
  }

  private parseSessionIndexEntry(raw: unknown): SessionIndexEntry | undefined {
    if (!this.isRecord(raw)) {
      return undefined;
    }
    const id = this.readString(raw['id']);
    const workspaceId = this.readString(raw['workspaceId']);
    const roundTypeRaw = this.readString(raw['roundType']);
    const createdAt = this.readNumber(raw['createdAt']);
    const updatedAt = this.readNumber(raw['updatedAt']);
    const turnCount = this.readNumber(raw['turnCount']);
    const preview = this.readString(raw['preview']);
    if (
      !id
      || !workspaceId
      || !roundTypeRaw
      || !VALID_ROUND_TYPES.has(roundTypeRaw)
      || createdAt === undefined
      || updatedAt === undefined
      || turnCount === undefined
      || preview === undefined
    ) {
      return undefined;
    }
    return {
      id,
      workspaceId,
      roundType: roundTypeRaw as RoundType,
      createdAt,
      updatedAt,
      turnCount,
      preview,
    };
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  private readString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
  }

  private readNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }
}
