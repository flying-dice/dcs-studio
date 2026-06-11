// Provider registry: which engine handles a file, by extension
// (model/studio/lang.pds `LanguageIntel.IsLuaSource` generalised):
// .lua → DcsLua, .rs → RustAnalyzer. Future engines (other languages,
// a remote bridge) implement `LanguageProvider` and join this list.

import { dcsLuaProvider } from "./dcs-lua";
import { rustAnalyzerProvider } from "./rust-analyzer";
import type { LanguageProvider } from "./provider";

const providers: LanguageProvider[] = [dcsLuaProvider, rustAnalyzerProvider];

/** The provider responsible for `path`, or null when none matches. */
export function providerFor(path: string): LanguageProvider | null {
  const lower = path.toLowerCase();
  return (
    providers.find((p) => p.extensions.some((ext) => lower.endsWith(ext))) ??
    null
  );
}

/** Every registered provider — workspace-level operations fan out here. */
export function allProviders(): LanguageProvider[] {
  return providers;
}
