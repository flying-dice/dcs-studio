// Shared, reactive app state (Svelte 5 runes). Imported as a singleton so all
// components — stripes, file tree, editor, status bar — read/write the same state.
import {
  EDITOR_THEMES,
  editorThemeById,
  DEFAULT_DARK_THEME,
  DEFAULT_LIGHT_THEME,
} from "./themes";
import {
  basename,
  pickFolder,
  writeTextFile,
  createProjectFromTemplate,
  renamePath,
  deleteToTrash,
  dcsCall,
  dcsStatus,
  githubSession,
  githubSignOut,
  type GithubSession,
} from "./api";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { canonicalPath } from "./paths";
import { wsConnected } from "./dcs-ws";
import { lang } from "./lang/intel.svelte";
import { saveWithFormat } from "./save-format";
import { todos } from "./todos.svelte";
import type { Extension } from "@codemirror/state";

/** Persist one string to localStorage, swallowing quota / SSR-absence errors. */
function writeLocalStorage(key: string, value: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore quota / serialization errors */
  }
}

const EDITOR_THEME_KEY = "dcs.editorTheme";
const PANEL_SIZES_KEY = "dcs.panelSizes";

const _pw = (() => {
  if (typeof localStorage === "undefined") return { left: 270, right: 270, bottom: 208 };
  try {
    const raw = localStorage.getItem(PANEL_SIZES_KEY);
    const p = raw ? JSON.parse(raw) : {};
    return {
      left:   typeof p.left   === "number" ? p.left   : 270,
      right:  typeof p.right  === "number" ? p.right  : 270,
      bottom: typeof p.bottom === "number" ? p.bottom : 208,
    };
  } catch { return { left: 270, right: 270, bottom: 208 }; }
})();

function savePanelSizes(left: number, right: number, bottom: number): void {
  try { localStorage.setItem(PANEL_SIZES_KEY, JSON.stringify({ left, right, bottom })); }
  catch { /* ignore */ }
}

function loadEditorThemeId(): string {
  if (typeof localStorage === "undefined") return DEFAULT_DARK_THEME;
  const id = localStorage.getItem(EDITOR_THEME_KEY);
  return id && EDITOR_THEMES.some((t) => t.id === id) ? id : DEFAULT_DARK_THEME;
}

function saveEditorThemeId(id: string): void {
  writeLocalStorage(EDITOR_THEME_KEY, id);
}

const FORMAT_ON_SAVE_KEY = "dcs.formatOnSave";

function loadFormatOnSave(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(FORMAT_ON_SAVE_KEY) === "true";
}

function saveFormatOnSave(on: boolean): void {
  writeLocalStorage(FORMAT_ON_SAVE_KEY, String(on));
}

export interface RecentProject {
  path: string;
  name: string;
  openedAt: number;
}

/**
 * One open editor tab (model studio::core Document). `savedText` is the
 * on-disk baseline; `docText` is the live buffer — the tab is dirty while
 * they diverge. The CodeMirror state (undo history, selection, scroll) is
 * parked per tab by the Editor component, keyed by `path`.
 *
 * `kind` is "loading" until the first read classifies the file (model
 * `LoadTab`): "text" tabs edit normally; a "binary" tab shows a placeholder
 * sized by `binarySize` and keeps `docText`/`savedText` blank — its bytes
 * never enter the editor.
 */
export interface OpenDoc {
  path: string;
  name: string;
  docText: string;
  savedText: string;
  kind: "loading" | "text" | "binary";
  binarySize?: number;
}

/**
 * openPath / closeProject's environment-touching collaborators: basename
 * resolution (a Tauri command) and the language-engine mount/reset.
 * Injectable so the browser lab (/lab/project-switch) can drive the real
 * switch/close guards without Tauri — same seam convention as LangIntel's
 * IntelFs.
 */
export interface ProjectOps {
  basename(path: string): Promise<string>;
  mountWorkspace(path: string): Promise<void>;
  resetWorkspace(): void;
}

const RECENTS_KEY = "dcs.recents";
const RECENTS_MAX = 8;

