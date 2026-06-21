# DCS Studio

A desktop IDE for **DCS World** mission and mod development — Tauri + SvelteKit
shell, CodeMirror editor, and a live link into a running sim.

> ⚠️ **Heavily WIP.** APIs, layout, and the on-disk model change often. It
> builds, pulls, and runs today, but treat it as a moving target. Windows is the
> primary (and only fully supported) platform — the live-DCS features need DCS
> World installed.

## Features

- **Project explorer & scaffolding** — file tree, new-project templates (`blank`,
  `lua-script`, `rust-dll` mlua cdylib mod).
- **Editor** — CodeMirror with Lua + Rust language intelligence: diagnostics,
  hover, outline/folding, go-to-definition, find-usages, rename, and format
  (incl. format-on-save), served by hosted `lua-analyzer` / `rust-analyzer`.
- **Live Lua console** — eval Lua inside a running DCS sim over the in-DCS
  WebSocket JSON-RPC bridge.
- **In-sim Lua debugger** — breakpoints, stepping, and watches driven from the
  Debug panel against the live sim.
- **Injection Manager** — install/eject the `dcs_studio.dll` bridge + GameGUI
  hook into DCS.
- **Managed launch** — back up `options.lua`, inject, spawn DCS, and restore on
  exit.
- **MissionScripting sanitization** — toggle DCS's `MissionScripting.lua`
  sandbox on/off.
- **Build runner** — cargo build for `rust-dll` mods with streamed output.
- **Integrated terminal** — tabbed PTY sessions with launch/harness profiles.
- **Todos panel** — workspace comment-tag scanner.
- **Marketplace** — browse and install community mods tagged `dcs-studio` on
  GitHub (sign-in gated, device-flow auth).
- **Publish** — share a project to GitHub and publish installable releases;
  signed, revocable `.dcspkg` packages.
- **MCP server** — the IDE hosts a standard MCP Streamable HTTP surface
  (loopback `:25570`) so agents like Claude Code can drive the project, the
  workspace, and the live sim.

## Prerequisites

- **Node** + [pnpm](https://pnpm.io/)
- **Rust** (stable toolchain, via [rustup](https://rustup.rs/))
- **Tauri v2** [system prerequisites](https://v2.tauri.app/start/prerequisites/)
  (on Windows 11, WebView2 is already present)
- **DCS World** — only for the live link, injection, and launch features

## Run

```sh
pnpm install
pnpm tauri:dev      # full desktop app (builds lua-analyzer first)
```

Frontend only (no Tauri shell, mock DCS link):

```sh
pnpm dev            # http://localhost:1420
```

Build the in-DCS bridge DLL (what the Injection Manager picks up):

```sh
cargo build -p dcs-bridge --release
```

## Test

```sh
pnpm check                         # svelte-check / TypeScript
cargo check --workspace            # Rust typecheck
cargo test --workspace             # Rust unit/integration tests
```

Targeted suites:

```sh
cargo test -p dcs-lua-syntax -p dcs-lua-lsp-core -p dcs-lua-ide   # Lua engine
cargo test -p lua-analyzer          # standalone Lua LSP server (real stdio)
cargo test -p studio-mcp            # MCP handler surface
cargo test -p studio-services       # tauri-free service logic (fs/inject/...)
```

End-to-end (Playwright, **Windows-only**, drive the real app):

```sh
pnpm test:lang      # language engine over WebView2 CDP (no DCS)
pnpm test:e2e       # full UI against a real DCS instance (launches DCS; slow)
pnpm test:report    # open the last report
```

> `test:e2e` cold-starts DCS (~1 min, one worker) — don't run it casually.

## Project layout

Two processes joined by WebSocket JSON-RPC (`ws://127.0.0.1:25569/ws`): the
SvelteKit frontend (`src/`) inside a Tauri shell (`crates/app`), and the in-DCS
runtime (`crates/dcs-bridge` → `dcs_studio.dll`) loaded by a GameGUI hook.

The `model/` PseudoScript spec is the source of truth for behavior and
architecture. See [`CLAUDE.md`](./CLAUDE.md) for the full crate map, the
model-driven workflow, and gotchas.

## License

MIT
