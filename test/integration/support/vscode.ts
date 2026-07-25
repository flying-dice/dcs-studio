import { vi } from "vitest";

// The shared `vscode` test double for the integration layer.
//
// The extension host is not available outside a running VS Code, and the
// official @vscode/test-electron harness cannot see webview DOM, so the layer
// substitutes this module instead. It is deliberately a real (if small)
// implementation rather than a bag of vi.fn()s: configuration reads resolve
// against a settings map, EventEmitter really dispatches, and webview panels
// record posted messages and expose their message handler — because most of
// what this layer tests is exactly that request/response choreography.
//
// Use it from a spec with:
//
//   vi.mock("vscode", () => vscodeMock());
//
// then `resetVscode({ config: { "dcsStudio.dataDir": "D:\\data" } })` per test.

/** Everything the double records, for assertions and for reset between tests. */
export interface VscodeState {
  config: Record<string, unknown>;
  configUpdates: { section: string; key: string; value: unknown; target: number }[];
  info: string[];
  warnings: string[];
  errors: string[];
  /** Queued replies for showInformationMessage/showWarningMessage, in order. */
  messageReplies: (string | undefined)[];
  /** Queued replies for showOpenDialog, in order — each an array of fsPaths. */
  openDialogReplies: (string[] | undefined)[];
  /** Queued replies for showQuickPick / showInputBox, in order. */
  quickPickReplies: unknown[];
  inputBoxReplies: (string | undefined)[];
  executedCommands: { command: string; args: unknown[] }[];
  registeredCommands: Map<string, (...args: unknown[]) => unknown>;
  openedExternal: string[];
  clipboard: string;
  workspaceFolders:
    | { uri: { fsPath: string; scheme: string }; name: string; index: number }[]
    | undefined;
  panels: FakeWebviewPanel[];
  statusBarItems: FakeStatusBarItem[];
  createdTerminals: { name: string; sent: string[] }[];
  /** Documents opened via workspace.openTextDocument. */
  openedDocuments: string[];
  /** Documents revealed in an editor via window.showTextDocument. */
  shownDocuments: string[];
  /** Installed extensions by id, as `extensions.getExtension` sees them. */
  extensions: Record<string, { packageJSON: Record<string, unknown> }>;
  /** Transient status-bar messages set via window.setStatusBarMessage. */
  statusBarMessages: string[];
  /** Workspace edits applied via workspace.applyEdit, in order. */
  appliedEdits: { uri: string; text: string }[];
  /** Paths workspace.fs.stat resolves for; anything else rejects. */
  existingPaths: Set<string>;
  /** File-system watchers created via workspace.createFileSystemWatcher. */
  watchers: FakeFileSystemWatcher[];
}

export const state: VscodeState = blankState();

function blankState(): VscodeState {
  return {
    config: {},
    configUpdates: [],
    info: [],
    warnings: [],
    errors: [],
    messageReplies: [],
    openDialogReplies: [],
    quickPickReplies: [],
    inputBoxReplies: [],
    executedCommands: [],
    registeredCommands: new Map(),
    openedExternal: [],
    clipboard: "",
    workspaceFolders: undefined,
    panels: [],
    statusBarItems: [],
    createdTerminals: [],
    openedDocuments: [],
    shownDocuments: [],
    extensions: {},
    statusBarMessages: [],
    appliedEdits: [],
    existingPaths: new Set(),
    watchers: [],
  };
}

