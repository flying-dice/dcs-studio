---
column: todo
labels: [bug, extension, docs]
priority: high
review-verdict: pending
updatedAt: 2026-08-05T19:07:50.000Z
---
# The manifest ignores what it doesn't understand, in silence

Covers [#79](https://github.com/flying-dice/dcs-studio/issues/79) (bug) and
[#80](https://github.com/flying-dice/dcs-studio/issues/80) (enhancement).
Grouped because #80 decides a name that #79's validation has to know: whichever
way `[lint]` goes, it ends up either a recognized section or a suggestion in the
unknown-section warning. Building the validation first and deciding `[lint]`
later means editing the same list twice and shipping a warning that contradicts
the docs in between.

## #79 — silent unknown sections

The owner — who designed the product — wrote `[[install]]` and `[lint]` sections
in `dcs-studio.toml` from memory of what felt natural. Neither exists. The real
schema is `[[bundle]]`, `[[symlink]]`, `[[entrypoint]]`, `[[mission_script]]`,
`[requires]`.

**Nothing said so.** The form editor, the publish preflight and the installer all
ignored them without a word, and the resulting confusion presented as a
deployment bug — that is [#78](https://github.com/flying-dice/dcs-studio/issues/78),
card 42. If the designer trips on this, users will.

Warn at every reader, naming the section and the nearest valid one
("`[[install]]` is not a manifest section — files ship via `[[bundle]]` and land
via `[[symlink]]`"). Typo-distance suggestions are cheap against a fixed list.

**Never hard-fail.** An older extension reading a newer manifest must keep
working, so unknown = warn. Silent unknown is the bug; rejection would be a
worse one.

## #80 — the intent behind `[lint]`

`[lint] globals = ["log", "DCS", "net", "lfs"]` did not clear luabox's LB0509
`undefined-global` warnings, because there is no lint integration at all — by
design, editor concerns stay native/third-party. Expected today, but the intent
is legitimate: a DCS project knows which globals the sim provides per
environment (hooks: `DCS`, `net`, `log`, `lfs`; mission: `env`, `timer`,
`trigger`, `world`).

Two routes, and this card's first job is to pick one:

1. **Ship editor config in the project templates** — scaffolds emit `.luarc.json`
   with per-environment globals baked in. No runtime integration, works the
   moment the project is created. Cheapest, and the issue's own guess at right.
2. **A real `[lint]`/`[globals]` manifest section** mirrored into the workspace's
   editor config on save. Single source of truth, but the extension takes on
   writing third-party config files it does not own.

## Blocked on a decision

[Decision 12](../../decisions/12-where-dcs-globals-are-declared.md)
(**Proposed**) — templates emit the editor config, or `[lint]` becomes a real
manifest section. **This one blocks the whole card, not half of it:** both
routes write the section list #79's validation is built from, so starting the
validation first guarantees editing it twice.

## Checklist

- [ ] Decision 12 accepted
- [ ] Unknown top-level sections warn, naming the section and nearest valid one
- [ ] Unknown keys inside known sections warn the same way
- [ ] Form editor inline, publish preflight row, marketplace install-plan flag
- [ ] Unknown never rejects — forward compatibility test with a future-looking manifest
- [ ] The `[lint]` decision reflected in the known-or-suggested section list

## Comments

- **claude** (2026-08-05T19:07:50.000Z): Raised from the v0.17.0 QA batch. Sequencing note for whoever picks it up: take the `[lint]` decision FIRST even though #79 is the bug and #80 the enhancement. The validation's section list is the thing both tickets write to, and doing it in the other order guarantees touching it twice.
