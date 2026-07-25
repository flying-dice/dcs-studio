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
  /** Queued replies for showSaveDialog, in order — an fsPath, or undefined for
   * a cancelled save. */
  saveDialogReplies: (string | undefined)[];
  /** Every showSaveDialog call's options, in order — the default file name a
   * panel proposes is part of its contract. */
  saveDialogOptions: unknown[];
  /** Queued replies for showQuickPick / showInputBox, in order. */
  quickPickReplies: unknown[];
  inputBoxReplies: (string | undefined)[];
  executedCommands: { command: string; args: unknown[] }[];
  registeredCommands: Map<string, (...args: unknown[]) => unknown>;
  openedExternal: string[];
  workspaceFolders:
    | { uri: { fsPath: string; scheme: string }; name: string; index: number }[]
    | undefined;
  panels: FakeWebviewPanel[];
  statusBarItems: FakeStatusBarItem[];
  createdTerminals: { name: string; sent: string[] }[];
  /** Output channels created via window.createOutputChannel, with what was
   * written to them — the only record of an external command's output. */
  outputChannels: { name: string; lines: string[]; shown: boolean; disposed: boolean }[];
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
  /** In-memory file contents backing workspace.fs, keyed by fsPath. */
  files: Map<string, Uint8Array>;
  /** Directories workspace.fs knows about; ones implied by `files` count too. */
  directories: Set<string>;
  /** Every workspace.fs mutation, in order — the write/copy/delete audit trail. */
  fsOps: FsOp[];
  /** Documents workspace.textDocuments reports as open. */
  textDocuments: FakeTextDocument[];
  /** Editors window.visibleTextEditors reports. */
  visibleTextEditors: { document: FakeTextDocument; viewColumn?: number }[];
  /** Sessions started via debug.startDebugging, in order. */
  startedDebugSessions: { folder: unknown; config: Record<string, unknown>; options: unknown }[];
  /** The handler registered via window.registerUriHandler — how a vscode://
   * deep link (the My Mods desktop shortcut) reaches the extension. */
  uriHandler: { handleUri(uri: { path: string }): void } | undefined;
}

/** One mutating workspace.fs call, as tests assert on it. */
export interface FsOp {
  op: "createDirectory" | "writeFile" | "copy" | "delete";
  uri: string;
  /** Destination for `copy`. */
  to?: string;
  /** Options as passed, e.g. `{ recursive, useTrash }` for delete. */
  options?: unknown;
}

/** An open document, as `workspace.textDocuments` and editors expose it. */
export interface FakeTextDocument {
  uri: { fsPath: string; scheme?: string; toString?(): string };
  isDirty: boolean;
  fileName?: string;
  getText?(): string;
  /** Present when a caller may save the buffer before acting on the file. */
  save?(): Thenable<boolean>;
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
    saveDialogReplies: [],
    saveDialogOptions: [],
    quickPickReplies: [],
    inputBoxReplies: [],
    executedCommands: [],
    registeredCommands: new Map(),
    openedExternal: [],
    workspaceFolders: undefined,
    panels: [],
    statusBarItems: [],
    createdTerminals: [],
    outputChannels: [],
    openedDocuments: [],
    shownDocuments: [],
    extensions: {},
    statusBarMessages: [],
    appliedEdits: [],
    existingPaths: new Set(),
    watchers: [],
    files: new Map(),
    directories: new Set(),
    fsOps: [],
    textDocuments: [],
    visibleTextEditors: [],
    startedDebugSessions: [],
    uriHandler: undefined,
  };
}

/** Mirrors the exported `FileType` enum, for the workspace.fs implementation. */
const FILE = 1;
const DIRECTORY = 2;

/**
 * Collapse `.`/`..` and duplicate separators so the same file is one key
 * whichever way a caller spelled it — `Uri.joinPath(x, "..")` is how the
 * scaffolder asks for a parent directory, and it appends the segment literally.
 */
function normalizeFsPath(p: string): string {
  const sep = p.includes("\\") ? "\\" : "/";
  const out: string[] = [];
  for (const part of p.split(/[\\/]/)) {
    if (part === ".") continue;
    if (part === ".." && out.length > 1) {
      out.pop();
      continue;
    }
    if (part === "" && out.length) continue;
    out.push(part);
  }
  return out.join(sep);
}

