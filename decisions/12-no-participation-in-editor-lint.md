---
status: Accepted
date: 2026-08-05
---
# Decision 12 — DCS Studio does not participate in editor lint

## Context

[Issue #80](https://github.com/flying-dice/dcs-studio/issues/80). In QA of the
v0.17.0 artifact the owner added
`[lint] globals = ["log", "DCS", "net", "lfs"]` to `dcs-studio.toml` and it did
not clear luabox-lint's LB0509 `undefined-global` warnings — because `[lint]` is
not a manifest section and the extension has no lint integration at all.

The reasonable-sounding response is that the intent is legitimate and should be
met somehow: a DCS project does know which globals the sim provides per
environment, and the editor should not flag them. That framing produced two
candidate routes — have the project templates emit a `.luarc.json`, or make
`[lint]` a real manifest section mirrored into the workspace's editor config on
save.

**Both routes were wrong, and the framing was the mistake.** The premise smuggled
in an obligation the product does not have. `[lint]` in that manifest was a
hangover from an expectation of what a project file "should" configure, not a
gap in DCS Studio.

The standing position is already on the record: editor concerns stay native and
third-party, and the product ships no LSP or linting of its own. That position
was not in tension with #80 — #80 was a test of whether it would hold under a
plausible-sounding request.

## Decision

**DCS Studio does not participate in editor lint. Neither route is taken.**
Decided by the repository owner, doubling down on the existing position rather
than carving an exception into it.

Concretely:

- No `.luarc.json` or equivalent is emitted by the project scaffolds.
- No `[lint]`, `[globals]` or similar section exists in the manifest, now or
  later.
- Nothing in the extension reads, writes or mirrors third-party editor config.
- luabox picks this up. It is their area, and the product does not reach into
  it.

The owner intends to publish a **separate repository of DCS `.d.lua`
definitions**, which this project may reference in future. That is deliberately
out of scope here: a definitions repo is a resource other tools consume, not an
integration this extension performs, and referencing it later does not require
anything in this decision to change.

`[lint]` therefore stays an **unrecognized** manifest section. It is not
special-cased, not suggested, and not reserved —
[#79](https://github.com/flying-dice/dcs-studio/issues/79)'s unknown-section
warning treats it exactly like any other section that does not exist.

## Consequences

- Card 43 loses its blocker entirely and shrinks to #79's validation work. The
  section list has one uncontested source: the real schema.
- #80 should be closed as out of scope, with this record as the reason. The
  request was legitimate and the answer is still no — those are compatible, and
  the record exists so the next person asking gets the reasoning rather than
  silence.
- A user who wants their DCS globals recognized configures their own Lua tooling.
  The docs may say so plainly; that is documentation, not integration.
- Nothing in the repo has to be unwound, and this was **swept rather than
  assumed** (2026-08-05). Across `src/`, `media/`, `docs/`, the templates,
  `README.md` and `package.json` there is no `.luarc.json`, no luals or luabox
  config, no `[lint]`/`[globals]` handling, and no reference to LB0509. The
  scaffolds emit a manifest, Lua sources, a README and — for the Rust template —
  `Cargo.toml`, `.cargo/config.toml` and `lua5.1/lua.lib`. No editor config
  among them. The position was already implemented by having done nothing.
- Two places already state it correctly and are support, not residue:
  `README.md:159` and `docs/01-getting-started/01-overview.md:42-43`, both of
  which say the product is not a Lua language server — no autocomplete, no
  type-checking, no linting — and to pair it with a Lua LSP extension.
- If the `.d.lua` repository later makes a reference worth having, it arrives as
  a new decision that supersedes this one. It does not arrive as an exception
  quietly added to a template.

### The near neighbour, named deliberately

The sweep did surface one thing that looks like a contradiction and is not, so
it is recorded here rather than left for someone to rediscover and
misinterpret.

**The bridge already produces `.d.lua`.** `api_types` returns the generated
EmmyLua definitions for the bridge's own Lua surface, and an introspection
method walks the live DCS API in `_G` — `DCS`, `Export`, `net`, `lfs`, `log` for
the GUI state; `env`, `timer`, `trigger`, `world` for the mission — and returns
it as dotted `.d.lua` statements. The comment at
`bridge/crates/bridge-core/lua/gui_methods.lua:61` says outright that this is
"the live DCS API as `.d.lua` the editor's lua-analyzer indexes".

That is not a violation of this decision, and the line between them is exactly
the line drawn above: **the bridge produces definitions when asked; the
extension never installs, writes or wires them into anyone's editor config.**
Verified — nothing under `src/` or `media/` references `.d.lua` at all. A caller
who wants those definitions asks for them and does what they like with the
answer.

This is also the mechanism most likely to feed the separate `.d.lua`
repository. That remains consistent: generating a resource is not integrating
with a linter. What would cross the line is the extension writing that output
into a workspace or an editor config file on the user's behalf.
