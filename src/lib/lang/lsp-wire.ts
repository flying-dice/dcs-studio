// LSP wire shapes and conversions shared by every hosted-server provider
// (lua-analyzer, rust-analyzer). LSP speaks line + UTF-16 character; JS strings
// are UTF-16, so document offsets convert exactly via line starts — no
// byte math, and squiggles stay precise on non-ASCII lines.

import { lineStarts } from "./offsets";
import { canonicalPath } from "../paths";
import type {
  CompletionItem,
  Diagnostic,
  DocumentSymbol,
  Hover,
  Location,
  TextEdit,
  WorkspaceEdit,
} from "./provider";

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspWireDiagnostic {
  range: LspRange;
  severity?: number;
  code?: string | number;
  codeDescription?: { href?: string };
  message: string;
}

/** Hierarchical `DocumentSymbol` as servers like dcs-lua-ls send it. */
export interface LspWireSymbol {
  name: string;
  kind: number;
  range: LspRange;
  selectionRange: LspRange;
  children?: LspWireSymbol[];
}

/** Flat `SymbolInformation` — what rust-analyzer returns by default. */
export interface LspWireSymbolInformation {
  name: string;
  kind: number;
  location: { uri: string; range: LspRange };
}

export function pathToUri(path: string): string {
  return `file:///${path.replace(/\\/g, "/").replace(/^\//, "")}`;
}

