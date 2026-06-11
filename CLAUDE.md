# dcs-studio

A desktop IDE (Tauri + SvelteKit) for DCS World mission/mod development: project
explorer, CodeMirror editor, live Lua console against a running sim, and managers
for installing the in-DCS bridge DLL and toggling MissionScripting.lua sanitization.

## Model-driven engineering (mandatory workflow)

The PseudoScript model in `model/` is the **spec**, not documentation-after-the-fact.
Every change that touches behavior or architecture follows this order:

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
| `model/studio/files.pds` | `WorkspaceFs` — fs commands, project scaffolding (`crates/app/src/fs.rs`) |
| `model/studio/link.pds` | `DcsLink` heartbeat + `BridgeClient` (`crates/app/src/dcs.rs`, `crates/dcs-bridge-client`) |
| `model/studio/inject.pds` | `Injector` — bridge DLL/hook install (`crates/app/src/inject.rs`) |
| `model/studio/build.pds` | `Builder` — toolchain detection + cargo build with streamed output (issue #6 R1) |
| `model/studio/installer.pds` | `Installer` — manifest-driven `[[install]]` deploy to SavedGames/GameInstall roots (issue #6 R1) |
| `model/studio/mission.pds` | `MissionScripting` sanitization manager (`crates/app/src/mission.rs`) |
| `model/studio/lang.pds` | `LanguageIntel` provider layer + `DcsLua` embedded engine face + `RustAnalyzer` hosted-server face (`src/lib/lang/`) |
| `model/dcslua.pds` | `DcsLuaLs` engine system root |
| `model/syntax.pds` | Lexer/parser/AST contract (`crates/dcs-lua-syntax`) |
| `model/lspcore.pds` | Workspace + query layer (`crates/dcs-lua-lsp-core`) |
| `model/ide.pds` | Wasm `IdeSession` edge (`crates/dcs-lua-ide`) |
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
(`crates/dcs-lua-{syntax,lsp-core,ide}` + `crates/dcs-studio-cli`), reached
two ways behind one `LanguageProvider` contract:

- **Packaged app:** the backend host (`crates/app/src/lsp.rs`) spawns
  `dcs-studio-cli lsp` — a genuine tower-lsp stdio server — and pumps
  framed JSON-RPC over IPC events; `src/lib/lang/lsp-client.ts` +
  `lsp-lua.ts` own the protocol. The CLI binary must sit next to the app
  exe (`cargo build -p dcs-studio-cli`; `DCS_STUDIO_CLI` overrides).
- **Plain browser (vite dev, Playwright):** the same engine as wasm
  in-page (`src/lib/dcs-lua-wasm/`, rebuild with `pnpm build:wasm` and
  commit). Same dual-path convention as `dcs-ws.ts`.

**dcs-studio-cli is the agent surface**: `lsp` and `mcp` (tools:
`init_project`, `check`, `build`) over stdio, plus direct `init` /
`check` / `build` / `install` subcommands — an agent needs no Tauri
app.

**rust-analyzer is the second hosted server** (issue #6 R2):
`src/lib/lang/rust-analyzer.ts` mounts `.rs` files through the same
provider seam, spawned by the same backend host with a real `rootUri`
(rust-analyzer indexes the project itself — no didOpen of the world).
Detection goes through `dcs-studio-project::toolchain::rust_analyzer()`
(PATH, then `rustup which`); a missing binary or a root without a
Cargo.toml is non-fatal — Lua intelligence stays intact. Shared LSP
wire conversion lives in `src/lib/lang/lsp-wire.ts`; the client answers
server→client requests (`workspace/configuration`,
`client/registerCapability`, …) or rust-analyzer stalls. `/lab/rust` +
`e2e-lang/rust-provider.spec.ts` cover the path browser-only.

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
  point; DTO types re-exported from the wasm's generated `.d.ts`.
- `src/lib/lang/dcs-lua.ts` — the wasm-backed provider (`IdeSession`).
- `src/lib/lang/intel.svelte.ts` — `lang` singleton: mounts the workspace on
  project open, holds the findings store + engine status.
- `src/lib/lang/codemirror.ts` — lint/fold/hover wiring; the lint debounce
  doubles as the didChange pump into the session.
- `/lab/lua` route — browser test surface (like `/console`), driven by the
  `e2e-lang/` Playwright suite: no Tauri, no DCS.

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
- `pnpm test:lang` — language-engine Playwright suite (`e2e-lang/`), browser
  only: no Tauri, no DCS. Cheap to run.
- `cargo test -p dcs-lua-syntax -p dcs-lua-lsp-core -p dcs-lua-ide` — engine
  suites (units, conformance goldens, totality properties, corpus gate).
- `cargo test -p dcs-studio-cli` — CLI suites incl. real-stdio LSP and MCP
  end-to-end sessions.
- `DCS_TEMPLATE_COMPILE=1 cargo test -p dcs-studio-project --test template_compile`
  — scaffold the rust-dll template and `cargo check` it (issue #22); skips
  without the env var so the default suite stays fast. CI's
  `template-compile` job sets it.
- `cargo test -p dcs-studio --tests` — host↔real-server IPC integration
  (needs `cargo build -p dcs-studio-cli` first; auto-skips without the binary).
- `pnpm build:wasm` — rebuild `src/lib/dcs-lua-wasm/` after engine changes.

For live work against DCS (deploy the DLL, launch/control the sim, eval Lua),
use the `dcs-dev` skill.

## Gotchas

- **Lua linking**: `.cargo/config.toml` pins `LUA_LIB`/`LUA_LIB_NAME` to
  `crates/dcs-bridge/lua5.1` so the DLL links DCS's own `lua.dll`. Without it,
  cargo silently links `lua51.dll` and `require("dcs_bridge")` fails inside DCS.
- **JSON-RPC ids are strings**: a numeric id kills the server's WS read task.
- A DLL locked by a running DCS cannot be overwritten — injection surfaces this.
