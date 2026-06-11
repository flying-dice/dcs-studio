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
  dcsCall,
  dcsStatus,
} from "./api";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { wsConnected } from "./dcs-ws";
import { lang } from "./lang/intel.svelte";
import type { Extension } from "@codemirror/state";

const EDITOR_THEME_KEY = "dcs.editorTheme";

function loadEditorThemeId(): string {
  if (typeof localStorage === "undefined") return DEFAULT_DARK_THEME;
  const id = localStorage.getItem(EDITOR_THEME_KEY);
  return id && EDITOR_THEMES.some((t) => t.id === id) ? id : DEFAULT_DARK_THEME;
}

function saveEditorThemeId(id: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(EDITOR_THEME_KEY, id);
  } catch {
    /* ignore quota errors */
  }
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
 */
export interface OpenDoc {
  path: string;
  name: string;
  docText: string;
  savedText: string;
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
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(recents));
  } catch {
    /* ignore quota / serialization errors */
  }
}

class AppState {
  // Chrome brightness (shadcn light/dark) — kept in sync with the editor theme.
  dark = $state(true);
  // Selected CodeMirror colour theme + the last theme used at each brightness,
  // so toggling dark/light restores your previous choice for that mode.
  editorThemeId = $state<string>(DEFAULT_DARK_THEME);
  lastDark = $state<string>(DEFAULT_DARK_THEME);
  lastLight = $state<string>(DEFAULT_LIGHT_THEME);

  constructor() {
    const id = loadEditorThemeId();
    const t = editorThemeById(id);
    this.editorThemeId = id;
    this.dark = t.dark;
    if (t.dark) this.lastDark = id;
    else this.lastLight = id;
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

  /** Open the native folder picker, then load the chosen folder as the project. */
  async openFolder() {
    const path = await pickFolder();
    if (!path) return;
    await this.openPath(path);
  }

  /** Load a project by absolute path (from the picker or a recent entry). */
  async openPath(path: string) {
    this.rootPath = path;
    this.rootName = await basename(path);
    this.openFiles = [];
    this.activePath = null;
    this.leftTool = "project";
    this.remember(path, this.rootName);
    // Project-opened announcement: mount the workspace into the language
    // engine (model/studio/lang.pds MountWorkspace). Fire-and-forget — an
    // engine failure is non-fatal and surfaces in the status bar.
    void lang.mountWorkspace(path);
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

  /** Return to the welcome screen without quitting. */
  closeProject() {
    this.rootPath = null;
    this.rootName = "";
    this.openFiles = [];
    this.activePath = null;
    lang.reset();
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
   * Where the editor should land once the next file finishes loading
   * (1-based line/column, UTF-16 columns) — set when a Problems entry is
   * opened, consumed by the editor, then cleared.
   */
  pendingJump = $state<{ line: number; col: number } | null>(null);

  /**
   * Open a file (model `OpenFile`): an already-open tab is re-activated
   * as-is — pending edits and undo history intact; otherwise a fresh tab is
   * appended and activated. The editor loads its text from disk on first
   * activation and reports it via `onDocLoaded`.
   */
  openFile(path: string, name: string, jumpTo?: { line: number; col: number }) {
    this.pendingJump = jumpTo ?? null;
    const existing = this.openFiles.find((f) => f.path === path);
    if (existing) {
      this.activePath = path;
      return;
    }
    this.openFiles.push({ path, name, docText: "", savedText: "" });
    this.activePath = path;
  }

  /** Make an already-open tab the active one (model `ActivateTab`). */
  activateFile(path: string) {
    if (this.openFiles.some((f) => f.path === path)) this.activePath = path;
  }

  /**
   * Close a tab (model `CloseFile`): a dirty tab needs confirmation before
   * its edits are discarded; closing the active tab activates a neighbour,
   * and closing the last tab returns to the no-file-open state.
   */
  closeFile(path: string) {
    const idx = this.openFiles.findIndex((f) => f.path === path);
    if (idx < 0) return;
    const tab = this.openFiles[idx];
    if (tab.docText !== tab.savedText) {
      const confirmed = this.confirmDiscard(tab.name);
      if (!confirmed) return;
    }
    this.openFiles.splice(idx, 1);
    if (this.activePath === path) {
      const neighbour = this.openFiles[idx] ?? this.openFiles[idx - 1];
      this.activePath = neighbour?.path ?? null;
    }
  }

  /** Close the active tab, if any (File → Close Editor, tab × button). */
  closeActiveFile() {
    if (this.activePath) this.closeFile(this.activePath);
  }

  /** Ask the developer before discarding a dirty tab (model `ConfirmDiscard`). */
  private confirmDiscard(name: string): boolean {
    if (typeof window === "undefined" || typeof window.confirm !== "function") {
      return true;
    }
    return window.confirm(`${name} has unsaved changes. Close it and discard them?`);
  }

  /** Called by the editor once a file's contents have loaded from disk. */
  onDocLoaded(path: string, text: string) {
    const doc = this.openFiles.find((f) => f.path === path);
    if (!doc) return;
    doc.savedText = text;
    doc.docText = text;
  }

  /** Called by the editor on every user edit to the tab for `path`. */
  onDocEdited(path: string, text: string) {
    const doc = this.openFiles.find((f) => f.path === path);
    if (doc) doc.docText = text;
  }

  /**
   * Persist the ACTIVE tab's buffer to the ACTIVE tab's path — never any
   * other tab's (model `SaveFile`). No-op when clean or already saving.
   */
  async saveFile() {
    const doc = this.activeDoc;
    if (!doc || doc.docText === doc.savedText || this.saving) return;
    this.saving = true;
    try {
      await writeTextFile(doc.path, doc.docText);
      doc.savedText = doc.docText;
    } finally {
      this.saving = false;
    }
  }

  /** Open the tool window in a stripe, or collapse it when already open. */
  toggleTool(stripe: "left" | "right" | "bottom", id: string) {
    const key = `${stripe}Tool` as const;
    this[key] = this[key] === id ? null : id;
  }
}

export const app = new AppState();
