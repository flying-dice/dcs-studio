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
  createProject as scaffoldProject,
  dcsCall,
  dcsStatus,
} from "./api";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { wsConnected } from "./dcs-ws";
import { lang } from "./lang/intel.svelte";
import { templateById } from "./templates";
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

  // Active editor document. `savedText` is the on-disk baseline; `docText` is
  // the live editor buffer. They diverge while there are unsaved edits.
  filePath = $state<string | null>(null);
  fileName = $state<string>("");
  docText = $state("");
  savedText = $state("");
  saving = $state(false);

  /** Whether the open document has unsaved edits. */
  get dirty(): boolean {
    return !!this.filePath && this.docText !== this.savedText;
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
    this.filePath = null;
    this.fileName = "";
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
    const template = templateById(templateId);
    const path = await scaffoldProject(parent, name, template.files(name));
    await this.openPath(path);
    return path;
  }

  /** Return to the welcome screen without quitting. */
  closeProject() {
    this.rootPath = null;
    this.rootName = "";
    this.filePath = null;
    this.fileName = "";
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

  openFile(path: string, name: string) {
    this.filePath = path || null;
    this.fileName = name;
    // Reset the document baseline; the editor refills it once the file loads.
    this.docText = "";
    this.savedText = "";
  }

  /** Called by the editor once a file's contents have loaded from disk. */
  onDocLoaded(text: string) {
    this.savedText = text;
    this.docText = text;
  }

  /** Called by the editor on every user edit. */
  onDocEdited(text: string) {
    this.docText = text;
  }

  /** Persist the active document to disk. No-op when clean or unsaved-able. */
  async saveFile() {
    if (!this.filePath || !this.dirty || this.saving) return;
    this.saving = true;
    try {
      await writeTextFile(this.filePath, this.docText);
      this.savedText = this.docText;
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
