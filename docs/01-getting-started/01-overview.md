# What DCS Studio is

DCS Studio is a VS Code extension that brings the DCS World content-creator
workflow into the editor: a community marketplace for discovering and installing
mods, a guided path from an empty folder to a published mod on GitHub, and a live
link into a running sim for a Lua console, a step debugger, and log tailing.

It is the successor to [dcs-dropzone](https://github.com/flying-dice/dcs-dropzone)
and [dcs-fiddle](https://github.com/flying-dice/dcs-fiddle), rolling both into one
toolchain.

The user-facing feature tour, with screenshots, is in the
[README](../../README.md). This page is the map for people working *on* DCS
Studio.

## The four moving parts

**The extension** (`src/`) — TypeScript, running in VS Code. Its core is a
hexagon: pure rules and use-case services in `src/core/`, with everything that
touches the outside world behind a port. `src/extension.ts` is the composition
root and the only place the two meet. See
[decision 02](../../decisions/02-hexagonal-core-with-a-checked-boundary.md) and
[ARCHITECTURE.md](../../ARCHITECTURE.md), which is the authoritative spec.

**The webviews** (`media/`) — plain JavaScript and CSS, one script per panel. No
framework. Each one is driven in a browser harness under `previews/` so it can be
tested without VS Code.

**The bridges** (`bridge/`) — two Rust DLLs injected into a running DCS, plus a
GameGUI hook. They serve JSON-RPC 2.0 over localhost so the console, debugger and
exporters have something to talk to — and so do scripts and AI agents. See
[decision 04](../../decisions/04-two-in-process-bridges-over-json-rpc.md) and the
[bridge API reference](../03-reference/01-bridge-api.md).

**The manifest** (`dcs-studio.toml`) — a mod project's build recipe and install
plan in one file: what gets bundled into a release, and what gets linked into DCS
on install. See
[decision 03](../../decisions/03-install-mods-as-links-not-copies.md).

## What it deliberately is not

- **A Lua language server.** No autocomplete, no type-checking, no linting of
  your Lua. Pair it with a Lua LSP extension.
- **A dependency manager or bundler.** It packs the paths you declare and links
  them into DCS; it does not resolve dependency trees or transpile anything.
- **A hosted service.** There is no DCS Studio server. GitHub is the whole
  backend — see
  [decision 01](../../decisions/01-github-as-the-whole-backend.md).

## Where things are written down

| Question | Where |
|---|---|
| How is the code structured, and what rule enforces it? | [ARCHITECTURE.md](../../ARCHITECTURE.md) |
| Why is it structured that way? | [`decisions/`](../../decisions) |
| What is being worked on next? | [`boards/project-backlog/`](../../boards/project-backlog) |
| What does a feature actually promise? | [`spec/stories/`](../../spec/stories) — 24 Gherkin stories |
| What does the bridge expose? | [Bridge JSON-RPC API](../03-reference/01-bridge-api.md) |
| What are the test gates, and what do they cover? | [Testing & quality](../04-quality/01-testing-quality.md) |
| How did the suite get that way? | [The 2026-07 testing audit](../04-quality/02-testing-audit-2026-07.md) — historical |
| How do I drive the bridge from an agent? | [`skills/dcs-studio/SKILL.md`](../../skills/dcs-studio/SKILL.md) |
