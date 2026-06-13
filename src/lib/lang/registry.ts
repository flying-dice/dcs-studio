// Provider registry: which engine handles a file, by extension
// (model/studio/lang.pds `LanguageIntel.IsLuaSource` generalised):
// .lua → DcsLua, .rs → RustAnalyzer. Future engines (other languages,
// a remote bridge) implement `LanguageProvider` and join this list.

import { dcsLuaProvider } from "./dcs-lua";
import { rustAnalyzerProvider } from "./rust-analyzer";
import type { LanguageProvider } from "./provider";

// Dev-only HMR continuity (issue #31): a hot-update to a provider module
// rebuilds these singletons with COLD clients and abandons the prior
// instances' live `TauriTransport`s — whose Tauri listeners are never
// unlistened (the exact leak issue #31 named). Stash the array so every
// importer (`lang`, codemirror, Structure) re-binds to the SAME warm
// providers across a reload — no respawn, no stacked listeners. Statically
// `new` in production: `import.meta.hot` is undefined there.
const providers: LanguageProvider[] =
  (import.meta.hot?.data.providers as LanguageProvider[] | undefined) ??
  [dcsLuaProvider, rustAnalyzerProvider];
if (import.meta.hot) {
  import.meta.hot.dispose((data) => {
    data.providers = providers;
  });
}

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
