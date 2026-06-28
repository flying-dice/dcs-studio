// SearchSession — the project-wide find-in-files overlay's state
// (model/studio/core.pds Workbench: OpenSearch / FindInFiles / OpenSearchHit,
// issue #68). The search itself runs in Rust
// (`dcs-studio-project::find` via the `find_in_files` command); this store owns
// the overlay's open/query/options/results/selection and when the search runs.
//
// A separate singleton from `app` (like `todos` and `lang`): +page.svelte opens
// it with the active root and the overlay reads from it. The backend is
// injectable (same seam convention as TodoScanner) so /lab/search drives the
// real store with an in-memory backend from a plain browser — no Tauri.

import { invoke, isTauri } from "@tauri-apps/api/core";

/** Match options for a search — mirrors `studio::core::SearchOptions` and the
 * Rust `FindOptions` (camelCase wire shape). */
export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

/** One search hit (model `SearchHit` / Rust `FindMatch`). `line`/`column` are
 * 1-based; `column` and `length` count UTF-16 code units — the editor caret's
 * coordinates plus the matched span the overlay highlights. `text` is the
 * matching line. */
export interface FindMatch {
  path: string;
  line: number;
  column: number;
  length: number;
  text: string;
}

/** The outcome of a search (model `SearchResult` / Rust `FindResult`): the hits
 * (capped) and whether the cap truncated them. */
export interface FindResult {
  matches: FindMatch[];
  truncated: boolean;
}

/** The search backend — the Tauri command in the app, injectable for the lab.
 * Rejects with `{ message }` (the Rust `FindError`) on an invalid regex. */
export interface SearchBackend {
  find(root: string, query: string, options: SearchOptions): Promise<FindResult>;
}

const tauriBackend: SearchBackend = {
  find: (root, query, options) =>
    invoke<FindResult>("find_in_files", { root, query, options }),
};

/** Input debounce so a multi-GiB workspace isn't walked on every keystroke
 * (NFR ~150–250 ms). */
const DEBOUNCE_MS = 200;

/** The overlay's lifecycle state. Blank vs results vs no-results is derived by
 * the overlay from `idle` + the query + `matches.length`. */
export type SearchStatus = "idle" | "searching" | "error" | "desktop-only";

function messageOf(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  return String(error);
}

export class SearchSession {
  /** Explicit backend (the lab) wins; otherwise the Tauri backend under the
   * desktop shell, or none in a plain browser (→ desktop-only). */
  constructor(private readonly injected: SearchBackend | null = null) {}

  /** Whether the floating overlay is shown. */
  open = $state(false);
  /** The query text. */
  query = $state("");
  /** The active match options. */
  options = $state<SearchOptions>({
    caseSensitive: false,
    wholeWord: false,
    regex: false,
  });
  /** The current hits (flat, sorted path→line→column). */
  matches = $state<FindMatch[]>([]);
  /** Whether the result cap truncated the hits (NFR: no silent truncation). */
  truncated = $state(false);
  /** Lifecycle status. */
  status = $state<SearchStatus>("idle");
  /** Invalid-pattern detail (shown when `status === "error"`). */
  errorMessage = $state("");
  /** Index into `matches` for keyboard navigation. */
  selectedIndex = $state(0);

  /** The tracked workspace root; null while no project is open. */
  private root: string | null = null;
  // Generation counter (same shape as TodoScanner): a slow search for a stale
  // query must never clobber a newer one's results.
  private generation = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  /** The usable backend, or null when search needs the desktop app. */
  private backend(): SearchBackend | null {
    if (this.injected) return this.injected;
    return isTauri() ? tauriBackend : null;
  }

  /** Open the overlay over `root` (model `OpenSearch`). No root ⇒ nothing to
   * search, so the overlay never opens. No backend ⇒ open but report that
   * search requires the desktop app. A standing query re-runs; otherwise the
   * overlay waits for input. */
  openOverlay(root: string | null): void {
    if (!root) return; // SearchNeedsOpenProject
    this.root = root;
    this.open = true;
    this.selectedIndex = 0;
    if (this.backend() === null) {
      this.status = "desktop-only"; // SearchRequiresDesktopApp
      this.matches = [];
      this.truncated = false;
      return;
    }
    if (this.query.trim() !== "") void this.run();
    else this.status = "idle";
  }

