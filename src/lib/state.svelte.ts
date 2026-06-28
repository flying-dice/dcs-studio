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
  githubSession,
  githubSignOut,
  classifyAndRead,
  watchStart,
  watchStop,
  type GithubSession,
} from "./api";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { canonicalPath } from "./paths";
import { writeLocalStorage } from "./local-storage";
import { reconcileBuffer, fsKey } from "./workspace-util";
import { dcsLink } from "./dcs-link.svelte";
import { fileWatcher } from "./file-watcher.svelte";
import { lang } from "./lang/intel.svelte";
import { cargoTomlExists } from "./lang/rust-analyzer";
import { Superseder } from "./supersede";
import { saveWithFormat } from "./save-format";
import { todos } from "./todos.svelte";
import { bookmarks } from "./bookmarks.svelte";
import { database } from "./database.svelte";
import { search } from "./search.svelte";
import { marketplace } from "./marketplace.svelte";
import { publish } from "./publish.svelte";
import type { Extension } from "@codemirror/state";

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
  /** The file changed on disk while this buffer had unsaved edits (issue #40) —
   * the editor surfaces a stale-buffer banner offering reload-or-keep. */
  diskChanged?: boolean;
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

/**
 * The editor's command surface for the application menu (Edit → Undo / Redo /
 * Cut / Copy / Paste, issue #59). The active CodeMirror view is component-local
 * to Editor.svelte; rather than leak the raw view into global state, the editor
 * registers these thin commands on mount and clears them on destroy. The menu
 * dispatches through here and never touches CodeMirror — the mirror of the
 * `setBufferFormatter` seam.
 */