/** Reset all recorded state; optionally seed settings and workspace folders. */
export function resetVscode(
  seed: {
    config?: Record<string, unknown>;
    workspaceFolders?: string[];
    extensions?: Record<string, { packageJSON: Record<string, unknown> }>;
    existingPaths?: string[];
  } = {},
): void {
  Object.assign(state, blankState());
  // Module-level signals outlive a single spec's objects, so their listeners
  // have to be dropped here too — otherwise every previously-resolved view
  // still reacts and one fire() looks like N.
  workspaceFoldersEmitter.dispose();
  authChangeEmitter.dispose();
  changeDocEmitter.dispose();
  closeDocEmitter.dispose();
  changeConfigEmitter.dispose();
  if (seed.config) state.config = { ...seed.config };
  if (seed.extensions) state.extensions = { ...seed.extensions };
  if (seed.existingPaths) state.existingPaths = new Set(seed.existingPaths);
  if (seed.workspaceFolders) {
    state.workspaceFolders = seed.workspaceFolders.map((fsPath, index) => ({
      // `scheme` matters: callers reject non-file workspaces (remote, virtual)
      // because they cannot be scaffolded into or linked from.
      uri: { fsPath, scheme: "file" },
      name: fsPath,
      index,
    }));
  }
}

class FakeDisposable {
  constructor(private readonly fn: () => void) {}
  dispose(): void {
    this.fn();
  }
}

class FakeEventEmitter<T> {
  private readonly listeners: ((e: T) => void)[] = [];
  // The real signature is (listener, thisArg?, disposables?) and it PUSHES the
  // subscription into `disposables`. Honouring that matters: panels rely on it
  // to collect their subscriptions, and a double that drops the array leaves
  // every teardown loop unreachable — the exact code that stops listener leaks.
  readonly event = (
    listener: (e: T) => void,
    _thisArg?: unknown,
    disposables?: { push(d: FakeDisposable): void },
  ): FakeDisposable => {
    this.listeners.push(listener);
    const sub = new FakeDisposable(() => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    });
    disposables?.push(sub);
    return sub;
  };
  fire(e: T): void {
    for (const listener of [...this.listeners]) listener(e);
  }
  dispose(): void {
    this.listeners.length = 0;
  }
}

/** A webview that records what the panel posts and replays what tests send. */
export class FakeWebview {
  html = "";
  options: unknown = {};
  readonly cspSource = "vscode-webview://test";
  /** Every message the panel has posted to the webview, in order. */
  posted: unknown[] = [];
  private handler: ((msg: unknown) => unknown) | undefined;

  postMessage(msg: unknown): Promise<boolean> {
    this.posted.push(msg);
    return Promise.resolve(true);
  }

  onDidReceiveMessage(
    handler: (msg: unknown) => unknown,
    _thisArg?: unknown,
    disposables?: { push(d: FakeDisposable): void },
  ): FakeDisposable {
    this.handler = handler;
    const sub = new FakeDisposable(() => {
      this.handler = undefined;
    });
    disposables?.push(sub);
    return sub;
  }

  asWebviewUri(uri: { fsPath: string; toString(): string }): { toString(): string } {
    return { toString: () => `vscode-webview://test${uri.fsPath.replace(/\\/g, "/")}` };
  }

  /** Drive the panel as the webview would: deliver one message and settle it. */
  async receive(msg: unknown): Promise<void> {
    await this.handler?.(msg);
  }

  /** Messages of one type, for assertions that ignore surrounding chatter. */
  postedOfType(type: string): Record<string, unknown>[] {
    return this.posted.filter(
      (m): m is Record<string, unknown> =>
        typeof m === "object" && m !== null && (m as { type?: string }).type === type,
    );
  }
}

export class FakeWebviewPanel {
  readonly webview = new FakeWebview();
  visible = true;
  disposed = false;
  iconPath: unknown;
  private readonly disposeEmitter = new FakeEventEmitter<void>();
  private readonly viewStateEmitter = new FakeEventEmitter<unknown>();
  readonly onDidDispose = this.disposeEmitter.event;
  readonly onDidChangeViewState = this.viewStateEmitter.event;

  constructor(
    readonly viewType: string,
    public title: string,
    readonly showOptions: unknown,
  ) {}

  reveal(): void {
    this.visible = true;
  }

  dispose(): void {
    // Idempotent, like the real API: panels commonly respond to onDidDispose by
    // calling dispose() on themselves, which would otherwise recurse forever.
    if (this.disposed) return;
    this.disposed = true;
    this.disposeEmitter.fire();
  }
}