  /** Dismiss the overlay (model `HideSearchOverlay`); editor focus returns in
   * the component. */
  close(): void {
    // Supersede any in-flight search so its result can't publish into a closed
    // overlay and leave stale `matches` behind for the next open. (MR !76)
    this.generation++;
    this.open = false;
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /** Set the query and schedule a debounced search (model `FindInFiles`). */
  setQuery(query: string): void {
    this.query = query;
    this.scheduleRun();
  }

  toggleCaseSensitive(): void {
    this.options.caseSensitive = !this.options.caseSensitive;
    this.scheduleRun();
  }
  toggleWholeWord(): void {
    this.options.wholeWord = !this.options.wholeWord;
    this.scheduleRun();
  }
  toggleRegex(): void {
    this.options.regex = !this.options.regex;
    this.scheduleRun();
  }

  private scheduleRun(): void {
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.run();
    }, DEBOUNCE_MS);
  }

  /** Run the search now (model `FindInFiles`): empty query clears results; no
   * backend reports desktop-only; an invalid regex surfaces the inline hint;
   * otherwise publish the (possibly truncated) hits. A superseded run (the
   * query/options changed mid-flight) is discarded. */
  async run(): Promise<void> {
    const backend = this.backend();
    if (backend === null) {
      this.status = "desktop-only";
      this.matches = [];
      this.truncated = false;
      return;
    }
    const root = this.root;
    if (root === null) return;
    // Bump the generation BEFORE the empty-query branch so clearing the query
    // (like any new run) supersedes an in-flight search: a slow backend
    // resolving after the query was cleared must not publish stale hits.
    // Keyboard nav (move/selected/activate) acts on `matches` regardless of
    // what the overlay renders, so a stale list is user-reachable —
    // clear → ↓ → Enter would open a file for a query that is gone. (MR !76)
    const generation = ++this.generation;
    if (this.query.trim() === "") {
      this.matches = [];
      this.truncated = false;
      this.errorMessage = "";
      this.selectedIndex = 0;
      this.status = "idle";
      return;
    }
    this.status = "searching";
    const options: SearchOptions = {
      caseSensitive: this.options.caseSensitive,
      wholeWord: this.options.wholeWord,
      regex: this.options.regex,
    };
    try {
      const result = await backend.find(root, this.query, options);
      if (generation !== this.generation) return; // superseded
      // Re-sort by `localeCompare` so the flat order matches the overlay's
      // grouped display order (groupByFile sorts groups by localeCompare, which
      // can differ from the Rust byte-order sort) — keeping `selectedIndex`
      // aligned with the visible list for keyboard navigation.
      result.matches.sort(
        (a, b) =>
          a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column,
      );
      this.matches = result.matches;
      this.truncated = result.truncated;
      this.errorMessage = "";
      this.selectedIndex = 0;
      this.status = "idle";
    } catch (error) {
      if (generation !== this.generation) return; // superseded
      this.matches = [];
      this.truncated = false;
      this.errorMessage = messageOf(error);
      this.selectedIndex = 0;
      this.status = "error";
    }
  }

  /** Move the keyboard selection within bounds (Up/Down in the result list). */
  move(delta: number): void {
    if (this.matches.length === 0) return;
    const next = this.selectedIndex + delta;
    this.selectedIndex = Math.max(0, Math.min(this.matches.length - 1, next));
  }

  /** Point the selection at a specific flat index (click sync). */
  select(index: number): void {
    if (index >= 0 && index < this.matches.length) this.selectedIndex = index;
  }

  /** The currently selected hit, if any (Enter target). */
  selected(): FindMatch | null {
    return this.matches[this.selectedIndex] ?? null;
  }

  /** Forget the workspace and clear results (project closed). */
  reset(): void {
    this.generation++;
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.root = null;
    this.open = false;
    this.query = "";
    this.matches = [];
    this.truncated = false;
    this.errorMessage = "";
    this.selectedIndex = 0;
    this.status = "idle";
  }
}

/** The app-wide instance (the lab builds its own with an in-memory backend). */
export const search = new SearchSession();
