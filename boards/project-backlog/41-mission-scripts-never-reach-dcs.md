---
column: todo
labels: [bug, extension, lua]
priority: high
review-verdict: pending
updatedAt: 2026-08-05T19:07:50.000Z
---
# Mission scripts never reach DCS, and the file that hooks them is hand-edited

Covers [#73](https://github.com/flying-dice/dcs-studio/issues/73) (bug) and
[#74](https://github.com/flying-dice/dcs-studio/issues/74) (enhancement). They
are one card because #74 is where #73's fix has to land: #73 is the **push**
(nudge the user when the hooks are missing), #74 is the **place** (the screen
that owns `MissionScripting.lua`), and #73's nudge is specified to deep-link
into it. Building the nudge with nowhere to send the user means building it
twice.

## #73 — the feature silently does nothing

The whole chain is already implemented: `src/core/domain/missionScriptAggregator.ts`
regenerates the two managed files in `Saved Games/DCS/Scripts` from the enabled
mod set, and `src/core/domain/missionScriptTrigger.ts` knows how to install the
two `dofile` trigger lines into `<gameInstall>/Scripts/MissionScripting.lua`,
idempotently and backup-first. `installMissionHooks`
(`src/mission/missionPanel.ts:210`) exposes it as a command.

**The trigger install is passive.** `MyModsPresenter` and the install flow never
consult `triggerStatus`, so a user can install and enable a mod with
`[[mission_script]]` entries, watch the aggregators regenerate correctly, and
have DCS never read them — with no error anywhere. The person who designed the
mechanism hit this in QA and could not see how it hooked in.

## #74 — the screen it needs

Per-item toggles over the sanitize lockdown (`os`, `io`, `lfs`, `loadlib`,
`require`) instead of a Lua file the user hand-edits with `--`. The pure
machinery exists in `src/core/domain/missionSanitize.ts` (`ITEMS`, per-line
state detection) and `missionSanitizeService` (backup-first, stamped) — this is
the UX over it, with the trigger lines from #73 shown in the same view.

**The hard requirement drives the test plan, and it is owner-stated: existing
user-modified files must keep working as-is.** People hand-edit this file today.
Never rewrite anything outside the line being toggled; render unrecognized lines
as honest "unmanaged content" rather than normalizing them away; open → toggle →
untoggle must be byte-identical. Tests over a corpus of REAL files — stock per
DCS version, desanitized variants, third-party loader lines, mixed EOL and
indent — asserting untouched bytes outside the edited line.

## Checklist

- [ ] `triggerStatus` consulted on enable/install and My Mods refresh
- [ ] Blocking-severity nudge with one-click `installMissionHooks`, deep-linking to the management screen
- [ ] Healthy state visible too, not only the broken one
- [ ] Per-item sanitize toggles over the existing `missionSanitize` machinery
- [ ] Unmanaged-content state for lines the domain does not recognize
- [ ] Round-trip byte-identity test over a corpus of real modified files
- [ ] Docs name the two managed files and the trigger lines

## Comments

- **claude** (2026-08-05T19:07:50.000Z): Raised from the v0.17.0 QA batch, grouped with #74 rather than split. Worth flagging for whoever picks it up: #73 is **not** a "build the mechanism" ticket — the mechanism is complete and correct, and the entire bug is that nothing consults `triggerStatus`. Reading the issue title alone would send someone re-implementing `missionScriptTrigger.ts`.
