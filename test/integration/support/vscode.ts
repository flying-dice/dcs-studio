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
  workspaceFolders: { uri: { fsPath: string }; name: string; index: number }[] | undefined;
  panels: FakeWebviewPanel[];
  statusBarItems: FakeStatusBarItem[];
  createdTerminals: { name: string; sent: string[] }[];
  /** Documents opened via workspace.openTextDocument / window.showTextDocument. */
  openedDocuments: string[];
  /** Installed extensions by id, as `extensions.getExtension` sees them. */
  extensions: Record<string, { packageJSON: Record<string, unknown> }>;
  /** Transient status-bar messages set via window.setStatusBarMessage. */
  statusBarMessages: string[];
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
    extensions: {},
    statusBarMessages: [],
  };
}

/** Reset all recorded state; optionally seed settings and workspace folders. */
export function resetVscode(
  seed: {
    config?: Record<string, unknown>;
    workspaceFolders?: string[];
    extensions?: Record<string, { packageJSON: Record<string, unknown> }>;
  } = {},
): void {
  Object.assign(state, blankState());
  if (seed.config) state.config = { ...seed.config };
  if (seed.extensions) state.extensions = { ...seed.extensions };
  if (seed.workspaceFolders) {
    state.workspaceFolders = seed.workspaceFolders.map((fsPath, index) => ({
      uri: { fsPath },
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
  readonly event = (listener: (e: T) => void): FakeDisposable => {
    this.listeners.push(listener);
    return new FakeDisposable(() => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    });
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
  readonly posted: unknown[] = [];
  private handler: ((msg: unknown) => unknown) | undefined;

  postMessage(msg: unknown): Promise<boolean> {
    this.posted.push(msg);
    return Promise.resolve(true);
  }

  onDidReceiveMessage(handler: (msg: unknown) => unknown): FakeDisposable {
    this.handler = handler;
    return new FakeDisposable(() => {
      this.handler = undefined;
    });
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
      onDidChangeConfiguration: new FakeEventEmitter<unknown>().event,
      onDidSaveTextDocument: new FakeEventEmitter<unknown>().event,
      fs: {
        stat: () => Promise.resolve({ type: 1 }),
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
      showTextDocument: (doc: { uri?: { fsPath?: string } }) => {
        if (doc?.uri?.fsPath) state.openedDocuments.push(doc.uri.fsPath);
        return Promise.resolve({ document: doc });
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
      onDidChangeSessions: new FakeEventEmitter<unknown>().event,
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
  };
}
