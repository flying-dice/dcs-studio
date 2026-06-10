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
} from "./api";
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

  toggleLeft(id: string) {
    this.leftTool = this.leftTool === id ? null : id;
  }
  toggleRight(id: string) {
    this.rightTool = this.rightTool === id ? null : id;
  }
  toggleBottom(id: string) {
    this.bottomTool = this.bottomTool === id ? null : id;
  }
}

export const app = new AppState();
