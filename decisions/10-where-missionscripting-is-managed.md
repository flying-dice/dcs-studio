---
status: Proposed
date: 2026-08-05
---
# Decision 10 — Where the MissionScripting.lua management UX lives

## Context

[Issue #74](https://github.com/flying-dice/dcs-studio/issues/74) asks for a
surface that manages `MissionScripting.lua` "so people can manage it without
knowing the syntax for comments etc to enable/disable sanitisation", and
[#73](https://github.com/flying-dice/dcs-studio/issues/73) needs somewhere for
its "your mission scripts will not run" nudge to deep-link to. Board card 41
carries both. Nothing can be built until this is answered, because the answer
decides whether there is a new webview contract at all.

What exists today is **not** a panel. `src/mission/missionPanel.ts` is a set of
commands — `dcs.mission.open`, `.desanitize`, `.sanitize`, `.restore`,
`.hooks.install`, `.hooks.remove` — which operate on the **whole** sanitize
block and otherwise open the raw file in the editor for the user to hand-edit.
The per-item machinery already exists underneath in
`src/core/domain/missionSanitize.ts` (`ITEMS`, per-line state detection that
recognizes each lockdown statement commented or uncommented) and
`missionSanitizeService` (backup-first, stamped). So this is a UX gap over a
complete domain, not missing logic.

Three shapes were considered:

1. **A new Mission webview panel.** Own view type, own contract entry and census
   row, per-item toggle rows, the #73 trigger lines in the same view, and
   restore/view-backup affordances.
2. **A section inside the existing Setup panel.** Setup is already a webview and
   already the home for machine-level DCS configuration, which this file is —
   it lives under the game install, not the workspace.
3. **Stay command-driven.** A QuickPick multi-select over `ITEMS` plus a status
   line. No new panel, no new contract, no DOM.

The file's constraint cuts across all three and is owner-stated: **existing
user-modified files must keep working as-is.** People hand-edit this file today
— reordered lines, third-party loader `dofile`s, mixed EOL and indent styles.
Whatever surface is chosen must never rewrite anything outside the line it is
toggling, must render unrecognized lines as honest unmanaged content rather than
normalizing them away, and must round-trip byte-identically.

## Decision

**Proposed: option 1, a dedicated Mission webview panel** — awaiting the owner's
acceptance.

Option 3 is cheapest and is genuinely tempting, but a QuickPick cannot show the
"unmanaged content" state, and that state is the whole safety story for a file
users hand-edit. A surface that silently omits the lines it does not understand
teaches the user it manages the file, when it manages part of it.

Option 2 is the closest call. Setup is the right *category* — this is machine
configuration, not project configuration. It is rejected on size: per-item
toggles, trigger-line status, backup affordances and an unmanaged-content region
are a screen, not a section, and folding them into Setup makes Setup the panel
that does everything.

## Consequences

- A new panel means a new webview contract partition and a census row. That is
  the cost the architecture imposes deliberately, and it is the same cost
  decision 13 pays for the Explorer.
- #73's nudge gets a stable deep-link target, so that ticket stops being blocked
  on "where does this go".
- The existing `dcs.mission.*` commands stay — they are the scriptable surface
  and several are already bound. The panel drives the same service; it does not
  fork the logic.
- The round-trip guarantee becomes a **test corpus obligation**, not a
  code-review promise: stock file per DCS version, desanitized variants, files
  with third-party loader lines, mixed EOL and indent, each asserting untouched
  bytes outside the edited line.
- If the owner picks option 3 instead, card 41 shrinks by roughly a panel's worth
  of work and #73's nudge deep-links to a command rather than a view — acceptable,
  at the price of never being able to show unmanaged content honestly.
