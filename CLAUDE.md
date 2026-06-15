# dcs-studio

A desktop IDE (Tauri + SvelteKit) for DCS World mission/mod development: project
explorer, CodeMirror editor, live Lua console against a running sim, and managers
for installing the in-DCS bridge DLL and toggling MissionScripting.lua sanitization.

## Model-driven engineering (mandatory workflow)

The PseudoScript model in `model/` is the **spec**, not documentation-after-the-fact.
Every change that touches behavior or architecture follows this order:

> Use `pds -h` to check the model skill and language spec

1. **Draft the model first.** Update (or add to) the relevant `model/*.pds` module
   to express the intended change — new callables, data shapes, error paths,
   features. Run `pds check <file>` until clean and `pds fmt --write <file>`.
2. **Make the change.** Implement in Rust/TypeScript, translating the model
   faithfully: every disclosed branch and `Err` arm in the model must exist in
   the code, in the same order. Black-box signatures are the contracts adapters
   must satisfy.
3. **Update the model.** If implementation forced deviations (renamed methods,
   extra error paths, changed shapes), reconcile the model before finishing.
   The model and code must not disagree at the end of a task.

Rules of thumb:

- A business decision (guard, authorization, state transition, derivation) that
  exists in code but not in a disclosed model body is a model bug — add it.
- Plumbing (serialization, status codes, retries, DI wiring) never goes in the model.
- Cross-system calls target the `Dcs` system's published face (`Ping`/`Eval`/`Invoke`),
  never its internal containers.
- New acceptance behavior gets a `feature` scenario on the owning node.

PseudoScript reference: `pds skill` (method), `pds lang` (grammar). Useful commands:
`pds check <file>`, `pds fmt --write <file>`, `pds eval` (stdin snippet check),
`cd model && pds doc` (site under `model/target/doc`, gitignored),
`pds svg --symbol <FQN>` (single diagram).

Model gotchas learned here: `data` is a reserved word (no fields named `data`);
constants only take non-negative primitive literals (JSON-RPC codes live in docs).

### Model map