/** The path of `full` relative to directory `dir`, or undefined if not under it. */
function under(dir: string, full: string): string | undefined {
  if (full.length <= dir.length || !full.startsWith(dir)) return undefined;
  const rest = full.slice(dir.length);
  return /^[\\/]/.test(rest) ? rest.replace(/^[\\/]/, "") : undefined;
}

function directoryExists(dir: string): boolean {
  if (state.directories.has(dir)) return true;
  for (const f of state.files.keys()) if (under(dir, f)) return true;
  return false;
}

/** Seed a file (and the directories leading to it) into the workspace.fs double. */
export function seedFile(fsPath: string, contents: string | Uint8Array): void {
  const key = normalizeFsPath(fsPath);
  state.files.set(
    key,
    typeof contents === "string" ? new TextEncoder().encode(contents) : contents,
  );
  const sep = key.includes("\\") ? "\\" : "/";
  const parts = key.split(sep);
  for (let i = 1; i < parts.length; i++) state.directories.add(parts.slice(0, i).join(sep));
}

/** Read a file back out of the workspace.fs double as text. */
export function seededText(fsPath: string): string | undefined {
  const bytes = state.files.get(normalizeFsPath(fsPath));
  return bytes && new TextDecoder().decode(bytes);
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
  openDocEmitter.dispose();
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
  fireChange(): void {
    this.changeEmitter.fire(undefined);
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
const openDocEmitter = new FakeEventEmitter<unknown>();
const changeDocEmitter = new FakeEventEmitter<{ document: { uri: { toString(): string } } }>();
const closeDocEmitter = new FakeEventEmitter<{ uri: { toString(): string } }>();
const changeConfigEmitter = new FakeEventEmitter<{ affectsConfiguration(s: string): boolean }>();

/** Fire `workspace.onDidOpenTextDocument` for one document. */
export function fireDocumentOpened(document: unknown): void {
  openDocEmitter.fire(document);
}

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
  // Real Uri.joinPath runs the segments through posix join, so a part that
  // itself contains separators (".claude/skills") or navigates ("..") comes
  // back as one normalised path — callers compare the results as strings.
  static joinPath(base: FakeUri, ...parts: string[]): FakeUri {
    const sep = base.fsPath.includes("\\") ? "\\" : "/";
    const joined = [base.fsPath.replace(/[\\/]+$/, ""), ...parts].join(sep);
    return new FakeUri(normalizeFsPath(joined), base.scheme);
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
 * the same VS Code. Surface the extension stops touching comes straight back
 * out: the coverage gate spans `src/**`, so nothing else will ever notice that
 * a member of this double has become a lie nobody exercises.
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
      onDidOpenTextDocument: openDocEmitter.event,
      onDidChangeTextDocument: changeDocEmitter.event,
      onDidCloseTextDocument: closeDocEmitter.event,
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
      get textDocuments() {
        return state.textDocuments;
      },
      /** The seeded folder containing `uri`, or undefined — as the real API,
       * which answers undefined for a file outside every workspace folder. */
      getWorkspaceFolder: (uri: { fsPath: string }) =>
        state.workspaceFolders?.find((f) => uri.fsPath.startsWith(f.uri.fsPath)),
      // Backed by state.files / state.directories (seed them with seedFile), so
      // a spec can scaffold into it and read back what was written. Every
      // operation rejects for a path that isn't there, like the real API —
      // callers use that rejection as their "does not exist" answer.
      fs: {
        stat: (uri: { fsPath: string }) => {
          const p = normalizeFsPath(uri.fsPath);
          if (state.existingPaths.has(uri.fsPath)) return Promise.resolve({ type: FILE });
          const bytes = state.files.get(p);
          if (bytes) return Promise.resolve({ type: FILE, size: bytes.length });
          if (directoryExists(p)) return Promise.resolve({ type: DIRECTORY });
          return Promise.reject(new Error(`ENOENT: ${uri.fsPath}`));
        },
        readFile: (uri: { fsPath: string }) => {
          const bytes = state.files.get(normalizeFsPath(uri.fsPath));
          return bytes
            ? Promise.resolve(bytes)
            : Promise.reject(new Error(`ENOENT: ${uri.fsPath}`));
        },
        writeFile: (uri: { fsPath: string }, bytes: Uint8Array) => {
          const p = normalizeFsPath(uri.fsPath);
          state.files.set(p, bytes);
          state.fsOps.push({ op: "writeFile", uri: p });
          return Promise.resolve();
        },
        createDirectory: (uri: { fsPath: string }) => {
          const p = normalizeFsPath(uri.fsPath);
          state.directories.add(p);
          state.fsOps.push({ op: "createDirectory", uri: p });
          return Promise.resolve();
        },
        readDirectory: (uri: { fsPath: string }) => {
          const dir = normalizeFsPath(uri.fsPath);
          if (!directoryExists(dir)) return Promise.reject(new Error(`ENOENT: ${uri.fsPath}`));
          const entries = new Map<string, number>();
          const add = (full: string, leaf: number) => {
            const rest = under(dir, full);
            if (!rest) return;
            const parts = rest.split(/[\\/]/);
            entries.set(parts[0], parts.length > 1 ? DIRECTORY : leaf);
          };
          for (const f of state.files.keys()) add(f, FILE);
          for (const d of state.directories) add(d, DIRECTORY);
          return Promise.resolve([...entries]);
        },
        copy: (from: { fsPath: string }, to: { fsPath: string }, options?: unknown) => {
          const src = normalizeFsPath(from.fsPath);
          const bytes = state.files.get(src);
          if (!bytes) return Promise.reject(new Error(`ENOENT: ${from.fsPath}`));
          const dest = normalizeFsPath(to.fsPath);
          state.files.set(dest, bytes);
          state.fsOps.push({ op: "copy", uri: src, to: dest, options });
          return Promise.resolve();
        },
        delete: (uri: { fsPath: string }, options?: unknown) => {
          const p = normalizeFsPath(uri.fsPath);
          for (const f of [...state.files.keys()]) {
            if (f === p || under(p, f)) state.files.delete(f);
          }
          for (const d of [...state.directories]) {
            if (d === p || under(p, d)) state.directories.delete(d);
          }
          state.fsOps.push({ op: "delete", uri: p, options });
          return Promise.resolve();
        },
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
      showSaveDialog: (options?: unknown) => {
        state.saveDialogOptions.push(options);
        const reply = state.saveDialogReplies.shift();
        return Promise.resolve(reply === undefined ? undefined : FakeUri.file(reply));
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
      registerUriHandler: (handler: { handleUri(uri: { path: string }): void }) => {
        state.uriHandler = handler;
        return new FakeDisposable(() => {
          state.uriHandler = undefined;
        });
      },
      createStatusBarItem: (alignment: number, priority?: number) => {
        const item = new FakeStatusBarItem(alignment, priority);
        state.statusBarItems.push(item);
        return item;
      },
      createOutputChannel: (name: string) => {
        // Recorded: for a long-running external command the channel is the only
        // place its output goes, so "see the output" is part of the contract.
        const channel = { name, lines: [] as string[], shown: false, disposed: false };
        state.outputChannels.push(channel);
        return {
          name,
          appendLine: (text: string) => channel.lines.push(text),
          append: (text: string) => channel.lines.push(text),
          show: () => {
            channel.shown = true;
          },
          dispose: () => {
            channel.disposed = true;
          },
        };
      },
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
      get visibleTextEditors() {
        return state.visibleTextEditors;
      },
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
      startDebugging: (folder: unknown, config: Record<string, unknown>, options: unknown) => {
        state.startedDebugSessions.push({ folder, config, options });
        return Promise.resolve(true);
      },
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
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
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
    // The descriptor an inline debug adapter is wrapped in; the real class just
    // carries the implementation, so exposing it is enough for a factory spec.
    DebugAdapterInlineImplementation: class {
      constructor(readonly implementation: unknown) {}
    },
  };
}
