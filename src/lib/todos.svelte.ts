// TodoScanner — the Todos tool window's state (model/studio/todos.pds):
// workspace comment-tag entries, refreshed on project open (full scan),
// after a save (per-file SPLICE — drop the file's old entries, insert its
// fresh ones, leave every other file's untouched), and manually from the
// panel's refresh button.
//
// A separate singleton from `app` for the same reason as `lang`: the
// dependency points one way — state.svelte.ts announces project-opened and
// file-saved; the panel reads entries here. The scan itself runs in Rust
// (`dcs-studio-project::todos` via the scan_todos / scan_file_todos
// commands); the scanner is injectable (same seam convention as IntelFs and
// the Editor's readFile) so /lab/todos drives the real store from a plain
// browser — no Tauri.

import { invoke } from "@tauri-apps/api/core";

/** One scanned comment-tag hit (1-based line/column; column in UTF-16
 * code units — the editor caret's coordinates). */
export interface TodoEntry {
  path: string;
  line: number;
  column: number;
  tag: string;
  text: string;
}

/** The default tag set; the repo's `TODO: clean-code - <score> - <CAT>:`
 * skill markers surface via `TODO`. */
export const DEFAULT_TAGS = ["TODO", "FIXME", "HACK", "XXX"];

/** The scan backend — Tauri commands in the app, injectable for the lab. */
export interface TodoScanFns {
  scan(root: string, tags: string[]): Promise<TodoEntry[]>;
  scanFile(path: string, tags: string[]): Promise<TodoEntry[]>;
}

const tauriScanner: TodoScanFns = {
  scan: (root, tags) => invoke<TodoEntry[]>("scan_todos", { root, tags }),
  scanFile: (path, tags) => invoke<TodoEntry[]>("scan_file_todos", { path, tags }),
};

function byPathThenLine(a: TodoEntry, b: TodoEntry): number {
  return a.path.localeCompare(b.path) || a.line - b.line;
}

export class TodoScanner {
  constructor(private readonly scanner: TodoScanFns = tauriScanner) {}

  /** Workspace entries, sorted by path then line. */
  entries = $state<TodoEntry[]>([]);
  /** Whether a full scan is in flight (the refresh button spins). */
  scanning = $state(false);

  /** The tracked workspace root; null while no project is open. */
  private root: string | null = null;
  // Generation counter (same shape as LangIntel.mountGeneration): a slow
  // scan for a previous workspace must never clobber the newer one's
  // entries, and a full rescan supersedes in-flight per-file splices.
  private generation = 0;

  /** Full rescan on project open (model `RefreshAll`). A failed scan is
   * non-fatal — the panel just shows nothing. */
  async refreshAll(root: string): Promise<void> {
    this.root = root;
    const generation = ++this.generation;
    this.scanning = true;
    try {
      const found = await this.scanner.scan(root, DEFAULT_TAGS);
      if (generation !== this.generation) return; // superseded
      this.entries = [...found].sort(byPathThenLine);
    } catch (error) {
      console.error("todo scan failed:", error);
      if (generation === this.generation) this.entries = [];
    } finally {
      if (generation === this.generation) this.scanning = false;
    }
  }

  /** Per-file rescan after a save (model `RefreshFile`): SPLICE — drop
   * only `path`'s old entries, insert its fresh ones, keep every other
   * file's entries untouched. */
  async refreshFile(path: string): Promise<void> {
    if (this.root === null) return; // no workspace tracked
    const generation = this.generation;
    let fresh: TodoEntry[];
    try {
      fresh = await this.scanner.scanFile(path, DEFAULT_TAGS);
    } catch (error) {
      console.error(`todo rescan of ${path} failed:`, error);
      return; // leave the panel as it was
    }
    if (generation !== this.generation) return; // a full rescan won
    const kept = this.entries.filter((e) => e.path !== path);
    this.entries = [...kept, ...fresh].sort(byPathThenLine);
  }

  /** Manual refresh (model `RefreshManually`): full rescan of the tracked
   * root; a no-op while no workspace is open. */
  async refreshManually(): Promise<void> {
    if (this.root === null) return;
    await this.refreshAll(this.root);
  }

  /** Forget the workspace (project closed). */
  reset(): void {
    this.generation++;
    this.root = null;
    this.entries = [];
    this.scanning = false;
  }
}

/** The app-wide instance (the lab builds its own with a fake scanner). */
export const todos = new TodoScanner();
