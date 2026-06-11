/* tslint:disable */
/* eslint-disable */
/**
 * A go-to-definition target (Phase 2).
 */
export interface Location {
    path: string;
    start: number;
    end: number;
}

/**
 * Maps workspace files to a DCS environment profile by glob (SPEC.md §5).
 */
export interface ProfileRule {
    glob: string;
    profile: string;
}

/**
 * Markdown hover card (Phase 2).
 */
export interface Hover {
    title: string;
    body: string;
}

/**
 * One completion suggestion (Phase 2; the port exists so the contract is
 * stable from day one).
 */
export interface CompletionItem {
    label: string;
    kind: string;
    detail: string;
}

/**
 * One finding: byte span plus 1-based line/column endpoints, so the
 * editor places squiggles without re-indexing the source.
 */
export interface Diagnostic {
    path: string;
    /**
     * `\"error\" | \"warning\" | \"info\"`.
     */
    severity: string;
    /**
     * Stable code from the SPEC.md §3.1 registry.
     */
    code: string;
    /**
     * Article URL the code resolves to; empty when none exists.
     */
    code_description: string;
    message: string;
    start: number;
    end: number;
    start_line: number;
    start_col: number;
    end_line: number;
    end_col: number;
}

/**
 * One foldable region, in byte offsets; the editor folds by line.
 */
export interface FoldingRange {
    start: number;
    end: number;
}

/**
 * One outline entry; `kind` is `\"function\" | \"variable\"`.
 */
export interface DocumentSymbol {
    name: string;
    kind: string;
    start: number;
    end: number;
    selection_start: number;
    selection_end: number;
    children: DocumentSymbol[];
}

/**
 * One workspace source — the file-system port\'s unit.
 */
export interface SourceFile {
    path: string;
    text: string;
}


/**
 * The embedded language engine. JavaScript drives it through two ports:
 * the file system pushes sources in, the editor pulls answers out.
 */
export class IdeSession {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Suggestions at a cursor offset. Phase 2 — empty until resolution
     * lands; the port keeps the boundary contract stable.
     */
    complete(_path: string, _offset: number): CompletionItem[];
    /**
     * Definition site of the symbol at an offset. Phase 2.
     */
    definition(_path: string, _offset: number): Location | undefined;
    /**
     * All current findings across the mounted workspace.
     */
    diagnostics(): Diagnostic[];
    /**
     * The declaration outline of one file.
     */
    document_symbols(path: string): DocumentSymbol[];
    /**
     * Foldable regions of one file.
     */
    folding_ranges(path: string): FoldingRange[];
    /**
     * Hover card for the identifier at a byte offset: declaration kind
     * and signature, the doc run above the declaration, and the shallow
     * initializer-inferred type (lsp-core resolution).
     */
    hover(path: string, offset: number): Hover | undefined;
    /**
     * Seed the session with the workspace's Lua sources and profile rules.
     * Wholesale: any previously mounted workspace is replaced, so opening
     * a different project never leaks files across sessions.
     */
    mount(files: SourceFile[], rules: ProfileRule[]): void;
    constructor();
    /**
     * Drop one source (file deleted or regenerated away).
     */
    remove_source(path: string): void;
    /**
     * Create or replace one source (editor edits, saves, generated files).
     */
    set_source(path: string, text: string): void;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_idesession_free: (a: number, b: number) => void;
    readonly idesession_complete: (a: number, b: number, c: number, d: number) => [number, number];
    readonly idesession_definition: (a: number, b: number, c: number, d: number) => any;
    readonly idesession_diagnostics: (a: number) => [number, number];
    readonly idesession_document_symbols: (a: number, b: number, c: number) => [number, number];
    readonly idesession_folding_ranges: (a: number, b: number, c: number) => [number, number];
    readonly idesession_hover: (a: number, b: number, c: number, d: number) => any;
    readonly idesession_mount: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly idesession_new: () => number;
    readonly idesession_remove_source: (a: number, b: number, c: number) => void;
    readonly idesession_set_source: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_drop_slice: (a: number, b: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
