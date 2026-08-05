---
status: Proposed
date: 2026-08-05
---
# Decision 11 — Whether Run in DCS gains a dev-deploy companion

## Context

[Issue #78](https://github.com/flying-dice/dcs-studio/issues/78), board card 42.
Run in DCS (`dcs.debug.runGui`/`runMission` → `startSession`,
`src/debug/factory.ts:113-141`) opens a DAP session whose adapter sends **the
file's text** to the live sim over the bridge. It deploys nothing — not the
manifest's entries, not even the right-clicked file.

For a self-contained script that is exactly right, and fast. For a project whose
entry file loads siblings from `lfs.writedir()` it fails at the first
`dofile`/`require`, and the QA report was precisely that shape: a `lua-hook`
template project with its module in `Scripts/hello_world_lua_hook/utils.lua`,
failing with `no file '…\Scripts\hello_world_lua_hook\utils.lua'`. The Lua was
correct. The file was never put there.

The issue's fix direction is layered, and the first two layers are not in
question — name the semantics in the Run/Debug titles and the run-lua docs, and
warn before launch when the manifest's `[[symlink]]` dests are missing or stale.
Those are cheap and unambiguously right.

The third is a fork, and the issue flags it as "likely the actual want behind the
report": an **"Install project to Saved Games (dev)"** action, applying the
manifest's symlink rules from the *workspace* rather than from a release bundle,
so multi-file hook development has a supported loop — edit → dev-install (links,
so edits stay live) → Run in DCS.

This blocks card 42 in a specific way: it decides whether that card is a
documentation-and-warning card that closes in a day, or a feature card that
introduces a second deployment path into the product.

The relevant prior art is [decision 03](03-install-mods-as-links-not-copies.md):
mods install as junctions and hardlinks tracked in a JSON ledger, precisely so
disable and uninstall are exact rather than a guess. A dev-install would be a
second writer to the same Saved Games tree.

## Decision

**Proposed: build it, and make it a first-class citizen of the existing ledger
rather than a parallel mechanism** — awaiting the owner's acceptance.

The warning in layer 2 tells a developer their project is not deployed and then
offers them nothing but the mod-install flow, which is built around an installed
*release*, not a working tree. Shipping layers 1–2 alone leaves the reported
workflow still unsupported, better explained.

The condition on the proposal is the ledger. A dev-install that writes links
Saved Games without recording them reintroduces exactly the guesswork decision 03
exists to remove — with the extra hazard that its link targets are inside the
user's workspace, so an uninstall that guesses wrong deletes source files.

## Consequences

- Layers 1 and 2 are unblocked immediately and should ship regardless of how this
  is decided; they are honest on their own.
- Accepting this puts a second entry into the install ledger's vocabulary — a
  dev-installed project is not a mod release and must be distinguishable, or
  uninstall/repair logic will treat a workspace as a mod.
- Link direction matters: dev links point *into the workspace*, so removal must
  never follow a link when deleting. This wants an explicit test, not care.
- It creates a supported answer to "how do I iterate on a multi-file hook",
  which the product currently lacks entirely.
- If the owner declines, card 42 closes with layers 1–2 and the docs must say
  plainly that multi-file projects are installed via My Mods before running —
  the gap becomes documented rather than fixed, which is a legitimate outcome
  but should be a choice, not a default.
