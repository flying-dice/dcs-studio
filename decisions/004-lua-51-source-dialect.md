# 004 — Lua 5.1 source dialect

Affects: `SPEC.md §2`, `crates/dcs-lua-syntax`.

## Context

DCS embeds LuaJIT 2.x, which executes Lua 5.1 source plus JIT extensions
(some 5.2 library functions, `goto` in recent builds, FFI).

## Decision

The grammar accepts Lua 5.1 exactly: no `goto`/labels, no `//` or bitwise
operators, no `\z`/`\xXX` escapes, hex integers but no hex floats.

## Consequences

- Scripts that parse here run in every DCS Lua environment.
- A script using a LuaJIT extension gets a parse diagnostic; if real-world
  DCS corpora show such usage, the extension is admitted by a superseding
  record, not ad hoc.