export interface EditorCommandBus {
  undo(): void;
  redo(): void;
  cut(): void;
  copy(): void;
  paste(): void;
  find(): void;
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
    // Don't leak the previous account's GitHub-backed state into the next one.
    marketplace.reset();
    publish.reset();
  }

  // Workspace
  rootPath = $state<string | null>(null);

  /**
   * Whether the open project is a Rust project — a Cargo.toml at the root
   * (model studio::core Workbench.IsRustProject, matching the backend
   * Builder.IsRustProject). Gates the Build affordance (toolbar button +
   * Run -> Build Project + ⌘F9). Re-probed on project open and tree refresh;
   * defaults false so a non-project / pre-probe state never offers Build.
   */
  isRustProject = $state(false);

  /** Latest-wins coordinator for the Cargo.toml probe: overlapping same-root
   * probes (FileTree's 5s poll + focus/visibility vs a tree mutation) must not
   * resolve out of order and re-show Build for a non-Rust project (issue #69). */
  private readonly rustProbe = new Superseder();
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

  // The editor's command surface for the Edit menu (issue #59). Registered by
  // the editor on mount, cleared (`null`) on destroy; absent when no editor is
  // mounted, so the Edit menu items disable (see `canEdit`).
  private editorBus = $state<EditorCommandBus | null>(null);

  // Whether the active editor has a non-empty selection (issue #59). The editor
  // reports this on every selection change and on each tab swap; Cut / Copy gate
  // on it (see `canCopy`) so the menu matches the editor's own context menu —
  // never an enabled item that silently does nothing on a collapsed cursor.
  private editorHasSelection = $state(false);

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

  // Live DCS link status — the polling/event engine lives in the `dcsLink`
  // store (dcs-link.svelte.ts). Re-exposed here as read-only proxies so the
  // status bar and Injection Manager read `app.dcsConnected` etc. unchanged
  // (a getter onto a $state field stays reactive in Svelte 5).
  get dcsConnected(): boolean {
    return dcsLink.connected;
  }
  get dcsSimRunning(): boolean {
    return dcsLink.simRunning;
  }
  get dcsLatencyMs(): number | null {
    return dcsLink.latencyMs;
  }
  get dcsTime(): number | null {
    return dcsLink.time;
  }

  /** Subscribe to the DCS link heartbeat. Called once from the root layout. */
  initDcs(): Promise<void> {
    return dcsLink.init();
  }

  /** Subscribe to workspace fs-change events (issue #40). Called once from the
   * root layout, alongside initDcs. */
  initWatcher(): Promise<void> {
    return fileWatcher.init((paths) => void this.onFsChanged(paths));
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
      // Build affordance gate (issue #69): hide until proven Rust, then probe.
      this.isRustProject = false;
      void this.refreshIsRustProject();
      this.rootName = await this.projectOps.basename(path);
      this.openFiles = [];
      this.activePath = null;
      this.leftTool = "project";
      this.remember(path, this.rootName);
      // Watch the workspace so the tree + buffers stay in sync (issue #40);
      // replaces any prior watch. Fire-and-forget — non-fatal if it can't start,
      // but log so a non-live tree isn't a silent mystery.
      void watchStart(path).catch((e) => console.error("watch start failed:", e));
      // Project-opened announcement: mount the workspace into the language
      // engine (model/studio/lang.pds MountWorkspace). Fire-and-forget — an
      // engine failure is non-fatal and surfaces in the status bar.
      void this.projectOps.mountWorkspace(path);
      // …and rescan comment tags for the Todos panel (model/studio/todos.pds
      // RefreshAll) — equally fire-and-forget and non-fatal.
      void todos.refreshAll(path);
      // …and restore this project's bookmarks (model/studio/bookmarks.pds
      // LoadProject), keyed by the canonical root — synchronous, localStorage.
      bookmarks.load(path);
      // …and rediscover the SQLite DBs the DLL writes under lfs.writedir() for
      // the Database panel (model/studio/database.pds RefreshDatabases). Reset
      // first so a previously-opened database's tables/result/selection don't
      // leak across the switch; discovery itself is fire-and-forget and non-fatal.
      database.reset();
      void database.refresh();
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
      this.isRustProject = false;
      this.openFiles = [];
      this.activePath = null;
      void watchStop().catch((e) => console.error("watch stop failed:", e));
      this.projectOps.resetWorkspace();
      todos.reset();
      bookmarks.reset();
      database.reset();
      search.reset();
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
   * Buffer-reload signal (issue #40): a file changed on disk and its CLEAN
   * buffer's text was refreshed in the store — the editor re-applies it to the
   * live view (active tab) or drops the parked state (inactive). Distinct from
   * `evicted` (rename) so the two effects don't clobber each other.
   */
  reloaded = $state<{ tick: number; paths: string[] }>({ tick: 0, paths: [] });

  /**
   * Save signal (model/studio/bookmarks.pds RemapFileBookmarks): bumped after a
   * file is saved so the editor re-anchors that file's bookmarks — it reads the
   * marks that rode the buffer's edits and writes the new lines + snippets back
   * to the store. Its own signal so it never tangles with `reloaded`/`evicted`.
   */
  saved = $state<{ tick: number; path: string } | null>(null);

  /**
   * Reconcile open buffers with disk after an `fs://changed` batch. Refreshes
   * the file tree, then for each open text doc whose file changed: a CLEAN
   * buffer reloads silently; a DIRTY one is flagged stale (never clobbered). A
   * change matching `savedText` (e.g. our own save) is a no-op.
   */
  async onFsChanged(paths: string[]): Promise<void> {
    this.refreshTree();
    // fsKey unifies the watcher's path form with the tree's identity (separators
    // / `\\?\` / drive-case), so a change can't silently miss its open buffer.
    const changed = new Set(paths.map(fsKey));
    const reload: string[] = [];
    for (const doc of this.openFiles) {
      if (doc.kind !== "text" || !changed.has(fsKey(doc.path))) continue;
      let load;
      try {
        load = await classifyAndRead(doc.path);
      } catch {
        continue; // gone/unreadable — the tree refresh reflects a deletion
      }
      if (load.kind !== "text") continue;
      switch (reconcileBuffer(doc.savedText, doc.docText, load.text)) {
        case "reload":
          doc.savedText = load.text;
          doc.docText = load.text;
          doc.diskChanged = false;
          reload.push(doc.path);
          break;
        case "stale":
          doc.diskChanged = true; // dirty: warn, don't overwrite the user's edits
          break;
        case "noop":
          doc.diskChanged = false; // disk matches our baseline (our save / a revert)
          break;
      }
    }
    if (reload.length) this.reloaded = { tick: this.reloaded.tick + 1, paths: reload };
  }

  /** Reload `path`'s buffer from disk, discarding unsaved edits (the stale-buffer
   * banner's Reload action). */
  async reloadFromDisk(path: string): Promise<void> {
    const doc = this.openFiles.find((f) => f.path === path);
    if (!doc) return;
    let load;
    try {
      load = await classifyAndRead(path);
    } catch {
      return;
    }
    if (load.kind !== "text") return;
    doc.savedText = load.text;
    doc.docText = load.text;
    doc.diskChanged = false;
    this.reloaded = { tick: this.reloaded.tick + 1, paths: [path] };
  }

  /** Dismiss the stale-buffer banner, keeping the user's edits (the next save
   * overwrites the on-disk change). */
  dismissDiskChanged(path: string): void {
    const doc = this.openFiles.find((f) => f.path === path);
    if (doc) doc.diskChanged = false;
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
    // A mutation may have added/removed the root Cargo.toml — re-probe so the
    // Build affordance follows (issue #69).
    void this.refreshIsRustProject();
  }

  /**
   * Re-probe whether the open project is a Rust project — a Cargo.toml at the
   * root (model studio::core Workbench.IsRustProject) — and update the reactive
   * signal the Build affordance reads. Fail-safe: any probe error reads as
   * not-Rust (Build hidden). Guarded against a project switch landing mid-probe,
   * so a stale result never overwrites the current project's state.
   */
  private async refreshIsRustProject(): Promise<void> {
    const root = this.rootPath;
    if (!root) {
      this.isRustProject = false;
      return;
    }
    // Latest-probe-wins: overlapping same-root probes (FileTree's 5s poll +
    // focus/visibility events vs a tree mutation) can resolve out of order, so
    // apply only the most recent probe's result — and only if the project
    // hasn't switched. Fail-safe (probe error → not Rust) lives in Superseder.
    const { value, current } = await this.rustProbe.run(
      () => cargoTomlExists(root),
      false,
    );
    if (current && this.rootPath === root) this.isRustProject = value;
  }

  /**
   * Count of open inline tree edits (a create or rename box). While any box is
   * open the SWR poll is suspended (FileTree) so the tree doesn't reload and
   * shift — or blur the box — out from under the user mid-type.
   */
  treeEditing = $state(0);

  beginTreeEdit() {
    this.treeEditing += 1;
  }

  endTreeEdit() {
    this.treeEditing = Math.max(0, this.treeEditing - 1);
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
   * Register the editor's command surface for the Edit menu (issue #59). The
   * editor sets this on mount and clears it (`null`) on destroy — the mirror of
   * setBufferFormatter.
   */
  setEditorCommands(bus: EditorCommandBus | null) {
    this.editorBus = bus;
    // Editor gone → no selection to act on (mirror of canEdit's bus gate).
    if (!bus) this.editorHasSelection = false;
  }

  /**
   * Report the active editor's selection state (the editor's update listener
   * on every selection change, and the tab-swap effect). Drives `canCopy`; a
   * state swap doesn't fire the update listener, so the editor reports it there
   * explicitly.
   */
  setEditorSelection(hasSelection: boolean) {
    this.editorHasSelection = hasSelection;
  }

  /**
   * Whether the Edit menu's editor commands can act: a text editor is mounted
   * and its active tab is editable text. Binary / still-loading tabs and the
   * no-file state disable Undo / Redo / Cut / Copy / Paste. Gated on the active
   * doc being editable text rather than DOM focus on purpose — opening the menu
   * moves focus off the editor, so a focus test would disable the very command
   * the user just reached for.
   */
  get canEdit(): boolean {
    return this.editorBus !== null && this.activeDoc?.kind === "text";
  }

  /**
   * Whether Edit → Cut / Copy can act: an editable text editor is active AND it
   * has a non-empty selection. Cut / Copy on a collapsed cursor are no-ops — the
   * editor's own context menu disables them the same way (Editor.svelte) — so
   * the menu disables them rather than offer a click that does nothing (issue
   * #59). Paste stays on `canEdit`: you can always paste into text.
   */
  get canCopy(): boolean {
    return this.canEdit && this.editorHasSelection;
  }

  // Edit-menu dispatchers (issue #59). Each is a no-op unless an editable text
  // editor is active — the menu items are disabled then, but the guard also
  // covers the keyboard / edge paths so a stray dispatch can never NPE.
  editUndo() {
    if (this.canEdit) this.editorBus?.undo();
  }
  editRedo() {
    if (this.canEdit) this.editorBus?.redo();
  }
  editCut() {
    if (this.canEdit) this.editorBus?.cut();
  }
  editCopy() {
    if (this.canEdit) this.editorBus?.copy();
  }
  editPaste() {
    if (this.canEdit) this.editorBus?.paste();
  }
  /** Open in-file find/replace over the active buffer (issue #73). Reached from
   * the Edit menu and the global ⌘F when the editor isn't focused; the editor's
   * own ⌘F keymap opens the panel directly. No-op unless an editable text editor
   * is active (model OpenFind). */
  editFind() {
    if (this.canEdit) this.editorBus?.find();
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
          // Saving resolves any external-change conflict (the user chose to
          // overwrite disk), so the stale-buffer banner clears (issue #40).
          doc.diskChanged = false;
          // Saved-file rescan for the Todos panel (model/studio/todos.pds
          // RefreshFile): splices only this file's entries.
          void todos.refreshFile(doc.path);
          // Re-anchor this file's bookmarks against the saved buffer (model
          // RemapFileBookmarks): signal the editor to write the marks that rode
          // the edits — new lines + snippets — back to the store.
          this.saved = { tick: (this.saved?.tick ?? 0) + 1, path: doc.path };
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

// Dev-only HMR continuity (issue #31): a Vite hot-update to any module in
// the language-intel import chain re-executes this one and would otherwise
// hand every component a fresh `AppState` — dropping the open project and
// its tabs, and orphaning the backend language servers the prior instance
// connected. Stash the singleton in `import.meta.hot.data` so the next
// instance reuses it; the open project survives — and the warm engine
// survives with it (lang + providers are preserved the same way in
// intel.svelte.ts / registry.ts), so no re-mount is needed.
// `import.meta.hot` is statically undefined in production builds, so this
// collapses to `new AppState()`.
export const app: AppState =
  (import.meta.hot?.data.app as AppState | undefined) ?? new AppState();
if (import.meta.hot) {
  import.meta.hot.dispose((data) => {
    data.app = app;
  });
}
