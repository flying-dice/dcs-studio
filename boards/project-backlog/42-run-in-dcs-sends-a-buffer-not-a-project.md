---
column: todo
labels: [bug, extension]
priority: high
review-verdict: pending
updatedAt: 2026-08-05T19:07:50.000Z
---
# Run in DCS sends a buffer, not a project

[Issue #78](https://github.com/flying-dice/dcs-studio/issues/78), on its own —
the two tickets it spawned during triage (#79, #80) are card 43, because they
are about the manifest schema rather than about what Run in DCS does.

## What it actually is

`dcs.debug.runGui`/`runMission` → `startSession` (`src/debug/factory.ts:113-141`)
→ a DAP session whose adapter sends **the file's text** to the live sim over the
bridge (`debug_run`). It deploys nothing — not the manifest's entries, and not
even the right-clicked file.

For a self-contained script that model is exactly right, and fast. For a project
whose entry file loads siblings from `lfs.writedir()` it fails at the first
`dofile`/`require` with no hint that the dependencies were never put on disk.
Reproduced in QA with the `lua-hook` template: hook in `Scripts/Hooks/`, module
in `Scripts/hello_world_lua_hook/utils.lua`, and
`no file '…\Scripts\hello_world_lua_hook\utils.lua'`. The Lua was correct; the
file simply was not there.

The QA session's file was in Saved Games from an **earlier manual copy** — which
is why the failure looked like a deployment bug rather than a missing feature.

## Fix direction — layered, cheapest first

1. **Name the semantics where the user is looking.** Run/Debug editor titles and
   the run-lua docs page say it sends this file's source to the live sim, and
   that files it loads from disk must already be installed.
2. **Warn on the failure shape we can predict.** When the project's manifest has
   `[[symlink]]` entries whose dest files are missing or stale against their
   sources, warn before launch and point at the install/enable action.
3. **Consider a real dev-deploy action** — "Install project to Saved Games
   (dev)", applying the manifest's symlink rules from the *workspace* rather
   than a release bundle, so multi-file hook development has a supported loop:
   edit → dev-install (links, so edits stay live) → Run in DCS.

Steps 1 and 2 are ready to build. **Step 3 is a design decision and is likely
the actual want behind the report** — do not let the cheap steps close the card
without a deliberate answer on it.

## Blocked on a decision

[Decision 11](../../decisions/11-dev-deploy-for-run-in-dcs.md) (**Proposed**) —
whether the dev-deploy action gets built. It decides whether this is a
day-long docs-and-warning card or a feature card. Layers 1 and 2 are honest on
their own and can start now.

## Checklist

- [ ] Run/Debug titles and the run-lua docs state the send-the-buffer semantics
- [ ] Pre-launch warning when `[[symlink]]` dests are missing or stale
- [ ] Decision 11 accepted or declined — dev-deploy built, or the gap documented deliberately

## Comments

- **claude** (2026-08-05T19:07:50.000Z): Raised from the v0.17.0 QA batch. Kept separate from card 43 even though #78's triage is what produced #79 and #80: this card is about what Run in DCS does, that one is about what the manifest recognizes, and they touch different code. One detail from the issue worth not losing — the mangled `…utils.lua'utils` line in the require trace was verified present in the RAW dcs.log, so it is DCS's own logger, not our log pipeline. No ticket needed for it.
