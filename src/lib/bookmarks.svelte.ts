// Bookmark store — the Bookmarks tool window's state (model/studio/bookmarks.pds):
// per-project file:line marks a developer ties to meaningful spots, toggled from
// the editor gutter, listed in the left-rail panel, navigated on click, and
// persisted to localStorage keyed by the project's canonical root path.
//
// A separate singleton from `app` for the same reason as `todos` and `lang`: the
// dependency points one way — state.svelte.ts announces project-opened (load)
// and file-saved (re-anchor); the panel and the editor gutter read `entries`.
// Unlike Todos there is no workspace scan and nothing in Rust — bookmarks are
// explicit user marks held client-side, never written into the source.

import { canonicalPath } from "./paths";
import { writeLocalStorage } from "./local-storage";

/** One bookmark: a file, its 1-based line, and a snippet of that line's text
 *  (re-derived on save while open; the last-saved text once closed) — the
 *  panel's row label. */
export interface Bookmark {
  path: string;
  line: number;
  snippet: string;
}

/** localStorage key for a project's marks: keyed by the CANONICAL root path so
 *  one project's bucket never splits on Windows drive-letter / separator
 *  variance (the same footgun canonicalPath fixes for tab identity). */
const KEY_PREFIX = "dcs.bookmarks:";
const keyFor = (root: string): string => `${KEY_PREFIX}${canonicalPath(root)}`;

/** Longest snippet kept — a marked minified line must not bloat the bucket. */
const SNIPPET_MAX = 200;

/** The stored/displayed snippet for a line: trimmed, capped. */
export function snippetOf(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > SNIPPET_MAX ? trimmed.slice(0, SNIPPET_MAX) : trimmed;
}

function byPathThenLine(a: Bookmark, b: Bookmark): number {
  return a.path.localeCompare(b.path) || a.line - b.line;
}

/** Read a project's persisted marks; an absent or corrupt bucket restores
 *  nothing (model `ReadPersisted` — never fails the panel). */
function readPersisted(key: string): Bookmark[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (b): b is Bookmark =>
          typeof b?.path === "string" &&
          typeof b?.line === "number" &&
          typeof b?.snippet === "string",
      )
      .sort(byPathThenLine);
  } catch {
    return [];
  }
}

export class BookmarkStore {
  /** The open project's marks, sorted by path then line (model published set). */
  entries = $state<Bookmark[]>([]);

  /** The tracked project's localStorage key; null while no project is open. */
  private key: string | null = null;

  /** Restore a project's marks on open (model `LoadProject`), keyed by its
   *  canonical root. */
  load(root: string): void {
    this.key = keyFor(root);
    this.entries = readPersisted(this.key);
  }

  /** Forget the live set on project close (model `Reset`). */
  reset(): void {
    this.key = null;
    this.entries = [];
  }

  /** All bookmarked lines for `path` — the editor gutter's marks. */
  linesFor(path: string): number[] {
    return this.entries.filter((b) => b.path === path).map((b) => b.line);
  }

  /** Toggle the mark on `path:line` (model `ToggleBookmark`): add carrying
   *  `snippet`, or remove if already marked. Persisted immediately — an
   *  explicit user mark is not contingent on a later save. */
  toggle(path: string, line: number, snippet: string): void {
    const has = this.entries.some((b) => b.path === path && b.line === line);
    this.entries = has
      ? this.entries.filter((b) => !(b.path === path && b.line === line))
      : [...this.entries, { path, line, snippet }].sort(byPathThenLine);
    this.persist();
  }

  /** Remove a single mark (model `RemoveBookmark`). */
  remove(path: string, line: number): void {
    this.entries = this.entries.filter(
      (b) => !(b.path === path && b.line === line),
    );
    this.persist();
  }

  /** Clear every mark for the open project (model `ClearBookmarks`). */
  clear(): void {
    this.entries = [];
    this.persist();
  }

  /** Re-anchor one file's marks after a save (model `RemapFileBookmarks`):
   *  SPLICE — drop only `path`'s old marks, insert the re-mapped ones, leave
   *  every other file's marks untouched. */
  syncFile(path: string, marks: { line: number; snippet: string }[]): void {
    const kept = this.entries.filter((b) => b.path !== path);
    const fresh = marks.map((m) => ({ path, line: m.line, snippet: m.snippet }));
    this.entries = [...kept, ...fresh].sort(byPathThenLine);
    this.persist();
  }

  /** Serialize the live set under the tracked project key (model `Persist`);
   *  a no-op while no project is open. */
  private persist(): void {
    if (this.key === null) return;
    writeLocalStorage(this.key, JSON.stringify(this.entries));
  }
}

/** The app-wide instance (the lab builds its own). */
export const bookmarks = new BookmarkStore();
