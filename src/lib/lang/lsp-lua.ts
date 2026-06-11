// The packaged-app Lua provider: `dcs-studio-cli lsp` hosted by the
// backend, spoken to over IPC (decisions/005). Implements the same
// LanguageProvider contract as the wasm fallback.
//
// Offsets: LSP positions are line + UTF-16 character; JS strings are
// UTF-16, so document offsets convert exactly via line starts — no byte
// math, and squiggles stay precise on non-ASCII lines.

import { invoke } from "@tauri-apps/api/core";
import { LspClient } from "./lsp-client";
import { lineStarts } from "./offsets";
import type {
  CompletionItem,
  Diagnostic,
  DocumentSymbol,
  FoldingRange,
  Hover,
  LanguageProvider,
  Location,
  ProfileRule,
  SourceFile,
} from "./provider";

interface LspPosition {
  line: number;
  character: number;
}

interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

const PUBLISH_TIMEOUT_MS = 3000;

export class LspLuaProvider implements LanguageProvider {
  readonly id = "dcs-lua";
  readonly extensions = [".lua"];

  private client: LspClient | null = null;
  private readonly texts = new Map<string, string>();
  private readonly versions = new Map<string, number>();
  private readonly findings = new Map<string, Diagnostic[]>();
  private readonly publishWaiters = new Map<string, () => void>();

  async mount(files: SourceFile[], _rules: ProfileRule[]): Promise<void> {
    if (!this.client) {
      const program = await invoke<string>("lsp_server_path");
      this.client = await LspClient.start("dcs-lua", program, ["lsp"]);
      this.client.onNotification("textDocument/publishDiagnostics", (params) =>
        this.onPublish(
          params as { uri: string; diagnostics: LspWireDiagnostic[] },
        ),
      );
      await this.client.request("initialize", {
        processId: null,
        // The IDE feeds files itself (it owns the file tree); no root walk.
        rootUri: null,
        capabilities: {},
      });
      await this.client.notify("initialized", {});
    }
    // Wholesale remount: close anything from a previous project.
    for (const path of [...this.texts.keys()]) {
      await this.client.notify("textDocument/didClose", {
        textDocument: { uri: pathToUri(path) },
      });
    }
    this.texts.clear();
    this.versions.clear();
    this.findings.clear();
    for (const file of files) {
      this.texts.set(file.path, file.text);
      this.versions.set(file.path, 1);
      await this.client.notify("textDocument/didOpen", {
        textDocument: {
          uri: pathToUri(file.path),
          languageId: "lua",
          version: 1,
          text: file.text,
        },
      });
    }
  }

  async setSource(path: string, text: string): Promise<void> {
    if (!this.client) return;
    this.texts.set(path, text);
    const published = this.nextPublish(path);
    if (this.versions.has(path)) {
      const version = (this.versions.get(path) ?? 1) + 1;
      this.versions.set(path, version);
      await this.client.notify("textDocument/didChange", {
        textDocument: { uri: pathToUri(path), version },
        contentChanges: [{ text }],
      });
    } else {
      this.versions.set(path, 1);
      await this.client.notify("textDocument/didOpen", {
        textDocument: {
          uri: pathToUri(path),
          languageId: "lua",
          version: 1,
          text,
        },
      });
    }
    await published; // findings current (or timed out) when we resolve
  }

  async removeSource(path: string): Promise<void> {
    if (!this.client) return;
    await this.client.notify("textDocument/didClose", {
      textDocument: { uri: pathToUri(path) },
    });
    this.texts.delete(path);
    this.versions.delete(path);
    this.findings.delete(path);
  }

  async diagnostics(): Promise<Diagnostic[]> {
    return [...this.findings.values()]
      .flat()
      .sort((a, b) => a.path.localeCompare(b.path) || a.start - b.start);
  }

  async documentSymbols(path: string): Promise<DocumentSymbol[]> {
    if (!this.client) return [];
    const text = this.texts.get(path) ?? "";
    const response = (await this.client.request("textDocument/documentSymbol", {
      textDocument: { uri: pathToUri(path) },
    })) as LspWireSymbol[] | null;
    return (response ?? []).map((symbol) => convertSymbol(symbol, text));
  }

  async foldingRanges(path: string): Promise<FoldingRange[]> {
    if (!this.client) return [];
    const text = this.texts.get(path) ?? "";
    const starts = lineStarts(text);
    const response = (await this.client.request("textDocument/foldingRange", {
      textDocument: { uri: pathToUri(path) },
    })) as { startLine: number; endLine: number }[] | null;
    return (response ?? []).map((range) => ({
      start: lineStart(starts, range.startLine),
      end: lineEnd(text, starts, range.endLine),
    }));
  }

  // Phase 2 ports — the server doesn't advertise these capabilities yet.
  async complete(_path: string, _offset: number): Promise<CompletionItem[]> {
    return [];
  }

  async hover(_path: string, _offset: number): Promise<Hover | null> {
    return null;
  }

  async definition(_path: string, _offset: number): Promise<Location | null> {
    return null;
  }

  // ---- diagnostics push ----------------------------------------------------

  private onPublish(params: {
    uri: string;
    diagnostics: LspWireDiagnostic[];
  }): void {
    const path = uriToPath(params.uri);
    const text = this.texts.get(path) ?? "";
    const starts = lineStarts(text);
    this.findings.set(
      path,
      params.diagnostics.map((d) => convertDiagnostic(d, path, starts)),
    );
    this.publishWaiters.get(path)?.();
    this.publishWaiters.delete(path);
  }

  /** Resolves on the next publish for `path`, or after a grace timeout. */
  private nextPublish(path: string): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, PUBLISH_TIMEOUT_MS);
      this.publishWaiters.set(path, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

// ---- wire shapes and conversions -------------------------------------------

interface LspWireDiagnostic {
  range: LspRange;
  severity?: number;
  code?: string | number;
  codeDescription?: { href?: string };
  message: string;
}

interface LspWireSymbol {
  name: string;
  kind: number;
  range: LspRange;
  selectionRange: LspRange;
  children?: LspWireSymbol[];
}

function pathToUri(path: string): string {
  return `file:///${path.replace(/\\/g, "/").replace(/^\//, "")}`;
}

function uriToPath(uri: string): string {
  let path = decodeURIComponent(uri.replace(/^file:\/\/\//, ""));
  if (!path.startsWith("/") && !/^[A-Za-z]:/.test(path)) path = `/${path}`;
  return path.replace(/\//g, "\\");
}

function lineStart(starts: number[], line: number): number {
  return starts[Math.min(line, starts.length - 1)];
}

function lineEnd(text: string, starts: number[], line: number): number {
  const next = line + 1 < starts.length ? starts[line + 1] - 1 : text.length;
  return next;
}

function positionToOffset(starts: number[], position: LspPosition): number {
  return lineStart(starts, position.line) + position.character;
}

function convertDiagnostic(
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

function convertSymbol(wire: LspWireSymbol, text: string): DocumentSymbol {
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
