// The dcs-lua provider (decisions/005, revised by issue #32):
//
// Lua intelligence runs in the BACKEND — the host spawns the standalone
// `lua-analyzer` binary and we speak LSP over IPC, hosted exactly like
// rust-analyzer. There is no longer an in-page wasm fallback: the engine is
// reached only through the hosted server, so the `/lab/*` surfaces and the
// e2e-lang suite exercise the real binary (and run against the real app).
//
// Everything above the registry is transport-blind; this module just names
// the one provider the app uses for `.lua`.

import { LuaAnalyzerProvider } from "./lua-analyzer";
import type { LanguageProvider } from "./provider";

export const dcsLuaProvider: LanguageProvider = new LuaAnalyzerProvider();
