---
column: todo
labels: [bug, extension, docs]
priority: high
review-verdict: pending
updatedAt: 2026-08-05T19:30:05.000Z
---
# The manifest ignores what it doesn't understand, in silence

Covers [#79](https://github.com/flying-dice/dcs-studio/issues/79).

It was raised covering [#80](https://github.com/flying-dice/dcs-studio/issues/80)
as well, because #80 looked like it decided a name #79's validation would have
to know. [Decision 12](../../decisions/12-no-participation-in-editor-lint.md)
settled that differently and better: **DCS Studio does not participate in editor
lint at all**, so `[lint]` is not a reserved name, not a special case, and not a
suggestion — it is an ordinary unknown section that this card's warning treats
like any other. #80 is out of scope and should be closed against that record.

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

## `[lint]` gets no special treatment

The other section the owner wrote from memory was `[lint]`, and it is worth
saying explicitly what this card must **not** do with it. Per
[decision 12](../../decisions/12-no-participation-in-editor-lint.md), DCS Studio
does not participate in editor lint: no emitted `.luarc.json`, no `[lint]`
section, no mirroring of third-party editor config. luabox owns that area.

So `[lint]` is not reserved, not suggested, and not mentioned in any special
case. The warning names it as an unknown section exactly as it names
`[[install]]`. Anything else would re-open a door the decision closed.

## Nothing blocks this card

Decision 12 is Accepted, and it was the only fork here. The section list has one
uncontested source — the real schema — so this can start today.

## Checklist

- [x] Decision 12 accepted — no lint participation, `[lint]` is an ordinary unknown
- [ ] Unknown top-level sections warn, naming the section and nearest valid one
- [ ] Unknown keys inside known sections warn the same way
- [ ] Form editor inline, publish preflight row, marketplace install-plan flag
- [ ] Unknown never rejects — forward compatibility test with a future-looking manifest
- [ ] `[lint]` carries no special case anywhere in the validation

## Comments

- **claude** (2026-08-05T19:07:50.000Z): Raised from the v0.17.0 QA batch. Sequencing note for whoever picks it up: take the `[lint]` decision FIRST even though #79 is the bug and #80 the enhancement. The validation's section list is the thing both tickets write to, and doing it in the other order guarantees touching it twice.
- **claude** (2026-08-05T19:30:05.000Z): The owner settled the `[lint]` fork by rejecting its premise rather than picking a route: DCS Studio does not participate in editor lint at all, luabox owns it, and a separate `.d.lua` definitions repo may be referenced in future without this project integrating anything. Decision 12 rewritten and renamed to `12-no-participation-in-editor-lint.md`, status **Accepted**. This card drops to #79 alone, is unblocked, and gains one *negative* requirement worth keeping: `[lint]` must carry no special case — no reservation, no suggestion. Verified nothing has to be unwound first: nothing under `src/` emits or reads `.luarc.json`/luals/luabox config, so the position is already implemented by having done nothing. **#80 should be closed as out of scope against decision 12** — left open rather than closed unilaterally, since it is the owner's tracker.
