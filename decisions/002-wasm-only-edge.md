# 002 — Single wasm edge; no stdio LSP server

Affects: `crates/dcs-lua-ide`, workspace layout.

## Context

The engine is modelled on the LSP: transport-neutral query handlers in
`dcs-lua-lsp-core`. Pseudoscript ships two edges over its core (stdio
tower-lsp + wasm `IdeSession`). dcs-studio embeds its engines and spawns no
language-server processes.

## Decision

Ship exactly one edge: the `dcs-lua-ide` wasm crate's `IdeSession`, mirroring
`pseudoscript-ide`. No stdio server crate.

## Consequences

- dcs-studio loads the engine in the webview; language intelligence works
  identically in the packaged app, vite dev, and Playwright.
- Other editors (VS Code, Neovim) are unsupported. The core stays
  transport-neutral, so a stdio edge is a thin adapter if this is ever
  revisited — a new record supersedes this one then.
- No process lifecycle, framing, or restart machinery anywhere in the repo.
