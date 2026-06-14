// The language-intelligence extension point (model/studio/lang.pds).
//
// LSP-shaped: every engine is a hosted language server reached over IPC, so
// the queries are async over a mounted workspace.
//
// The DTO shapes below are the ENGINE-AGNOSTIC contract: hand-declared so
// each engine (dcs-lua's `lua-analyzer`, rust-analyzer) can implement
// `LanguageProvider` without the consumer depending on any one engine's
// wire types — TypeScript's structural typing is the conformance check.

/** One workspace source — the file-system port's unit. */
export interface SourceFile {
  path: string;
  text: string;
}

/** Maps workspace files to a DCS environment profile by glob. */
export interface ProfileRule {
  glob: string;
  profile: string;
}

/**
 * One finding: byte span plus 1-based line/column endpoints, so the
 * editor places squiggles without re-indexing the source.
 */
export interface Diagnostic {
  path: string;
  /** `"error" | "warning" | "info"`. */
  severity: string;
  /** Stable code, e.g. `LUA-E102` (dcs-lua-ls SPEC.md §3.1). */
  code: string;
  /** Article URL the code resolves to; empty when none exists. */
  code_description: string;
  message: string;
  start: number;
  end: number;
  start_line: number;
  start_col: number;
  end_line: number;
  end_col: number;
}

/** One outline entry; `kind` is `"function" | "variable"`. */
export interface DocumentSymbol {
  name: string;
  kind: string;
  start: number;
  end: number;
  selection_start: number;
  selection_end: number;
  children: DocumentSymbol[];
}

/** One foldable region, in byte offsets; the editor folds by line. */
export interface FoldingRange {
  start: number;
  end: number;
}

/** One completion suggestion. */
export interface CompletionItem {
  label: string;
  kind: string;
  detail: string;
}

/** Markdown hover card. */
export interface Hover {
  title: string;
  body: string;
}

/** A go-to-definition target. */
export interface Location {
  path: string;
  start: number;
  end: number;
}

/**
 * One inferred-type inlay hint: a `: <type>` label the editor draws as
 * ghost text after the byte `offset` (the end of the bound name).
 */
export interface InlayHint {
  offset: number;
  label: string;
  /** LSP inlay-hint kind; currently always `"Type"`. */
  kind: string;
}

/**
 * Lifecycle state of a language provider.
 * - `"off"` — never mounted (initial state, project closed)
 * - `"not-applicable"` — provider has no work in this project (e.g. no
 *   Cargo.toml for rust-analyzer); expected and silent in the UI
 * - `"loading"` — connecting / initialising
 * - `"ready"` — operational
 * - `"disabled"` — project IS applicable but provider can't start (e.g.
 *   binary not installed); shown as a warning in the UI
 * - `"failed"` — crashed or unrecoverable error
 */
export type ProviderStatus =
  | "off"
  | "not-applicable"
  | "loading"
  | "ready"
  | "disabled"
  | "failed";

/**
 * A tooling-availability notice: emitted when a provider is `"disabled"`
 * (binary not found) or `"failed"` (crashed). Surfaced in the Problems
 * panel above file diagnostics so the developer sees why diagnostics are
 * missing without hunting the status bar tooltip.
 */
export interface ProviderNotice {
  /** Provider id, e.g. `"rust-analyzer"`. */
  providerId: string;
  severity: "error" | "warning";
  /** Human-readable explanation. */
  message: string;
  /** Optional actionable hint, e.g. an install command to copy-paste. */
  hint?: string;
}

/**
 * Every method is async: each engine is a backend-hosted language server
 * reached over IPC (decisions/005, revised by issue #32).
 */
export interface LanguageProvider {
  /** Stable identifier, e.g. `"dcs-lua"`. */
  id: string;
  /** Lowercase file suffixes this provider handles, e.g. `[".lua"]`. */
  extensions: string[];
  /** Current lifecycle state; implementations that track it expose it here. */
  readonly status?: ProviderStatus;

  /**
   * Load the engine and seed it with the workspace. `root` is the
   * workspace root path: hosted servers that index the project themselves
   * (lua-analyzer, rust-analyzer) pass it on as `rootUri`. Resolves once
   * queries are live; rejects
   * when the engine cannot load (the IDE stays usable —
   * model/studio/lang.pds `EngineFailureIsNonFatal`).
   */
  mount(files: SourceFile[], rules: ProfileRule[], root: string): Promise<void>;

  /**
   * Create or replace one source (edits, saves, generated files).
   * Resolves once the engine's findings for the file are current.
   */
  setSource(path: string, text: string): Promise<void>;
  /** Drop one source (file deleted or regenerated away). */
  removeSource(path: string): Promise<void>;

  /** All current findings across the mounted workspace. */
  diagnostics(): Promise<Diagnostic[]>;
  /**
   * Optional push channel: `cb` runs whenever new findings land outside a
   * query (an LSP publishDiagnostics after `setSource` already resolved —
   * rust-analyzer's first index can lag well past the publish grace).
   * Consumers re-pull `diagnostics()` so slow findings still surface.
   */
  onDiagnostics?(cb: () => void): void;
  /**
   * Optional progress push: `cb` fires with the current background task
   * label while the server is busy (indexing, cargo check, …), and with
   * `null` once all active tasks finish. Consumers drive the status-bar
   * chip animation (model `ProgressFeedback`).
   */
  onProgress?(cb: (message: string | null) => void): void;
  /** The declaration outline of one file. */
  documentSymbols(path: string): Promise<DocumentSymbol[]>;
  /** Foldable regions of one file (offsets into the document text). */
  foldingRanges(path: string): Promise<FoldingRange[]>;
  /** Suggestions at a cursor offset. */
  complete(path: string, offset: number): Promise<CompletionItem[]>;
  /** Hover card for the symbol at an offset. */
  hover(path: string, offset: number): Promise<Hover | null>;
  /** Definition site of the symbol at an offset. */
  definition(path: string, offset: number): Promise<Location | null>;
  /**
   * Inferred-type inlay hints for one file, drawn as ghost text on
   * unannotated local bindings. Optional: a provider without inferred-type
   * support (rust-analyzer is hosted; some engines lack it) may omit it.
   */
  inlayHints?(path: string): Promise<InlayHint[]>;
}