export function uriToPath(uri: string): string {
  let path = decodeURIComponent(uri.replace(/^file:\/\/\//, ""));
  if (!path.startsWith("/") && !/^[A-Za-z]:/.test(path)) path = `/${path}`;
  // Canonicalise so a server's lower-case drive letter (rust-analyzer emits
  // `file:///c:/…`) matches the file tree's upper-case one — otherwise the
  // tab opened from the tree and this finding's path are two identities
  // (model/studio/core.pds CanonicalPath, OpenFileHasOneIdentity).
  return canonicalPath(path.replace(/\//g, "\\"));
}

export function lineStart(starts: number[], line: number): number {
  return starts[Math.min(line, starts.length - 1)];
}

export function lineEnd(text: string, starts: number[], line: number): number {
  const next = line + 1 < starts.length ? starts[line + 1] - 1 : text.length;
  return next;
}

export function positionToOffset(
  starts: number[],
  position: LspPosition,
): number {
  return lineStart(starts, position.line) + position.character;
}

/** Document offset → LSP position: the line owning the last start <= offset. */
export function offsetToPosition(
  starts: number[],
  offset: number,
): LspPosition {
  // Largest line with starts[line] <= offset.
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return { line: low, character: offset - starts[low] };
}

export function convertDiagnostic(
  wire: LspWireDiagnostic,
  path: string,
  starts: number[],
): Diagnostic {
  return {
    path,
    severity:
      wire.severity === 2 ? "warning" : wire.severity === 1 ? "error" : "info",
    code: String(wire.code ?? ""),
    code_description: wire.codeDescription?.href ?? "",
    message: wire.message,
    start: positionToOffset(starts, wire.range.start),
    end: positionToOffset(starts, wire.range.end),
    start_line: wire.range.start.line + 1,
    start_col: wire.range.start.character + 1,
    end_line: wire.range.end.line + 1,
    end_col: wire.range.end.character + 1,
  };
}

export function convertSymbol(
  wire: LspWireSymbol,
  text: string,
): DocumentSymbol {
  const starts = lineStarts(text);
  return {
    name: wire.name,
    // LSP SymbolKind: 12 = Function, everything else we emit is Variable.
    kind: wire.kind === 12 ? "function" : "variable",
    start: positionToOffset(starts, wire.range.start),
    end: positionToOffset(starts, wire.range.end),
    selection_start: positionToOffset(starts, wire.selectionRange.start),
    selection_end: positionToOffset(starts, wire.selectionRange.end),
    children: (wire.children ?? []).map((child) => convertSymbol(child, text)),
  };
}

/**
 * `textDocument/hover` contents in every shape the spec allows: a bare
 * string, a `MarkupContent`/`MarkedString` object, or an array of these.
 */
export type LspWireHoverContents =
  | string
  | { kind?: string; language?: string; value: string }
  | (string | { kind?: string; language?: string; value: string })[];

export interface LspWireHover {
  contents: LspWireHoverContents;
}

/** Flatten any allowed `contents` shape into one markdown string. */
function hoverMarkdown(contents: LspWireHoverContents): string {
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) {
    return contents
      .map((part) => (typeof part === "string" ? part : part.value))
      .filter((part) => part.trim() !== "")
      .join("\n\n");
  }
  return contents.value;
}

/**
 * Wire hover → our card. LSP hover is a MarkupContent markdown blob; every
 * hosted server wraps the signature in a fenced code block (lua-analyzer's
 * ```lua, rust-analyzer's ```rust) followed by prose. We render that markdown
 * verbatim as the card body — the renderer turns the fences into styled code
 * blocks — so there is no title line to reconstruct downstream. The card's
 * `title` stays empty for LSP hovers; only the body is rendered.
 */
export function convertHover(wire: LspWireHover | null): Hover | null {
  if (!wire) return null;
  const markdown = hoverMarkdown(wire.contents).trim();
  return markdown === "" ? null : { title: "", body: markdown };
}

/** One `textDocument/completion` item. `kind` is the numeric LSP
 * `CompletionItemKind`; `insertTextFormat` is `2` for a snippet, `1`/absent for
 * plain text; `documentation` is a markdown string or a `MarkupContent`. */
export interface LspWireCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | { kind?: string; value: string };
  insertText?: string;
  insertTextFormat?: number;
}

/** LSP `CompletionItemKind` → our kind string. The engine emits only Function,
 * Field, and Variable; any other kind a hosted server returns maps to variable
 * (the catch-all, mirroring `convertSymbol`'s SymbolKind handling). */
function completionKind(kind: number | undefined): string {
  // CompletionItemKind: Function = 3, Field = 5, Variable = 6.
  if (kind === 3) return "function";
  if (kind === 5) return "field";
  return "variable";
}

/** Flatten LSP `documentation` (a bare string or a `MarkupContent`) to one
 * markdown string — empty when the item carries no doc run. */
function completionDoc(doc: LspWireCompletionItem["documentation"]): string {
  if (!doc) return "";
  return typeof doc === "string" ? doc : doc.value;
}

/** Wire completion item → our DTO. `insertText` falls back to the label and the
 * format to plaintext, so an item is always insertable even from a server that
 * omits them. */
export function convertCompletionItem(
  wire: LspWireCompletionItem,
): CompletionItem {
  return {
    label: wire.label,
    kind: completionKind(wire.kind),
    detail: wire.detail ?? "",
    documentation: completionDoc(wire.documentation),
    insertText: wire.insertText ?? wire.label,
    // InsertTextFormat: Snippet = 2, PlainText = 1.
    insertTextFormat: wire.insertTextFormat === 2 ? "snippet" : "plaintext",
  };
}

/** A `textDocument/definition` / `references` result element. */
export interface LspWireLocation {
  uri: string;
  range: LspRange;
}

/** A `LocationLink` — what rust-analyzer sends when the client declares
 * `definition.linkSupport`. We don't, but normalise defensively. */
export interface LspWireLocationLink {
  targetUri: string;
  targetSelectionRange: LspRange;
  targetRange?: LspRange;
}

export interface LspWireTextEdit {
  range: LspRange;
  newText: string;
}

/** A `WorkspaceEdit` in its `changes` form (uri → edits). */
export interface LspWireWorkspaceEdit {
  changes?: Record<string, LspWireTextEdit[]>;
}

/** Normalise a definition/references element (plain `Location` or
 * `LocationLink`) to `{ uri, range }`. */
function asLocation(
  wire: LspWireLocation | LspWireLocationLink,
): LspWireLocation {
  if ("targetUri" in wire) {
    return { uri: wire.targetUri, range: wire.targetSelectionRange };
  }
  return wire;
}

/** Wire location → our `Location` (offsets are UTF-16, against the TARGET
 * file's text, supplied by `textFor` — it may differ from the queried file). */
export function convertLocation(
  wire: LspWireLocation | LspWireLocationLink,
  textFor: (path: string) => string,
): Location {
  const { uri, range } = asLocation(wire);
  const path = uriToPath(uri);
  const starts = lineStarts(textFor(path));
  return {
    path,
    start: positionToOffset(starts, range.start),
    end: positionToOffset(starts, range.end),
  };
}

/** Wire `WorkspaceEdit.changes` → our flat `WorkspaceEdit`; offsets convert
 * against each affected file's text (`textFor`). */
export function convertWorkspaceEdit(
  wire: LspWireWorkspaceEdit | null,
  textFor: (path: string) => string,
): WorkspaceEdit {
  const edits: TextEdit[] = [];
  for (const [uri, list] of Object.entries(wire?.changes ?? {})) {
    const path = uriToPath(uri);
    const starts = lineStarts(textFor(path));
    for (const edit of list) {
      edits.push({
        path,
        start: positionToOffset(starts, edit.range.start),
        end: positionToOffset(starts, edit.range.end),
        newText: edit.newText,
      });
    }
  }
  return { edits };
}

/** Map one flat `SymbolInformation` onto our hierarchical shape. */
export function convertSymbolInformation(
  wire: LspWireSymbolInformation,
  text: string,
): DocumentSymbol {
  const starts = lineStarts(text);
  const start = positionToOffset(starts, wire.location.range.start);
  const end = positionToOffset(starts, wire.location.range.end);
  return {
    name: wire.name,
    kind: wire.kind === 12 ? "function" : "variable",
    start,
    end,
    selection_start: start,
    selection_end: end,
    children: [],
  };
}