| Module | Covers |
| --- | --- |
| `model/studio/core.pds` | `Studio` system, `Workbench` UI container (editor, console, dual-path `DcsCall`) |
| `model/studio/files.pds` | `WorkspaceFs` — fs commands, project scaffolding (`crates/studio-services/src/fs.rs`; thin Tauri wrappers in `crates/app/src/fs.rs`) |
| `model/studio/link.pds` | `DcsLink` heartbeat + `BridgeClient` (`crates/studio-services/src/link.rs`, `crates/app/src/dcs.rs`, `crates/dcs-bridge-client`) |
| `model/studio/inject.pds` | `Injector` — bridge DLL/hook install (`crates/studio-services/src/inject.rs`) |
| `model/studio/build.pds` | `Builder` — toolchain detection + cargo build with streamed output (issue #6 R1) |
| `model/studio/cli.pds` | `Cli` agent-surface binary (`crates/dcs-studio-cli`), `TestRunner` — out-of-DCS Lua test runner (`tools/lua-runner`), `Bundler` — single-file require-graph bundler (issue #9) |
| `model/studio/installer.pds` | `Installer` — manifest-driven `[[install]]` deploy to SavedGames/GameInstall roots (issue #6 R1) |
| `model/studio/package.pds` | `Packager`/`PackageLibrary` + `SigningService`/`IdentityProvider` faces — signed, revocable `.dcspkg` packages (issue #37; `crates/studio-packages`, mock signing server `crates/mock-package-server`, CLI `pack`/`pkg`) |
| `model/studio/mission.pds` | `MissionScripting` sanitization manager (`crates/studio-services/src/mission.rs`) |
| `model/studio/mcp.pds` | `McpServer` — the IDE-hosted agent tool surface over a loopback transport (issue #33; `crates/studio-mcp` handler, `crates/app/src/mcp.rs` server, `crates/studio-services`) |
| `model/studio/term.pds` | `Terminal` — integrated terminal: tabbed PTY sessions + launch/harness profiles, collapse-survival replay buffer (`crates/studio-services/src/term.rs` registry, `crates/app/src/term.rs` bridge, `src/lib/terminal.svelte.ts` + `src/lib/components/Terminal.svelte`; issue #13) |
| `model/studio/todos.pds` | `TodoScanner` — workspace comment-tag scanner behind the Todos panel (`crates/dcs-studio-project/src/todos.rs`, `src/lib/todos.svelte.ts`) |
| `model/studio/lang.pds` | `LanguageIntel` provider layer + `DcsLua` engine face + `LuaAnalyzer`/`RustAnalyzer` hosted-server faces (`src/lib/lang/`, `crates/lua-analyzer`) |
| `model/studio/edit.pds` | `Formatting` — editor format (Document/Selection, format-on-save) over the shared `fmt::Fmt` engine; `Refactoring` — go-to-definition, find-usages, rename-symbol (`src/lib/editor/format.ts`, `src/lib/editor/refactor.ts`, `crates/dcs-lua-lsp-core/src/{definition,references,rename}.rs`) |
| `model/dcslua.pds` | `DcsLuaLs` engine system root |
| `model/syntax.pds` | Lexer/parser/AST contract (`crates/dcs-lua-syntax`) |
| `model/lspcore.pds` | Workspace + query layer (`crates/dcs-lua-lsp-core`) |
| `model/fmt.pds` | Deterministic Lua formatter face (`crates/dcs-lua-fmt`, SPEC.md §7, decisions/006) |
| `model/ide.pds` | Wasm `IdeSession` edge (`crates/dcs-lua-ide`) — unwired from the app by #32; the engine's wasm-bindgen surface |
| `model/dcs/bridge.pds` | `Dcs` system: GameGUI hook, JSON-RPC server/router (`crates/dcs-bridge`) |

## Architecture

Two processes joined by WebSocket JSON-RPC on `ws://127.0.0.1:25569/ws`:

- **Editor**: SvelteKit frontend (`src/`) inside a Tauri shell (`crates/app`), which
  embeds `crates/dcs-bridge-client` (reconnecting WS client, string ids only — the
  server's serde rejects numeric ids).
- **In-DCS bridge**: `crates/dcs-bridge` builds `dcs_bridge.dll` (mlua cdylib +
  actix WS server), loaded by the GameGUI hook
  `crates/dcs-bridge/deploy/Scripts/Hooks/DcsStudio.lua`. Requests queue and are
  drained once per simulation frame — frames fire at the main menu too, so RPCs
  answer from boot; a mission is live only when the pong's `dcs_time` > 0.

In a plain browser (vite dev, Playwright) there is no Tauri IPC: `dcsCall` falls
back to `src/lib/dcs-ws.ts`, speaking the same wire protocol directly.

### Language intelligence (decisions/005)

Lua diagnostics/outline/folding come from the **dcs-lua engine**
(`crates/dcs-lua-{syntax,lsp-core,ide}` + `crates/lua-analyzer`) behind the
one `LanguageProvider` contract. The backend host (`crates/app/src/lsp.rs`)
spawns **`lua-analyzer`** — a standalone tower-lsp stdio server
(`crates/lua-analyzer`), hosted exactly like rust-analyzer — and pumps framed
JSON-RPC over IPC events; `src/lib/lang/lsp-client.ts` + `lua-analyzer.ts` own
the protocol. `lua-analyzer` indexes the project itself from the `initialize`
rootUri. The binary must sit next to the app exe (`cargo build -p
lua-analyzer`; `DCS_LUA_ANALYZER` overrides).

There is no longer an in-page wasm fallback (issue #32 retired it;
decisions/005 revised): the engine is reached only through the hosted server,
so the `/lab/*` surfaces and the `e2e-lang/` suite run against the **real app**
over WebView2 CDP — Windows-only (`pnpm test:lang`, see below), unlike the
`dcs-ws.ts` browser fallback the console still keeps.

**The IDE hosts the MCP agent surface** (issue #33): the running app runs a
loopback JSON-RPC server (`crates/app/src/mcp.rs`) that dispatches through the
shared **`crates/studio-mcp`** handler over the app's LIVE DCS link — one
connection to the sim, no rival sidecar (single-instance enforced). It is
token-gated (the surface includes `dcs_eval`): `{port, token}` is written to
`<app-config>/mcp.json` for the agent to read, and the token must be presented
before any tool call. The same handler is drivable headless over stdio. The
surface (model/studio/mcp.pds): project (`init_project`, `check`, `build`),
workspace fs (`read_dir`, `read_text_file`, `write_text_file`, `path_exists`),
the DCS link (`dcs_status`, `dcs_eval`, `dcs_call`), injection
(`detect_installs`, `injection_status`, `inject`, `eject`), mission scripting
(`detect_mission_scripts`, `mission_script_status`, `mission_script_set`,
`mission_script_restore`), and the real engine (`lua_diagnostics`,
`lua_hover`; `lua_complete`/`lua_definition` answer a stable not-implemented
error until the engine grows those queries). Tool logic lives in the
tauri-free **`crates/studio-services`** (fs, inject, mission, link) and
`crates/studio-mcp`, so agents and the IDE run the same code.

**dcs-studio-cli is the stateless tooling binary**: `init` / `check` /
`build` / `fmt` / `test` / `bundle` / `install` — no DCS, no IDE, useful in
CI without a running app. (LSP is its own binary, `lua-analyzer`, which
agents and editors spawn directly.) `test` runs `tests/**/*.test.lua` outside DCS via
the sibling `dcs-lua-runner` binary (`tools/lua-runner`, its OWN cargo
workspace: mlua `vendored` must never feature-unify with dcs-bridge's
`module`; `DCS_LUA_RUNNER` overrides the path); `bundle` amalgamates
the `[build] entry` require graph into `dist/` via package.preload.

**rust-analyzer is a sibling hosted server** (issue #6 R2):
`src/lib/lang/rust-analyzer.ts` mounts `.rs` files through the same
provider seam, spawned by the same backend host as `lua-analyzer`, with a
real `rootUri` (rust-analyzer indexes the project itself — no didOpen of
the world, exactly as `lua-analyzer` now does for `.lua`).
Detection goes through `dcs-studio-project::toolchain::rust_analyzer()`
(PATH, then `rustup which`); a missing binary or a root without a
Cargo.toml is non-fatal — Lua intelligence stays intact. Shared LSP
wire conversion lives in `src/lib/lang/lsp-wire.ts`; the client answers
server→client requests (`workspace/configuration`,
`client/registerCapability`, …) or rust-analyzer stalls. `/lab/rust` +
`e2e-lang/rust-provider.spec.ts` cover the path with an injected fake
transport (no real rust-analyzer), so it runs under the real-app CDP suite
like the rest.

Project tooling lives in **`crates/dcs-studio-project`** (the shared kit
both the CLI and the app consume): templates — `blank`, `lua-script`,
and `rust-dll` (an mlua cdylib mod generalising `crates/dcs-bridge`,
vendored `lua5.1/lua.lib` included as bytes; the `.cargo/config.toml`
`LUA_LIB` pin guards the silent wrong-DLL footgun) — plus scaffolding,
`dcs-studio.toml` manifest parsing, `[[install]]`-rule deploys against
the named roots, Saved Games detection, and toolchain probing.
`src/lib/templates.ts` is UI metadata only; file contents render in Rust.
The Output panel hosts the cargo build runner (`build://output` /
`build://done` events, one build at a time).

Engine governance lives in this repo:
`SPEC.md` (dialect, diagnostic registry, annotations, profiles, `.d.lua`
layering), `PATTERNS.md`, `decisions/` ADRs, `CONFORMANCE/` goldens
(hand-written, never copied from the implementation), and `testdata/`
(MIST + TSTL corpus — parsing it panic-free in budget is a test, not a
benchmark). The engine crates are edition 2024 with clippy-pedantic
workspace lints; the parser is total — any input yields a tree plus
diagnostics, never a panic. The IDE side:

- `src/lib/lang/provider.ts` — the LSP-shaped `LanguageProvider` extension
  point and its DTO types.
- `src/lib/lang/dcs-lua.ts` — names the one Lua provider: the hosted
  `LuaAnalyzerProvider` (`lua-analyzer.ts`).
- `src/lib/lang/intel.svelte.ts` — `lang` singleton: mounts the workspace on
  project open, holds the findings store + engine status.
- `src/lib/lang/codemirror.ts` — lint/fold/hover wiring; the lint debounce
  doubles as the didChange pump into the server.
- `/lab/lua` route — test surface (like `/console`), driven by the
  `e2e-lang/` Playwright suite against the real app over CDP (Windows-only).
  Engine-backed lab pages seed an absolute file path and didOpen it so the
  hosted server keys the buffer for positional queries.

## Commands

- `pnpm dev` — frontend only at `http://localhost:1420`
- `pnpm tauri:dev` — full desktop app
- `pnpm check` — svelte-check / TypeScript
- `cargo build -p dcs-bridge --release` — build the bridge DLL (release profile is
  what the in-app Injection Manager picks up)
- `cargo check --workspace` / `cargo test --workspace` — Rust
- `pnpm test:e2e` — Playwright suite (`e2e/`); drives the real UI against a real
  DCS instance, launching DCS if the bridge isn't already up. One worker, ~1 min
  cold start. Don't run it casually; report with `pnpm test:report`.
- `pnpm test:lang` — language-engine Playwright suite (`e2e-lang/`). Issue #32
  drives the REAL app over WebView2 CDP (`scripts/e2e-app.mjs` launches
  `tauri dev` with `--remote-debugging-port=9222`; `e2e-lang/_tauri.ts`
  attaches), so it exercises the hosted `lua-analyzer` — **Windows-only**
  (WebView2 CDP) and not in the Linux CI. No DCS.
- `cargo test -p dcs-lua-syntax -p dcs-lua-lsp-core -p dcs-lua-ide` — engine
  suites (units, conformance goldens, totality properties, corpus gate).
- `cargo test -p lua-analyzer` — the standalone Lua LSP server's real-stdio
  suite (initialize → workspace walk → parse + `param-type-mismatch` type diagnostics,
  didChange, hover).
- `cargo test -p dcs-studio-cli` — CLI suites incl. the real-stdio MCP
  end-to-end session (full tool surface, no-DCS guards, real-engine lang
  tools). The `test`-subcommand and bundle-execution suites need the
  lua-runner built first (below) and found via `DCS_LUA_RUNNER` or
  `tools/lua-runner/target/debug`; they skip hermetically without it
  (host_ipc pattern). CI builds it first and pins the env var.
- `cargo test -p studio-services` — the extracted tauri-free service logic
  (fs, inject, mission, DCS link guards).
- `cargo test --manifest-path tools/lua-runner/Cargo.toml` — the Lua test
  runner (issue #9). Its OWN cargo workspace, so `cargo test --workspace`
  from the root never touches it; CI's `rust` job runs it explicitly.
- `DCS_TEMPLATE_COMPILE=1 cargo test -p dcs-studio-project --test template_compile`
  — scaffold the rust-dll template and `cargo check` it (issue #22); skips
  without the env var so the default suite stays fast. CI's
  `template-compile` job sets it.
- `cargo test -p dcs-studio --tests` — host↔real-server IPC integration
  (needs `cargo build -p lua-analyzer` first; auto-skips without the binary).

For live work against DCS (deploy the DLL, launch/control the sim, eval Lua),
use the `dcs-dev` skill.

## Gotchas

- **Lua linking**: `.cargo/config.toml` pins `LUA_LIB`/`LUA_LIB_NAME` to
  `crates/dcs-bridge/lua5.1` so the DLL links DCS's own `lua.dll`. Without it,
  cargo silently links `lua51.dll` and `require("dcs_bridge")` fails inside DCS.
- **JSON-RPC ids are strings**: a numeric id kills the server's WS read task.
- A DLL locked by a running DCS cannot be overwritten — injection surfaces this.
