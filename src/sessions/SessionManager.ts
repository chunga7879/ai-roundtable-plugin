import * as crypto from 'crypto';
import * as vscode from 'vscode';
import type { ConversationTurn, PersistedSession, RoundType, SessionIndexEntry } from '../types';

const MAX_SESSIONS = 20;
const PREVIEW_LENGTH = 80;

export class SessionManager {
  private workspaceHash: string | undefined;

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
  }

  async listSessions(): Promise<SessionIndexEntry[]> {
    try {
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
      return JSON.parse(Buffer.from(bytes).toString('utf-8')) as PersistedSession;
    } catch {
      return undefined;
    }
  }

  async pruneOldSessions(maxCount: number): Promise<void> {
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
      return JSON.parse(Buffer.from(bytes).toString('utf-8')) as SessionIndexEntry[];
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
    const index = await this.readIndex();
    index.push(entry);
    await this.writeIndex(index);
  }

  private async updateIndexEntry(
    sessionId: string,
    updates: Partial<SessionIndexEntry>,
  ): Promise<void> {
    const index = await this.readIndex();
    const i = index.findIndex((e) => e.id === sessionId);
    if (i !== -1) {
      index[i] = { ...index[i], ...updates };
      await this.writeIndex(index);
    }
  }

  private extractPreview(turns: ConversationTurn[]): string {
    const firstUser = turns.find((t) => t.role === 'user');
    return firstUser ? firstUser.content.slice(0, PREVIEW_LENGTH) : '';
  }
}
