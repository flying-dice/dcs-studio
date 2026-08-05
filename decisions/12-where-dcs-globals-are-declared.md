---
status: Proposed
date: 2026-08-05
---
# Decision 12 — Where DCS-provided globals are declared for editor lint

## Context

[Issue #80](https://github.com/flying-dice/dcs-studio/issues/80), board card 43.
In QA the owner added `[lint] globals = ["log", "DCS", "net", "lfs"]` to
`dcs-studio.toml` and it did not clear luabox-lint's LB0509 `undefined-global`
warnings — because `[lint]` is not a manifest section and the extension contains
no lint integration at all. That is by design: editor concerns stay native and
third-party, and the product ships no LSP or linting of its own.

The intent is nonetheless legitimate. A DCS project knows which globals the sim
provides per environment — hooks get `DCS`, `net`, `log`, `lfs`; mission gets
`env`, `timer`, `trigger`, `world` — and the editor should not flag them.

This is grouped with [#79](https://github.com/flying-dice/dcs-studio/issues/79)
on card 43 because the two write the same list. #79 makes unknown manifest
sections warn instead of being silently ignored, naming the nearest valid
section; whichever way this decision goes, `[lint]` ends up either a recognized
section or a suggestion in that warning. **Deciding this after building the
validation means editing that list twice and shipping, in between, a warning
that contradicts the docs.** That is why this blocks.

Two routes:

1. **Ship editor config in the project templates.** The scaffolds emit a
   `.luarc.json` (luals) or the relevant luabox config with the per-environment
   globals baked in. No runtime integration; it works the moment the project is
   created, and the template docs explain per-environment globals.
2. **A real `[lint]`/`[globals]` manifest section**, mirrored into the
   workspace's editor config whenever the manifest is saved. One source of
   truth — but the extension takes on writing third-party config files it does
   not own.

## Decision

**Proposed: route 1, ship the config in the templates** — awaiting the owner's
acceptance. The issue's own reading is that this is "cheapest and probably
right", and it is consistent with the standing position that editor tooling is
not ours.

Route 2's single-source-of-truth appeal is real, and it is the reason this is
worth a record rather than a shrug. It is declined because the extension would
be writing and re-writing a file owned by whichever Lua tool the user happens to
run — a file they may hand-edit, that has no schema we control, and whose format
differs between luals and luabox. Mirroring on every manifest save turns their
editor config into a generated artifact, and the failure mode is silently
clobbering a customization.

Under route 1, `[lint]` stays an **unrecognized** section — so #79's warning must
name it usefully rather than generically: it should point at the emitted editor
config, not merely say the section does not exist.

## Consequences

- Card 43's validation work gets an unambiguous section list, and can proceed as
  soon as this is accepted.
- Existing projects created before this lands get nothing automatically. Either
  a "write editor config" command or a documented snippet is needed, or the
  feature only ever helps new projects.
- Choosing which tool's config to emit is a follow-on question: luals
  (`.luarc.json`) is the broadest target, luabox is what the owner hit LB0509
  with. Emitting both is possible and probably kinder than picking.
- The per-environment globals list becomes content we maintain — when DCS adds a
  global, the templates go stale. It belongs next to the environment definitions
  the bridge already knows about rather than duplicated in template files.
- If the owner picks route 2 instead, `[lint]` becomes a recognized section and
  #79's list must include it from the start — the same list, edited once, which
  is the whole reason for deciding first.