function loadRecents(): RecentProject[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveRecents(recents: RecentProject[]): void {
  writeLocalStorage(RECENTS_KEY, JSON.stringify(recents));
}

class AppState {
  // Chrome brightness (shadcn light/dark) — kept in sync with the editor theme.
  dark = $state(true);
  // Selected CodeMirror colour theme + the last theme used at each brightness,
  // so toggling dark/light restores your previous choice for that mode.
  editorThemeId = $state<string>(DEFAULT_DARK_THEME);
  lastDark = $state<string>(DEFAULT_DARK_THEME);
  lastLight = $state<string>(DEFAULT_LIGHT_THEME);
  // Whether the editor reformats the buffer before each save (model
  // studio::edit::Formatting) — an editor preference, off by default.
  formatOnSave = $state<boolean>(loadFormatOnSave());

  constructor() {
    const id = loadEditorThemeId();
    const t = editorThemeById(id);
    this.editorThemeId = id;
    this.dark = t.dark;
    if (t.dark) this.lastDark = id;
    else this.lastLight = id;
  }

  // GitHub identity (issue #11). The access token stays Rust-side (keyring);
  // this is the profile only. Sign-in is OPTIONAL — the IDE is fully usable
  // signed-out; `session` just drives the header chip + GitHub-backed features.
  session = $state<GithubSession | null>(null);

  /** Load the cached session on boot to populate the header chip. */
  async loadSession(): Promise<void> {
    if (!isTauri()) return; // browser dev: no backend; the chip shows "Sign in"
    try {
      this.session = (await githubSession()) ?? null;
    } catch {
      this.session = null;
    }
  }

  /** Record the session after a successful sign-in. */
  setSession(session: GithubSession): void {
    this.session = session;
  }

  /** Sign out: clear the cached token + profile; the chip returns to "Sign in". */
  async signOut(): Promise<void> {
    try {
      await githubSignOut();
    } catch {
      /* clearing the chip matters even if the backend call fails */
    }
    this.session = null;
  }

  // Workspace
  rootPath = $state<string | null>(null);
  rootName = $state<string>("");

  // Recently opened projects (most-recent first), persisted to localStorage.
  recents = $state<RecentProject[]>(loadRecents());

  // Open editor tabs (model studio::core Document). Each tab owns its own
  // buffer: `savedText` is the on-disk baseline, `docText` the live editor
  // text — they diverge while that tab has unsaved edits.
  openFiles = $state<OpenDoc[]>([]);
  activePath = $state<string | null>(null);
  saving = $state(false);
  // One project switch/close at a time: under Tauri the confirm dialog is
  // async (it doesn't block like window.confirm), so a double-click on a
  // recent must not run the flow — or the dialog — twice (mirrors `saving`).
  switching = $state(false);

  /** See `ProjectOps` — the lab route swaps in in-memory stand-ins. */
  projectOps: ProjectOps = {
    basename,
    mountWorkspace: (path) => lang.mountWorkspace(path),
    resetWorkspace: () => lang.reset(),
  };

  // How to reformat the active buffer in place before a save (format-on-save).
  // The editor registers this on mount and clears it on destroy; absent when no
  // editor is mounted, so format-on-save has nothing to reformat (model
  // FormatBeforeSave: no buffer → unchanged). Held here so EVERY save entry
  // point (editor ⌘S, global ⌘S, File → Save) reformats identically.
  private formatActiveBuffer: (() => Promise<void>) | null = null;

  /** The active tab's record, if any file is open. */
  get activeDoc(): OpenDoc | null {
    return this.openFiles.find((f) => f.path === this.activePath) ?? null;
  }

  /** Path of the active tab (kept as the legacy single-file accessor). */
  get filePath(): string | null {
    return this.activeDoc?.path ?? null;
  }

  /** Display name of the active tab. */
  get fileName(): string {
    return this.activeDoc?.name ?? "";
  }

  /** Whether the active tab has unsaved edits. */
  get dirty(): boolean {
    const doc = this.activeDoc;
    return !!doc && doc.docText !== doc.savedText;
  }

  /** Whether the tab for `path` has unsaved edits. */
  isDirty(path: string): boolean {
    const doc = this.openFiles.find((f) => f.path === path);
    return !!doc && doc.docText !== doc.savedText;
  }

  // Live DCS link status, driven by the Rust-side heartbeat (see dcs.rs).
  // `dcsConnected` = WS to the bridge is up (DCS may still be in the menu);
  // `dcsSimRunning` = pings are ponging, i.e. a mission is actually running.
  dcsConnected = $state(false);
  dcsSimRunning = $state(false);
  dcsLatencyMs = $state<number | null>(null);
  dcsTime = $state<number | null>(null);
  private dcsInitialised = false;

  /** Subscribe to the DCS link events. Called once from the root layout. */
  async initDcs() {
    if (this.dcsInitialised) return;
    this.dcsInitialised = true;

    if (!isTauri()) {
      this.startBrowserHeartbeat();
      return;
    }
    await this.listenToLinkEvents();
    await this.seedFromBackendSnapshot();
  }

  /**
   * Outside Tauri (vite dev / Playwright) there are no Rust-side events:
   * drive the status from a browser-side ping heartbeat over the bridge WS.
   */
  private startBrowserHeartbeat() {
    const beat = async () => {
      const started = performance.now();
      try {
        const pong = (await dcsCall("ping")) as { dcs_time?: number } | null;
        // Same rule as the Rust heartbeat (dcs.rs): the bridge pongs from
        // the main menu too; a mission is live only once dcs_time > 0.
        const dcsTime = typeof pong?.dcs_time === "number" ? pong.dcs_time : 0;
        this.dcsConnected = true;
        this.dcsSimRunning = dcsTime > 0;
        this.dcsTime = dcsTime;
        this.dcsLatencyMs = Math.round(performance.now() - started);
      } catch {
        this.dcsConnected = wsConnected();
        this.dcsSimRunning = false;
        this.dcsLatencyMs = null;
        this.dcsTime = null;
      }
    };
    void beat();
    setInterval(() => void beat(), 2000);
  }

  /** Relay the Rust-side link events into the reactive fields. */
  private async listenToLinkEvents() {
    await listen("dcs://connected", () => {
      this.dcsConnected = true;
    });
    await listen("dcs://disconnected", () => {
      this.dcsConnected = false;
      this.dcsSimRunning = false;
      this.dcsLatencyMs = null;
      this.dcsTime = null;
    });
    await listen<{ sim_running: boolean; latency_ms?: number; dcs_time?: number }>(
      "dcs://heartbeat",
      (e) => {
        this.dcsSimRunning = e.payload.sim_running;
        this.dcsLatencyMs = e.payload.latency_ms ?? null;
        this.dcsTime = e.payload.dcs_time ?? null;
      },
    );
  }

  /**
   * Seed from the backend snapshot to cover events emitted before we
   * started listening (the heartbeat starts with the app, not the UI).
   */
  private async seedFromBackendSnapshot() {
    try {
      const s = await dcsStatus();
      this.dcsConnected = s.connected;
      this.dcsSimRunning = s.sim_running;
      this.dcsLatencyMs = s.latency_ms;
    } catch {
      /* backend not ready yet — events will catch us up */
    }
  }

  // Which tool window is open in each stripe (null = collapsed)
  leftTool = $state<string | null>("project");
  rightTool = $state<string | null>(null);
  bottomTool = $state<string | null>(null);

  leftPanelWidth   = $state(_pw.left);
  rightPanelWidth  = $state(_pw.right);
  bottomPanelHeight = $state(_pw.bottom);

  /** The CodeMirror extension for the currently selected editor theme. */
  get cm(): Extension {
    return editorThemeById(this.editorThemeId).ext;
  }

  /** Pick an editor colour theme; the chrome follows its brightness. */
  setEditorTheme(id: string) {
    const t = editorThemeById(id);
    this.editorThemeId = t.id;
    this.dark = t.dark;
    if (t.dark) this.lastDark = t.id;
    else this.lastLight = t.id;
    saveEditorThemeId(t.id);
  }

  /** Flip light/dark, restoring the last editor theme used at that brightness. */
  toggleMode() {
    this.setEditorTheme(this.dark ? this.lastLight : this.lastDark);
  }

  /** Turn format-on-save on or off (reformat the buffer before each write). */
  setFormatOnSave(on: boolean) {
    this.formatOnSave = on;
    saveFormatOnSave(on);
  }

  /** Open the native folder picker, then load the chosen folder as the project. */
  async openFolder() {
    const path = await pickFolder();
    if (!path) return;
    await this.openPath(path);
  }

  /**
   * On boot, open the project the app was launched with (`--open <path>`;
   * model `OpenStartupProject`). A no-op outside Tauri (no backend to ask) and
   * when no `--open` was given. The e2e suite uses this to drive the real
   * workbench against a fixture project on disk.
   */
  async openStartupProject(): Promise<void> {
    if (!isTauri()) return;
    const path = await invoke<string | null>("startup_open");
    if (path) await this.openPath(path);
  }

  /**
   * Load a project by absolute path (from the picker or a recent entry).
   * Switching away while open tabs have unsaved edits asks ONE count-naming
   * confirmation (model `OpenProject`); declining aborts the switch with
   * every tab, buffer, dirty flag, and the current project intact. The
   * initial open (no tabs yet) never prompts — the dirty count is 0.
   */
  async openPath(path: string): Promise<void> {
    if (this.switching) return;
    this.switching = true;
    try {
      const dirty = this.countDirtyTabs();
      if (dirty > 0) {
        const confirmed = await this.confirmDiscard(this.discardPrompt(dirty));
        if (!confirmed) return;
      }
      this.rootPath = path;
      this.rootName = await this.projectOps.basename(path);
      this.openFiles = [];
      this.activePath = null;
      this.leftTool = "project";
      this.remember(path, this.rootName);
      // Project-opened announcement: mount the workspace into the language
      // engine (model/studio/lang.pds MountWorkspace). Fire-and-forget — an
      // engine failure is non-fatal and surfaces in the status bar.
      void this.projectOps.mountWorkspace(path);
      // …and rescan comment tags for the Todos panel (model/studio/todos.pds
      // RefreshAll) — equally fire-and-forget and non-fatal.
      void todos.refreshAll(path);
    } finally {
      this.switching = false;
    }
  }

  /**
   * Scaffold a new project from a template into `parent/<name>`, then open it.
   * Returns the new root path, or throws if creation fails (e.g. already exists).
   */
  async createProject(parent: string, name: string, templateId: string) {
    const path = await createProjectFromTemplate(parent, name, templateId);
    await this.openPath(path);
    return path;
  }

  /**
   * Return to the welcome screen without quitting (model `CloseProject`).
   * Same guard as openPath: unsaved tabs need one count-naming
   * confirmation, and declining keeps the workspace exactly as it was.
   */
  async closeProject(): Promise<void> {
    if (this.switching) return;
    this.switching = true;
    try {
      const dirty = this.countDirtyTabs();
      if (dirty > 0) {
        const confirmed = await this.confirmDiscard(this.discardPrompt(dirty));
        if (!confirmed) return;
      }
      this.rootPath = null;
      this.rootName = "";
      this.openFiles = [];
      this.activePath = null;
      this.projectOps.resetWorkspace();
      todos.reset();
    } finally {
      this.switching = false;
    }
  }

  /** How many open tabs have unsaved edits — the blast radius a project
   * switch or close would discard (model `CountDirtyTabs`). */
  private countDirtyTabs(): number {
    return this.openFiles.filter((f) => f.docText !== f.savedText).length;
  }

  /** The count-naming confirmation prompt (model `DiscardPrompt`). */
  private discardPrompt(count: number): string {
    return count === 1
      ? "1 file has unsaved changes. Discard it and continue?"
      : `${count} files have unsaved changes. Discard them and continue?`;
  }

  /** Record (or bump) a project in the recents list. */
  private remember(path: string, name: string) {
    const next = [
      { path, name, openedAt: Date.now() },
      ...this.recents.filter((r) => r.path !== path),
    ].slice(0, RECENTS_MAX);
    this.recents = next;
    saveRecents(next);
  }

  /** Drop a project from the recents list. */
  removeRecent(path: string) {
    this.recents = this.recents.filter((r) => r.path !== path);
    saveRecents(this.recents);
  }

  /**
   * Buffer-eviction signal (model studio::edit `ApplyWorkspaceEdit`): a
   * cross-file rename rewrites open-but-inactive tabs on disk; their parked
   * editor state is now stale, so the editor drops it and the tab reloads
   * from disk on reactivation. The tick makes each emission a distinct value
   * so the editor's effect re-runs even for the same paths.
   */
  evicted = $state<{ tick: number; paths: string[] }>({ tick: 0, paths: [] });

  /** Mark `paths`' parked editor buffers stale so they reload from disk. */
  evictBuffers(paths: string[]) {
    this.evicted = { tick: this.evicted.tick + 1, paths };
  }

  /**
   * Where the editor should land once the next file finishes loading
   * (1-based line/column, UTF-16 columns) — set when a Problems entry is
   * opened, consumed by the editor, then cleared.
   */
  pendingJump = $state<
    { line: number; col: number } | { offset: number } | null
  >(null);

  /**
   * Open a file (model `OpenFile`): an already-open tab is re-activated
   * as-is — pending edits and undo history intact; otherwise a fresh tab is
   * appended and activated. The editor loads its text from disk on first
   * activation and reports it via `onDocLoaded`. `jumpTo` lands the caret on
   * a 1-based line/column (Problems navigation) or a document offset
   * (go-to-definition, find-usages — model studio::edit RevealLocation).
   */
  openFile(
    path: string,
    name: string,
    jumpTo?: { line: number; col: number } | { offset: number },
  ) {
    // One identity per file no matter the source: the file tree gives an
    // upper-case Windows drive letter, a Problems-click's path comes round-
    // trip through a language server's file:// URI (lower-cased). Canonicalise
    // before the dedup or the same file opens twice (model/studio/core.pds
    // CanonicalPath, OpenFileHasOneIdentity).
    const canonical = canonicalPath(path);
    this.pendingJump = jumpTo ?? null;
    const existing = this.openFiles.find((f) => f.path === canonical);
    if (existing) {
      this.activePath = canonical;
      return;
    }
    // Combine both lines of work: develop's canonical-path identity (so the
    // same file never opens twice) + main's load state machine (`kind` starts
    // "loading" until the first read classifies the file — issue #30).
    this.openFiles.push({
      path: canonical,
      name,
      docText: "",
      savedText: "",
      kind: "loading",
    });
    this.activePath = canonical;
  }

  /** Make an already-open tab the active one (model `ActivateTab`). */
  activateFile(path: string) {
    if (this.openFiles.some((f) => f.path === path)) this.activePath = path;
  }

  /**
   * Open `path` and land the caret at a document offset — the shared
   * navigation behind go-to-definition and the Usages panel (model
   * studio::edit `Refactoring.RevealLocation`).
   */
  openFileAt(path: string, offset: number) {
    const name = path.split(/[\\/]/).pop() || path;
    this.openFile(path, name, { offset });
  }

  /**
   * File-tree refresh signal (issue #17): a tree mutation (create, rename,
   * duplicate, delete) bumps this so every expanded TreeNode re-reads its
   * children and the FileTree re-reads its roots.
   */
  treeVersion = $state(0);

  /** Bump the tree-refresh signal after a filesystem mutation. */
  refreshTree() {
    this.treeVersion += 1;
  }

  /** Whether `path` is at or under `dir` (descendant test for tab coordination). */
  private isUnder(path: string, dir: string): boolean {
    return (
      path === dir || path.startsWith(`${dir}\\`) || path.startsWith(`${dir}/`)
    );
  }

  /**
   * Rename a workspace path from the file tree, following any open tab to the
   * new path (model `RenameWorkspacePath`). A rename moves the file but not
   * its content, so a clean tab reopens at the new path losing nothing; a tab
   * with unsaved edits is refused (its edits live only in the buffer a path
   * change would strand). Rejects with a message the tree surfaces.
   */
  async renameWorkspacePath(
    root: string,
    src: string,
    dst: string,
  ): Promise<void> {
    const from = canonicalPath(src);
    const affected = this.openFiles.filter((f) => this.isUnder(f.path, from));
    const dirty = affected.filter((f) => f.docText !== f.savedText);
    if (dirty.length > 0) {
      const names = dirty.map((f) => f.name).join(", ");
      throw new Error(`Save ${names} before renaming.`);
    }
    await renamePath(root, src, dst); // rejects on collision / escape
    const to = canonicalPath(dst);
    // Where focus must end up (model `RetargetTabs`: the previously active tab
    // stays active). If the active tab was itself renamed, follow it to its new
    // path; otherwise it is untouched and must keep focus — the per-tab
    // `openFile` calls below each grab `activePath`, so we restore it after.
    const previousActive = this.activePath;
    const refocus =
      previousActive && this.isUnder(previousActive, from)
        ? to + previousActive.slice(from.length)
        : previousActive;
    // Close each affected tab and reopen it at its new path (content unchanged
    // by the rename, so the reload loses nothing — model `RetargetTabs`).
    for (const tab of affected) {
      const next = to + tab.path.slice(from.length);
      this.openFiles = this.openFiles.filter((f) => f !== tab);
      this.openFile(next, next.split(/[\\/]/).pop() || next);
    }
    this.activePath = refocus;
    this.refreshTree();
  }

  /**
   * Delete a workspace path to the Recycle Bin and close any open tab for it
   * (model `DeleteWorkspacePath`): the file is gone, so its tab — and tabs for
   * descendants of a deleted folder — close without a discard prompt.
   */
  async deleteWorkspacePath(root: string, path: string): Promise<void> {
    await deleteToTrash(root, path); // rejects on escape / io error
    const target = canonicalPath(path);
    const affected = this.openFiles.filter((f) => this.isUnder(f.path, target));
    for (const tab of affected) {
      const idx = this.openFiles.findIndex((f) => f === tab);
      if (idx < 0) continue;
      this.openFiles.splice(idx, 1);
      if (this.activePath === tab.path) {
        const neighbour = this.openFiles[idx] ?? this.openFiles[idx - 1];
        this.activePath = neighbour?.path ?? null;
      }
    }
    this.refreshTree();
  }

  /**
   * Close a tab (model `CloseFile`): a dirty tab needs confirmation before
   * its edits are discarded; closing the active tab activates a neighbour,
   * and closing the last tab returns to the no-file-open state.
   */
  async closeFile(path: string): Promise<void> {
    const tab = this.openFiles.find((f) => f.path === path);
    if (!tab) return;
    if (tab.docText !== tab.savedText) {
      const confirmed = await this.confirmDiscard(
        `${tab.name} has unsaved changes. Close it and discard them?`,
      );
      if (!confirmed) return;
    }
    // Re-locate the tab: the list may have changed while the dialog was up.
    const idx = this.openFiles.findIndex((f) => f.path === path);
    if (idx < 0) return;
    this.openFiles.splice(idx, 1);
    if (this.activePath === path) {
      const neighbour = this.openFiles[idx] ?? this.openFiles[idx - 1];
      this.activePath = neighbour?.path ?? null;
    }
  }

  /** Close the active tab, if any (File → Close Editor, tab × button). */
  closeActiveFile() {
    if (this.activePath) void this.closeFile(this.activePath);
  }

  /**
   * Ask the developer before discarding unsaved edits — one tab's
   * (closeFile) or every dirty tab's (project switch/close); the caller
   * provides the prompt (model `ConfirmDiscard`). Dual-path like dcsCall:
   * the native dialog in the packaged app (window.confirm is a
   * non-functional stub in Tauri's webview), window.confirm in a plain
   * browser (vite dev, Playwright). With no confirm surface at all the
   * answer is NO — never silently discard unsaved work.
   */
  private async confirmDiscard(message: string): Promise<boolean> {
    // Test seam (issue #32): the e2e-lang suite drives the REAL app, where the
    // confirm is a native Tauri dialog Playwright/CDP can neither read nor
    // answer (it auto-cancels). An injected probe lets the suite see the prompt
    // and decide. Production never sets it, so this is inert outside the test.
    const probe = (
      globalThis as {
        __dcsConfirm__?: (m: string) => boolean | Promise<boolean>;
      }
    ).__dcsConfirm__;
    if (probe) {
      return probe(message);
    }
    if (isTauri()) {
      return confirmDialog(message, { title: "Unsaved changes", kind: "warning" });
    }
    if (typeof window !== "undefined" && typeof window.confirm === "function") {
      return window.confirm(message);
    }
    return false;
  }

  /**
   * Public confirm for destructive tree actions (delete to Recycle Bin),
   * over the same dual-path seam as the unsaved-edits prompt. The title is
   * "Confirm" rather than "Unsaved changes".
   */
  async confirm(message: string): Promise<boolean> {
    const probe = (
      globalThis as {
        __dcsConfirm__?: (m: string) => boolean | Promise<boolean>;
      }
    ).__dcsConfirm__;
    if (probe) return probe(message);
    if (isTauri()) return confirmDialog(message, { title: "Confirm" });
    if (typeof window !== "undefined" && typeof window.confirm === "function") {
      return window.confirm(message);
    }
    return false;
  }

  /** Called by the editor once a text file's contents have loaded from disk. */
  onDocLoaded(path: string, text: string) {
    const doc = this.openFiles.find((f) => f.path === path);
    if (!doc) return;
    doc.kind = "text";
    doc.savedText = text;
    doc.docText = text;
  }

  /**
   * Called by the editor when a first-activated tab classifies as binary
   * (model `MarkBinary`): the buffer stays blank — its bytes never enter the
   * editor — and the tab shows the placeholder sized by `size`.
   */
  onDocBinary(path: string, size: number) {
    const doc = this.openFiles.find((f) => f.path === path);
    if (!doc) return;
    doc.kind = "binary";
    doc.binarySize = size;
  }

  /** Called by the editor on every user edit to the tab for `path`. */
  onDocEdited(path: string, text: string) {
    const doc = this.openFiles.find((f) => f.path === path);
    if (doc) doc.docText = text;
  }

  /**
   * Register how to reformat the active buffer in place (format-on-save). The
   * editor sets this on mount and clears it (`null`) on destroy.
   */
  setBufferFormatter(format: (() => Promise<void>) | null) {
    this.formatActiveBuffer = format;
  }

  /**
   * Injectable file writer so /lab/buffers can exercise `saveFile` in a
   * plain browser (no Tauri fs) — same seam convention as the Editor
   * component's `readFile` prop and IntelFs in intel.svelte.ts.
   */
  writeFile: (path: string, contents: string) => Promise<void> = writeTextFile;

  /**
   * Persist the ACTIVE tab's buffer to the ACTIVE tab's path — never any
   * other tab's (model `SaveFile`). No-op when clean or already saving. The
   * single save path for every entry point (editor ⌘S, global ⌘S, File → Save);
   * when format-on-save is on it reformats the buffer first (model
   * FormatBeforeSave), and a broken buffer never blocks the write
   * (SaveNeverBlockedByBrokenLua).
   */
  async saveFile() {
    const doc = this.activeDoc;
    if (!doc || doc.docText === doc.savedText || this.saving) return;
    this.saving = true;
    try {
      await saveWithFormat({
        formatOnSave: this.formatOnSave,
        format: () => this.formatActiveBuffer?.() ?? Promise.resolve(),
        // Read the buffer AFTER any reformat, and capture it BEFORE the write:
        // keystrokes that land while the write is in flight must keep the tab
        // dirty, so the baseline is exactly what was written — and it lands on
        // `doc` (the saved tab), never on whichever tab is active by the time
        // the write finishes.
        persist: async () => {
          const text = doc.docText;
          await this.writeFile(doc.path, text);
          doc.savedText = text;
          // Saved-file rescan for the Todos panel (model/studio/todos.pds
          // RefreshFile): splices only this file's entries.
          void todos.refreshFile(doc.path);
        },
      });
    } finally {
      this.saving = false;
    }
  }

  /** Open the tool window in a stripe, or collapse it when already open. */
  toggleTool(stripe: "left" | "right" | "bottom", id: string) {
    const key = `${stripe}Tool` as const;
    this[key] = this[key] === id ? null : id;
  }

  setPanelSize(side: "left" | "right" | "bottom", size: number) {
    if (side === "left")        this.leftPanelWidth   = size;
    else if (side === "right")  this.rightPanelWidth  = size;
    else                        this.bottomPanelHeight = size;
    savePanelSizes(this.leftPanelWidth, this.rightPanelWidth, this.bottomPanelHeight);
  }
}

export const app = new AppState();