export class FakeStatusBarItem {
  text = "";
  tooltip: string | undefined;
  command: string | undefined;
  backgroundColor: unknown;
  shown = false;
  disposed = false;
  constructor(
    readonly alignment: number,
    readonly priority: number | undefined,
  ) {}
  show(): void {
    this.shown = true;
  }
  hide(): void {
    this.shown = false;
  }
  dispose(): void {
    this.disposed = true;
  }
}

/** A watcher a test can fire, standing in for a real file-system watcher. */
export class FakeFileSystemWatcher {
  private readonly createEmitter = new FakeEventEmitter<unknown>();
  private readonly deleteEmitter = new FakeEventEmitter<unknown>();
  private readonly changeEmitter = new FakeEventEmitter<unknown>();
  readonly onDidCreate = this.createEmitter.event;
  readonly onDidDelete = this.deleteEmitter.event;
  readonly onDidChange = this.changeEmitter.event;
  disposed = false;

  constructor(readonly pattern: unknown) {}

  fireCreate(): void {
    this.createEmitter.fire(undefined);
  }
  fireDelete(): void {
    this.deleteEmitter.fire(undefined);
  }
  dispose(): void {
    this.disposed = true;
  }
}

/** A sidebar view host, as `WebviewViewProvider.resolveWebviewView` receives. */
export class FakeWebviewView {
  readonly webview = new FakeWebview();
  visible = true;
  private readonly disposeEmitter = new FakeEventEmitter<void>();
  readonly onDidDispose = this.disposeEmitter.event;
  disposed = false;

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeEmitter.fire();
  }
}

const workspaceFoldersEmitter = new FakeEventEmitter<unknown>();
const changeDocEmitter = new FakeEventEmitter<{ document: { uri: { toString(): string } } }>();
const closeDocEmitter = new FakeEventEmitter<{ uri: { toString(): string } }>();
const changeConfigEmitter = new FakeEventEmitter<{ affectsConfiguration(s: string): boolean }>();

/** Fire `workspace.onDidChangeTextDocument` for one document. */
export function fireDocumentChanged(document: unknown): void {
  changeDocEmitter.fire(document as { document: { uri: { toString(): string } } });
}

/** Fire `workspace.onDidCloseTextDocument` for one document. */
export function fireDocumentClosed(document: unknown): void {
  closeDocEmitter.fire(document as { uri: { toString(): string } });
}

/** Fire `workspace.onDidChangeConfiguration` for a settings section. */
export function fireConfigurationChanged(section: string): void {
  changeConfigEmitter.fire({ affectsConfiguration: (s: string) => section.startsWith(s) });
}

/** Fire `workspace.onDidChangeWorkspaceFolders`. */
export function fireWorkspaceFoldersChanged(): void {
  workspaceFoldersEmitter.fire(undefined);
}

/**
 * Session-change signal, exposed so a test can play "the user signed in to
 * GitHub in another part of VS Code" — panels subscribe to this to re-run
 * their auth state, and there is no other way to reach that listener.
 */
const authChangeEmitter = new FakeEventEmitter<{ provider: { id: string } }>();

/** Fire `authentication.onDidChangeSessions` for one provider. */
export function fireAuthSessionsChanged(providerId = "github"): void {
  authChangeEmitter.fire({ provider: { id: providerId } });
}

class FakeUri {
  private constructor(
    readonly fsPath: string,
    readonly scheme: string,
  ) {}
  static file(fsPath: string): FakeUri {
    return new FakeUri(fsPath, "file");
  }
  static parse(value: string): FakeUri {
    const scheme = value.includes(":") ? value.slice(0, value.indexOf(":")) : "file";
    return new FakeUri(value, scheme);
  }
  static joinPath(base: FakeUri, ...parts: string[]): FakeUri {
    const sep = base.fsPath.includes("\\") ? "\\" : "/";
    return new FakeUri([base.fsPath.replace(/[\\/]+$/, ""), ...parts].join(sep), base.scheme);
  }
  with(): FakeUri {
    return this;
  }
  toString(): string {
    return this.scheme === "file" ? this.fsPath : `${this.fsPath}`;
  }
}

