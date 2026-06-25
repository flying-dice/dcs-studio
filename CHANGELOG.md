# Changelog

All notable changes to DCS Studio are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-06-24

First release. A desktop IDE for DCS World mission and mod development — a
Tauri + SvelteKit shell with a CodeMirror editor and a live link into a running
sim.

### Added

- **Project explorer & scaffolding** — file tree plus new-project templates
  (`blank`, `lua-script`, `rust-dll` mlua cdylib mod).
- **Editor** — CodeMirror with Lua + Rust language intelligence (diagnostics,
  hover, outline/folding, go-to-definition, find-usages, rename, and format
  including format-on-save), served by hosted `lua-analyzer` / `rust-analyzer`.
- **Live Lua console** — evaluate Lua inside a running DCS sim over the in-DCS
  WebSocket JSON-RPC bridge.
- **In-sim Lua debugger** — breakpoints, stepping, and watches driven against
  the live sim.
- **Injection Manager** — install/eject the `dcs_studio.dll` bridge and GameGUI
  hook into DCS.
- **Managed launch** — back up `options.lua`, inject, spawn DCS, and restore on
  exit.
- **MissionScripting sanitization** — toggle DCS's `MissionScripting.lua`
  sandbox on/off.
- **Build runner** — `cargo build` for `rust-dll` mods with streamed output.
- **Integrated terminal** — tabbed PTY sessions with launch/harness profiles.
- **Todos panel** — workspace comment-tag scanner.
- **Marketplace** — browse and install community mods tagged `dcs-studio` on
  GitHub, gated behind device-flow sign-in.
- **Publish** — share a project to GitHub and publish installable releases as
  signed, revocable `.dcspkg` packages.
- **MCP server** — the IDE hosts a standard MCP Streamable HTTP surface on
  loopback so agents like Claude Code can drive the project, workspace, and
  live sim.

[0.1.0]: https://gitlab.beluga-sirius.ts.net/flying-dice/dcs-studio/-/releases/v0.1.0
