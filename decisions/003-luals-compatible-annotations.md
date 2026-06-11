# 003 — LuaLS/EmmyLua-compatible annotation dialect

Affects: `SPEC.md §4`, `SPEC.md §6`, `crates/dcs-lua-syntax` (annot),
`crates/dcs-lua-model`.

## Context

The annotation dialect could be LuaLS/EmmyLua-compatible, LuaLS plus custom
DCS tags, or a purpose-built syntax.

## Decision

LuaLS/EmmyLua-compatible: the `---@` tag set and type-expression grammar of
lua-language-server (`SPEC.md §4`).

## Consequences

- Generated and hand-written `.d.lua` files work unchanged in VS Code with
  lua-language-server; existing community definition sets remain usable.
- DCS-specific semantics (environment profiles) ride configuration and
  lints, not new tags. Adding custom tags later is compatible (unknown tags
  are ignored by LuaLS) but requires a superseding record.
- The grammar is pinned by an external project; divergences are bugs here,
  not dialect choices.