/**
 * The module factory. Pass straight to `vi.mock("vscode", () => vscodeMock())`.
 *
 * Only the surface the extension actually touches is implemented; anything
 * missing should be added here rather than stubbed per-spec, so every spec sees
 * the same VS Code.
 */
export function vscodeMock() {
  return {
    // ── workspace ──
    workspace: {
      getConfiguration: (section: string) => ({
        get: <T>(key: string, fallback?: T): T | undefined => {
          const value = state.config[`${section}.${key}`];
          return (value === undefined ? fallback : value) as T | undefined;
        },
        update: (key: string, value: unknown, target: number) => {
          state.config[`${section}.${key}`] = value;
          state.configUpdates.push({ section, key, value, target });
          return Promise.resolve();
        },
        has: (key: string) => `${section}.${key}` in state.config,
      }),
      get workspaceFolders() {
        return state.workspaceFolders;
      },
      openTextDocument: (arg: { fsPath?: string } | string) => {
        const fsPath = typeof arg === "string" ? arg : (arg.fsPath ?? "");
        state.openedDocuments.push(fsPath);
        return Promise.resolve({ uri: FakeUri.file(fsPath), getText: () => "" });
      },
      asRelativePath: (target: { fsPath?: string } | string) => {
        const full = typeof target === "string" ? target : (target.fsPath ?? "");
        const folder = state.workspaceFolders?.[0]?.uri.fsPath;
        return folder && full.startsWith(folder)
          ? full.slice(folder.length).replace(/^[\\/]+/, "")
          : full;
      },
      onDidChangeConfiguration: changeConfigEmitter.event,
      onDidChangeTextDocument: changeDocEmitter.event,
      onDidCloseTextDocument: closeDocEmitter.event,
      onDidSaveTextDocument: new FakeEventEmitter<unknown>().event,
      applyEdit: (edit: { replacements: { uri: string; text: string }[] }) => {
        state.appliedEdits.push(...edit.replacements);
        return Promise.resolve(true);
      },
      onDidChangeWorkspaceFolders: workspaceFoldersEmitter.event,
      createFileSystemWatcher: (pattern: unknown) => {
        const watcher = new FakeFileSystemWatcher(pattern);
        state.watchers.push(watcher);
        return watcher;
      },
      fs: {
        // Rejects for unknown paths, like the real API — callers use that
        // rejection as their "file does not exist" answer.
        stat: (uri: { fsPath: string }) =>
          state.existingPaths.has(uri.fsPath)
            ? Promise.resolve({ type: 1 })
            : Promise.reject(new Error(`ENOENT: ${uri.fsPath}`)),
      },
    },

    // ── window ──
    window: {
      showInformationMessage: (message: string, ..._items: unknown[]) => {
        state.info.push(message);
        return Promise.resolve(state.messageReplies.shift());
      },
      showWarningMessage: (message: string, ..._items: unknown[]) => {
        state.warnings.push(message);
        return Promise.resolve(state.messageReplies.shift());
      },
      showErrorMessage: (message: string, ..._items: unknown[]) => {
        state.errors.push(message);
        return Promise.resolve(state.messageReplies.shift());
      },
      showOpenDialog: () => {
        const reply = state.openDialogReplies.shift();
        return Promise.resolve(reply?.map((p) => FakeUri.file(p)));
      },
      showQuickPick: () => Promise.resolve(state.quickPickReplies.shift()),
      showInputBox: () => Promise.resolve(state.inputBoxReplies.shift()),
      // Accepts either a TextDocument or a Uri, like the real overloads.
      showTextDocument: (target: { uri?: { fsPath?: string }; fsPath?: string }) => {
        const fsPath = target?.uri?.fsPath ?? target?.fsPath;
        if (fsPath) state.shownDocuments.push(fsPath);
        return Promise.resolve({ document: target });
      },
      createWebviewPanel: (viewType: string, title: string, showOptions: unknown) => {
        const panel = new FakeWebviewPanel(viewType, title, showOptions);
        state.panels.push(panel);
        return panel;
      },
      registerWebviewViewProvider: (_id: string, _provider: unknown) =>
        new FakeDisposable(() => {}),
      createStatusBarItem: (alignment: number, priority?: number) => {
        const item = new FakeStatusBarItem(alignment, priority);
        state.statusBarItems.push(item);
        return item;
      },
      createOutputChannel: (name: string) => ({
        name,
        appendLine: () => {},
        append: () => {},
        show: () => {},
        dispose: () => {},
      }),
      createTerminal: (name: string) => {
        const terminal = { name, sent: [] as string[] };
        state.createdTerminals.push(terminal);
        return {
          ...terminal,
          sendText: (text: string) => terminal.sent.push(text),
          show: () => {},
          dispose: () => {},
        };
      },
      withProgress: <T>(_options: unknown, task: (progress: unknown) => Promise<T>) =>
        task({ report: () => {} }),
      setStatusBarMessage: (message: string, _timeout?: number) => {
        state.statusBarMessages.push(message);
        return new FakeDisposable(() => {});
      },
      activeTextEditor: undefined as unknown,
      onDidChangeActiveTextEditor: new FakeEventEmitter<unknown>().event,
    },

    // ── commands ──
    commands: {
      registerCommand: (command: string, handler: (...args: unknown[]) => unknown) => {
        state.registeredCommands.set(command, handler);
        return new FakeDisposable(() => state.registeredCommands.delete(command));
      },
      executeCommand: (command: string, ...args: unknown[]) => {
        state.executedCommands.push({ command, args });
        return Promise.resolve(undefined);
      },
    },

    // ── env ──
    env: {
      openExternal: (uri: { toString(): string }) => {
        state.openedExternal.push(uri.toString());
        return Promise.resolve(true);
      },
      clipboard: {
        writeText: (text: string) => {
          state.clipboard = text;
          return Promise.resolve();
        },
        readText: () => Promise.resolve(state.clipboard),
      },
      openExternalSync: undefined,
    },

    // ── auth ──
    authentication: {
      getSession: vi.fn(() => Promise.resolve(undefined)),
      onDidChangeSessions: authChangeEmitter.event,
    },

    // ── debug ──
    debug: {
      registerDebugAdapterDescriptorFactory: () => new FakeDisposable(() => {}),
      registerDebugConfigurationProvider: () => new FakeDisposable(() => {}),
      startDebugging: () => Promise.resolve(true),
      activeDebugSession: undefined,
    },

    // ── extension metadata ──
    extensions: {
      getExtension: (id: string) => state.extensions[id],
    },
    version: "1.125.0",

    // ── values & types ──
    Uri: FakeUri,
    EventEmitter: FakeEventEmitter,
    Disposable: FakeDisposable,
    ViewColumn: { One: 1, Two: 2, Beside: -2, Active: -1 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    ProgressLocation: { Notification: 15, Window: 10, SourceControl: 1 },
    ThemeColor: class {
      constructor(readonly id: string) {}
    },
    ThemeIcon: class {
      constructor(readonly id: string) {}
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    UIKind: { Desktop: 1, Web: 2 },
    ExtensionMode: { Production: 1, Development: 2, Test: 3 },
    WorkspaceEdit: class {
      readonly replacements: { uri: string; text: string }[] = [];
      replace(uri: { toString(): string }, _range: unknown, text: string): void {
        this.replacements.push({ uri: uri.toString(), text });
      }
    },
    Range: class {
      constructor(
        readonly startLine: number,
        readonly startChar: number,
        readonly endLine: number,
        readonly endChar: number,
      ) {}
    },
    RelativePattern: class {
      constructor(
        readonly base: unknown,
        readonly pattern: string,
      ) {}
    },
  };
}
