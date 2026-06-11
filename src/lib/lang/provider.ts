// The language-intelligence extension point (model/studio/lang.pds).
//
// LSP-shaped and transport-free: engines run embedded (wasm in this
// webview), so providers expose synchronous queries over a mounted
// workspace — no process, no JSON-RPC.
//
// The DTO shapes below are the ENGINE-AGNOSTIC contract: hand-declared so
// a second engine can implement `LanguageProvider` without depending on
// any one engine's generated types. The dcs-lua wasm engine's tsify
// output is structurally identical, so it satisfies these by assignment —
// TypeScript's structural typing is the conformance check.

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
 * Every method is async so one contract spans both transports: the
 * backend-hosted LSP over IPC (packaged app) and the in-page wasm engine
 * (browser fallback) — decisions/005.
 */
export interface LanguageProvider {
  /** Stable identifier, e.g. `"dcs-lua"`. */
  id: string;
  /** Lowercase file suffixes this provider handles, e.g. `[".lua"]`. */
  extensions: string[];

  /**
   * Load the engine and seed it with the workspace. `root` is the
   * workspace root path: providers whose servers index the project
   * themselves (rust-analyzer) pass it on as `rootUri`; embedded engines
   * fed file-by-file ignore it. Resolves once queries are live; rejects
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
}
