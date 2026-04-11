/**
 * Mock for the 'vscode' module used in unit tests.
 * Provides minimal stubs for all VS Code APIs used by the extension.
 */

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

export class CancellationError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancellationError';
  }
}

export class CancellationTokenSource {
  private cancellationListeners: Array<() => void> = [];
  readonly token: { isCancellationRequested: boolean; onCancellationRequested: jest.Mock } = {
    isCancellationRequested: false,
    onCancellationRequested: jest.fn((cb: () => void) => {
      this.cancellationListeners.push(cb);
      return {
        dispose: () => {
          this.cancellationListeners = this.cancellationListeners.filter((listener) => listener !== cb);
        },
      };
    }),
  };
  cancel(): void {
    this.token.isCancellationRequested = true;
    for (const listener of this.cancellationListeners) {
      try {
        listener();
      } catch {
        // Ignore listener errors in mock event dispatch.
      }
    }
  }
  dispose(): void {}
}

export class Uri {
  static file(path: string): Uri {
    return new Uri('file', '', path, '', '');
  }
  static parse(value: string): Uri {
    return new Uri('untitled', '', value, '', '');
  }
  static joinPath(base: Uri, ...pathSegments: string[]): Uri {
    const joined = [base.fsPath, ...pathSegments].join('/').replace(/\/+/g, '/');
    return Uri.file(joined);
  }

  constructor(
    public readonly scheme: string,
    public readonly authority: string,
    public readonly path: string,
    public readonly query: string,
    public readonly fragment: string,
  ) {}

  get fsPath(): string {
    return this.path;
  }

  toString(): string {
    return `${this.scheme}:${this.path}`;
  }
}

export class Position {
  constructor(
    public readonly line: number,
    public readonly character: number,
  ) {}
}

export class Range {
  constructor(
    public readonly start: Position,
    public readonly end: Position,
  ) {}
}

export class WorkspaceEdit {
  private _edits: Array<{ type: string; uri: Uri; content?: unknown }> = [];

  replace(uri: Uri, _range: Range, _newText: string): void {
    this._edits.push({ type: 'replace', uri });
  }

  createFile(uri: Uri, _options?: unknown): void {
    this._edits.push({ type: 'create', uri });
  }

  get size(): number {
    return this._edits.length;
  }
}

export class LanguageModelTextPart {
  constructor(public readonly value: string) {}
}

export class LanguageModelToolCallPart {
  constructor(
    public readonly callId: string,
    public readonly name: string,
    public readonly input: unknown,
  ) {}
}

export class LanguageModelToolResultPart {
  constructor(
    public readonly callId: string,
    public readonly content: unknown[],
  ) {}
}

export class LanguageModelChatMessage {
  static User(content: string | unknown[]): LanguageModelChatMessage {
    return new LanguageModelChatMessage('user', content);
  }
  static Assistant(content: string | unknown[]): LanguageModelChatMessage {
    return new LanguageModelChatMessage('assistant', content);
  }
  constructor(
    public readonly role: string,
    public readonly content: string | unknown[],
  ) {}
}

export class RelativePattern {
  constructor(
    public readonly base: unknown,
    public readonly pattern: string,
  ) {}
}

// ── workspace namespace ──────────────────────────────────────────────────────

const mockWatcher = {
  onDidChange: jest.fn(),
  onDidCreate: jest.fn(),
  onDidDelete: jest.fn(),
  dispose: jest.fn(),
};

export const workspace = {
  workspaceFolders: undefined as
    | Array<{ uri: Uri; name: string; index: number }>
    | undefined,
  textDocuments: [] as Array<{ uri: Uri; isUntitled: boolean; isDirty?: boolean; getText?: () => string }>,
  getConfiguration: jest.fn().mockReturnValue({
    get: jest.fn(),
    update: jest.fn().mockResolvedValue(undefined),
  }),
  fs: {
    stat: jest.fn().mockResolvedValue({ size: 100, type: FileType.File }),
    readFile: jest.fn().mockResolvedValue(Buffer.from('')),
    readDirectory: jest.fn().mockResolvedValue([]),
    writeFile: jest.fn().mockResolvedValue(undefined),
    createDirectory: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
  },
  applyEdit: jest.fn().mockResolvedValue(true),
  onDidChangeWorkspaceFolders: jest.fn(),
  createFileSystemWatcher: jest.fn().mockReturnValue(mockWatcher),
  registerTextDocumentContentProvider: jest.fn().mockReturnValue({ dispose: jest.fn() }),
  openTextDocument: jest.fn().mockResolvedValue({ uri: Uri.parse('untitled:ab-report.md') }),
};

// ── window namespace ─────────────────────────────────────────────────────────

export const window = {
  activeTextEditor: undefined as { document: { uri: Uri; isUntitled: boolean } } | undefined,
  visibleTextEditors: [] as Array<{ document: { uri: Uri; isUntitled: boolean } }>,
  createWebviewPanel: jest.fn().mockReturnValue({
    webview: {
      html: '',
      postMessage: jest.fn().mockResolvedValue(true),
      onDidReceiveMessage: jest.fn(),
    },
    onDidDispose: jest.fn(),
    reveal: jest.fn(),
    dispose: jest.fn(),
  }),
  showInformationMessage: jest.fn().mockResolvedValue(undefined),
  showWarningMessage: jest.fn().mockResolvedValue(undefined),
  showErrorMessage: jest.fn().mockResolvedValue(undefined),
  showInputBox: jest.fn().mockResolvedValue(undefined),
  showQuickPick: jest.fn().mockResolvedValue(undefined),
  createTerminal: jest.fn().mockReturnValue({
    show: jest.fn(),
    sendText: jest.fn(),
    dispose: jest.fn(),
  }),
  showTextDocument: jest.fn().mockResolvedValue(undefined),
};

// ── lm namespace ─────────────────────────────────────────────────────────────

export const lm = {
  selectChatModels: jest.fn().mockResolvedValue([]),
};

// ── commands namespace ────────────────────────────────────────────────────────

export const commands = {
  registerCommand: jest.fn().mockReturnValue({ dispose: jest.fn() }),
  executeCommand: jest.fn().mockResolvedValue(undefined),
};
