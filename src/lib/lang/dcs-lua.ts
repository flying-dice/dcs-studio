// The dcs-lua provider: the dcs-lua-ls engine compiled to wasm, loaded in
// the webview (no spawned process — model/studio/lang.pds `DcsLua`).
//
// The wasm module loads lazily on first mount; before the session exists
// every query answers empty, so the editor never blocks on the engine.

import init, { IdeSession } from "$lib/dcs-lua-wasm/dcs_lua_ide";
import wasmUrl from "$lib/dcs-lua-wasm/dcs_lua_ide_bg.wasm?url";
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

class DcsLuaProvider implements LanguageProvider {
  readonly id = "dcs-lua";
  readonly extensions = [".lua"];

  private session: IdeSession | null = null;
  private initPromise: Promise<void> | null = null;

  private async ensureLoaded(): Promise<void> {
    this.initPromise ??= init({ module_or_path: wasmUrl }).then(() => {
      this.session = new IdeSession();
    });
    await this.initPromise;
  }

  async mount(files: SourceFile[], rules: ProfileRule[]): Promise<void> {
    await this.ensureLoaded();
    this.session?.mount(files, rules);
  }

  setSource(path: string, text: string): void {
    this.session?.set_source(path, text);
  }

  removeSource(path: string): void {
    this.session?.remove_source(path);
  }

  diagnostics(): Diagnostic[] {
    return this.session?.diagnostics() ?? [];
  }

  documentSymbols(path: string): DocumentSymbol[] {
    return this.session?.document_symbols(path) ?? [];
  }

  foldingRanges(path: string): FoldingRange[] {
    return this.session?.folding_ranges(path) ?? [];
  }

  complete(path: string, offset: number): CompletionItem[] {
    return this.session?.complete(path, offset) ?? [];
  }

  hover(path: string, offset: number): Hover | null {
    return this.session?.hover(path, offset) ?? null;
  }

  definition(path: string, offset: number): Location | null {
    return this.session?.definition(path, offset) ?? null;
  }
}

export const dcsLuaProvider: LanguageProvider = new DcsLuaProvider();
