// LSP wire shapes and conversions shared by every hosted-server provider
// (lsp-lua, rust-analyzer). LSP speaks line + UTF-16 character; JS strings
// are UTF-16, so document offsets convert exactly via line starts — no
// byte math, and squiggles stay precise on non-ASCII lines.

import { lineStarts } from "./offsets";
import type { Diagnostic, DocumentSymbol } from "./provider";

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
  return path.replace(/\//g, "\\");
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
