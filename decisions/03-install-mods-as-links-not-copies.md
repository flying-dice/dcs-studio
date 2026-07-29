---
status: Accepted
date: 2026-07-14
---
# Decision 03 — Install mods as links, tracked in a JSON ledger

## Context

A DCS mod is files that have to appear in specific places under the DCS Saved
Games and installation folders. The naive install copies them there. That makes
"disable" mean "delete and remember what you deleted", makes "uninstall cleanly"
a guess, and makes a half-finished install indistinguishable from a working one.

DCS users also break things. The recovery story matters as much as the install
story — a user with a sim that will not boot needs a way back that does not
depend on the extension still working.

Dated from `158f6dd` ("BREAKING: drop legacy `[[install]]` manifest support —
bundle/symlink only"), which is where the copy-based path was removed.

## Decision

Installs are **links** into the DCS folders, never copies. `LinkerPort`
(`src/adapters/node/linker.ts`) picks a junction, hardlink or symlink per target
and rolls back the whole set if any one fails; the strategy is a pure rule in
`src/core/domain/linkStrategy.ts`.

The manifest (`dcs-studio.toml`) declares two separate things: what gets
**bundled** into a release, and what gets **linked** into DCS on install — so it
is both the build recipe and the install plan a user sees before downloading.

State lives in one file. `SubscriptionLedgerStore`
(`src/adapters/node/jsonLedgerStore.ts`) persists
`Record<lowercased repo, Subscription>` to `<dataDir>/subscriptions.json`, and
derives `uninstall-all.bat` beside it — an escape hatch that removes every DCS
Studio link without the editor being involved at all.

Both formats are frozen (`ARCHITECTURE.md:189-190`).

## Consequences

- Disable is instant and never touches downloaded files; the payload stays put
  and re-enabling relinks it.
- Uninstall is exact rather than best-effort, because the ledger says precisely
  what was linked.
- Windows-only, and unavoidably so: junctions and the whole path model assume it.
- Links can be broken from outside — a user moving a folder, or DCS holding one
  open — so the linker needs rollback and the uninstall path needs to cope with
  links that are already gone (#31).
- The frozen formats are a real constraint: a change to either strands existing
  installs, so the ledger's shape is a compatibility surface, not an
  implementation detail.
- Emitting `uninstall-all.bat` is deliberately *not* on `SubscriptionLedgerStore`
  — a non-file backend may have no script to offer, so the My Mods panel takes
  that capability structurally instead (`ARCHITECTURE.md:42-49`).
