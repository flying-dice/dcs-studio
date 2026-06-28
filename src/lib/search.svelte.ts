// FindInFiles — the search overlay's state (model/studio/search.pds): the
// query and its match options, the published matches, and the in-flight /
// invalid-pattern / truncated signals. Project-wide search runs in Rust
// (dcs-studio-project::find via the search_in_files command); this store owns
// when it runs (debounced input), supersedes an in-flight search when the
// query changes (a generation counter, same shape as TodoScanner's), and holds
// the keyboard selection.
//
// Like TodoScanner, the dependency points one way: state.svelte.ts opens and
// resets the store; the overlay component reads the matches and owns the
// navigation (app.openFile) — the store never imports `app`. The backend is
// injectable (same seam convention) so /lab/search drives the real store,
// overlay, and navigation from a plain browser — no Tauri.

import { invoke, isTauri } from "@tauri-apps/api/core";

import { commandErrorMessage } from "$lib/utils";
import { moveSelection } from "$lib/search-nav";

/** One match (model SearchMatch). 1-based `line`; 1-based UTF-16 `column`
 * (the editor caret's coordinate); UTF-16 `length` (the highlight span);
 * `text` is the matched line, the row's label. */
export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  length: number;
  text: string;
}

/** A completed search (model SearchOutcome). */
export interface SearchOutcome {
  matches: SearchMatch[];
  truncated: boolean;
}

/** The match options (model SearchQuery, minus the query text). */
export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

/** The full query payload sent to the backend (model SearchQuery). */
export interface SearchQuery extends SearchOptions {
  query: string;
}

/** The search backend — the Tauri command in the app, injectable for the lab.
 * A malformed regex rejects (model SearchError); every other failure mode is
 * absorbed in Rust. */
export interface SearchBackend {
  search(root: string, query: SearchQuery): Promise<SearchOutcome>;
}

const tauriBackend: SearchBackend = {
  search: (root, query) => invoke<SearchOutcome>("search_in_files", { root, query }),
};

/** Input debounce before a search fires — long enough to coalesce a burst of
 * keystrokes, short enough to feel live (issue #68 NFR ~150–250 ms). */
export const SEARCH_DEBOUNCE_MS = 180;

export class FindInFiles {
  /** `available` is whether a desktop backend exists; the lab forces it true
   * so the browser e2e drives the real flow. */
  constructor(
    private readonly backend: SearchBackend = tauriBackend,
    private readonly hasBackend: boolean = isTauri(),
  ) {}

  /** Whether the floating overlay is shown. */
  open = $state(false);
  /** The current query text. */
  query = $state("");
  caseSensitive = $state(false);
  wholeWord = $state(false);
  regex = $state(false);

  /** Published matches, path-then-line order. */
  matches = $state<SearchMatch[]>([]);
  /** Whether the result set hit the cap (drives the truncated notice). */
  truncated = $state(false);
  /** A malformed-regex message, or null when the pattern is valid. */
  invalidPattern = $state<string | null>(null);
  /** Whether a search is in flight. */
  searching = $state(false);
  /** The keyboard-selected row index into `matches`, or -1 for none. */
  selected = $state(-1);

  // The workspace root to search, captured when the overlay opens (same as
  // TodoScanner.root). Generation counter: a slow search for a stale query
  // must never clobber a newer one's results.
  private root: string | null = null;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** Whether search can run at all — false in a plain browser with no desktop
   * backend (the overlay shows the "requires the desktop app" state). */
  get available(): boolean {
    return this.hasBackend;
  }

  /** Open the overlay over the workspace at `root` (the Search button /
   * Ctrl+Shift+F). A no-op with no project open — there is nothing to search
   * (model: WorkspaceRoot is None). */
  openSearch(root: string | null): void {
    if (!root) return;
    this.root = root;
    this.open = true;
  }

  /** Close the overlay and cancel any pending search. */
  dismiss(): void {
    this.open = false;
    this.cancelTimer();
  }

  /** Replace the query and (debounced) re-run. */
  setQuery(text: string): void {
    this.query = text;
    this.schedule();
  }

  toggleCaseSensitive(): void {
    this.caseSensitive = !this.caseSensitive;
    this.schedule();
  }

  toggleWholeWord(): void {
    this.wholeWord = !this.wholeWord;
    this.schedule();
  }

  toggleRegex(): void {
    this.regex = !this.regex;
    this.schedule();
  }

  /** Move the keyboard selection (model: Up/Down over the result list). */
  move(delta: number): void {
    this.selected = moveSelection(this.selected, this.matches.length, delta);
  }

  /** The currently selected match, if any — the component opens it. */
  current(): SearchMatch | null {
    return this.matches[this.selected] ?? null;
  }

  /** Forget all state (project switch/close — same lifecycle as todos.reset). */
  reset(): void {
    this.generation++;
    this.cancelTimer();
    this.root = null;
    this.open = false;
    this.query = "";
    this.caseSensitive = false;
    this.wholeWord = false;
    this.regex = false;
    this.matches = [];
    this.truncated = false;
    this.invalidPattern = null;
    this.searching = false;
    this.selected = -1;
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(): void {
    this.cancelTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, SEARCH_DEBOUNCE_MS);
  }

  /** Run the search now (model RunSearch). A blank query clears results
   * without walking; no project open is a no-op; a malformed regex publishes
   * an inline hint instead of results. */
  async run(): Promise<void> {
    const query = this.query;
    // Bump the generation up front so a slow in-flight search for a previous
    // query can never land after a newer run — including clearing the box,
    // which must supersede an in-flight walk, not just visually replace it.
    const generation = ++this.generation;
    if (query.trim() === "") {
      this.publish({ matches: [], truncated: false });
      this.invalidPattern = null;
      this.searching = false;
      return;
    }
    const root = this.root;
    if (!root || !this.hasBackend) return;

    this.searching = true;
    try {
      const outcome = await this.backend.search(root, {
        query,
        caseSensitive: this.caseSensitive,
        wholeWord: this.wholeWord,
        regex: this.regex,
      });
      if (generation !== this.generation) return; // superseded
      this.publish(outcome);
      this.invalidPattern = null;
    } catch (error) {
      if (generation !== this.generation) return; // superseded
      this.matches = [];
      this.truncated = false;
      this.selected = -1;
      this.invalidPattern = commandErrorMessage(error);
    } finally {
      if (generation === this.generation) this.searching = false;
    }
  }

  private publish(outcome: SearchOutcome): void {
    this.matches = outcome.matches;
    this.truncated = outcome.truncated;
    this.selected = outcome.matches.length > 0 ? 0 : -1;
  }
}

/** The app-wide instance (the lab builds its own with a fake backend). */
export const find = new FindInFiles();
