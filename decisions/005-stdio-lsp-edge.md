# 005 — dcs-studio-cli: genuine stdio LSP + MCP for agents; IDE consumes the LSP over backend IPC

Supersedes [002](002-wasm-only-edge.md). Affects: `crates/dcs-studio-cli`,
`crates/app` (LSP process host), `src/lib/lang/`, `SPEC.md §1`.

> **Revision (issue #32, 2026-06):** the wasm `IdeSession` browser-mode
> fallback described below is **removed**. `src/lib/lang/dcs-lua.ts` now
> always uses the hosted `lua-analyzer` (`LuaAnalyzerProvider`); there is no
> in-page engine. With no wasm edge, the `/lab/*` surfaces and the
> `e2e-lang/` suite can no longer run in a plain browser — they drive the
> **real packaged app** over WebView2 CDP (`scripts/e2e-app.mjs` +
> `e2e-lang/_tauri.ts`, `pnpm test:lang`). CDP against Tauri's webview is
> **Windows-only**, so that suite left the (Linux) CI (re-gating it with a
> Windows runner is tracked in issue #35); the `e2e` and
> `wasm-sync` jobs and `pnpm build:wasm` are gone. The `LanguageProvider`
> seam and the single-core promise are unchanged — only the second
> (browser) transport retired. This reverses "tauri-driver judged
> unnecessary for now": the cost of a stale wasm copy of the engine and a
> test surface that never met the real LSP host outweighed the Windows-only
> constraint. Everything below stands except that wasm bullet.

## Context

Three requirements arrived together: the IDE gains Rust-toolchain support
(rust-analyzer can only be consumed as a spawned LSP process); the Lua
engine must be usable by external tooling over the Language Server
Protocol; and agents need a standalone surface — project init, checking,
MCP — without the Tauri app.

## Decision

Ship two artifacts: the Tauri app and **`dcs-studio-cli`** — one binary,
agent-complete:

- `dcs-studio-cli lsp` — genuine LSP over stdio (tower-lsp) on the
  transport-neutral `dcs-lua-lsp-core`: initialize walks the workspace
  root for Lua sources, full-document sync, push `publishDiagnostics`,
  documentSymbol, foldingRange; completion/hover/definition arrive with
  engine Phase 2.
- `dcs-studio-cli mcp` — MCP server over stdio (newline-delimited
  JSON-RPC): `init_project` and `check` tools first; build/deploy/
  introspection tools follow their phases.
- `dcs-studio-cli init` / `check` — direct subcommands for the same
  operations (the `pds` pattern).
- The IDE consumes language intelligence from the **backend**: a generic
  LSP process host in `crates/app` spawns `dcs-studio-cli lsp` and pumps
  framed JSON-RPC over Tauri IPC events; rust-analyzer is the second
  hosted server (issue #6 R2).
- ~~The wasm `IdeSession` edge remains **only** as the browser-mode fallback
  (vite dev, Playwright) where no Tauri IPC exists — the same dual-path
  convention as `dcs-ws.ts`.~~ **Superseded by the issue-#32 revision at the
  top of this file: the wasm edge is removed; the engine is reached only
  through the hosted `lua-analyzer`.**

## Consequences

- One client stack serves every language; `LanguageProvider` stays the
  seam, with queries async to span both transports.
- An agent uses the CLI alone for everything: scaffold, check, LSP, MCP.
- Project templates need a Rust home for `init`; the TypeScript templates
  in `src/lib/templates.ts` migrate or delegate (tracked as follow-up —
  duplicated content is a defect once both exist).
- Three-plus edges over one core is the cost; each is a thin adapter, and
  002's core promise (language intelligence implemented once) holds.
