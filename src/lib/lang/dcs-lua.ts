// The dcs-lua provider, transport-selected (decisions/005):
//
// - In the packaged app, language intelligence runs in the BACKEND — the
//   host spawns `dcs-studio-cli lsp` and we speak LSP over IPC.
// - In a plain browser (vite dev, Playwright) there is no Tauri IPC, so
//   the same engine loads as wasm in the page — the dual-path convention
//   established by `dcs-ws.ts`.
//
// Both implement the same LanguageProvider contract; everything above the
// registry is transport-blind.

import { isTauri } from "@tauri-apps/api/core";
import init, { IdeSession } from "$lib/dcs-lua-wasm/dcs_lua_ide";
import wasmUrl from "$lib/dcs-lua-wasm/dcs_lua_ide_bg.wasm?url";
import { LspLuaProvider } from "./lsp-lua";
import { ByteOffsets, lineStarts } from "./offsets";
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

/** Browser fallback: the engine compiled to wasm, in-page. The engine
 * emits byte offsets; everything converts to UTF-16 here (offsets.ts)
 * before the editor sees it. */
class WasmLuaProvider implements LanguageProvider {
  readonly id = "dcs-lua";
  readonly extensions = [".lua"];

  private session: IdeSession | null = null;
  private initPromise: Promise<void> | null = null;
  private readonly texts = new Map<string, string>();
  private readonly offsets = new Map<string, ByteOffsets>();

  private async ensureLoaded(): Promise<void> {
    this.initPromise ??= init({ module_or_path: wasmUrl }).then(() => {
      this.session = new IdeSession();
    });
    await this.initPromise;
  }

  private remember(path: string, text: string): void {
    this.texts.set(path, text);
    this.offsets.set(path, new ByteOffsets(text));
  }

  private toUtf16(path: string, byteOffset: number): number {
    return this.offsets.get(path)?.utf16(byteOffset) ?? byteOffset;
  }

  async mount(files: SourceFile[], rules: ProfileRule[]): Promise<void> {
    await this.ensureLoaded();
    this.texts.clear();
    this.offsets.clear();
    for (const file of files) this.remember(file.path, file.text);
    this.session?.mount(files, rules);
  }

  async setSource(path: string, text: string): Promise<void> {
    this.remember(path, text);
    this.session?.set_source(path, text);
  }

  async removeSource(path: string): Promise<void> {
    this.texts.delete(path);
    this.offsets.delete(path);
    this.session?.remove_source(path);
  }

  async diagnostics(): Promise<Diagnostic[]> {
    return (this.session?.diagnostics() ?? []).map((d) => {
      const text = this.texts.get(d.path) ?? "";
      const starts = lineStarts(text);
      const start = this.toUtf16(d.path, d.start);
      const end = this.toUtf16(d.path, d.end);
      return {
        ...d,
        start,
        end,
        start_col: start - (starts[d.start_line - 1] ?? 0) + 1,
        end_col: end - (starts[d.end_line - 1] ?? 0) + 1,
      };
    });
  }

  async documentSymbols(path: string): Promise<DocumentSymbol[]> {
    const convert = (symbol: DocumentSymbol): DocumentSymbol => ({
      ...symbol,
      start: this.toUtf16(path, symbol.start),
      end: this.toUtf16(path, symbol.end),
      selection_start: this.toUtf16(path, symbol.selection_start),
      selection_end: this.toUtf16(path, symbol.selection_end),
      children: symbol.children.map(convert),
    });
    return (this.session?.document_symbols(path) ?? []).map(convert);
  }

  async foldingRanges(path: string): Promise<FoldingRange[]> {
    return (this.session?.folding_ranges(path) ?? []).map((range) => ({
      start: this.toUtf16(path, range.start),
      end: this.toUtf16(path, range.end),
    }));
  }

  async complete(path: string, offset: number): Promise<CompletionItem[]> {
    return this.session?.complete(path, offset) ?? [];
  }

  async hover(path: string, offset: number): Promise<Hover | null> {
    return this.session?.hover(path, offset) ?? null;
  }

  async definition(path: string, offset: number): Promise<Location | null> {
    return this.session?.definition(path, offset) ?? null;
  }
}

export const dcsLuaProvider: LanguageProvider = isTauri()
  ? new LspLuaProvider()
  : new WasmLuaProvider();
