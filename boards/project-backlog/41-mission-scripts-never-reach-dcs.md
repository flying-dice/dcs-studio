---
column: todo
labels: [bug, extension, lua]
priority: high
review-verdict: pending
updatedAt: 2026-08-05T19:25:09.000Z
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

Note that `src/mission/missionPanel.ts` is **not** a panel despite the filename:
it is a set of commands (`dcs.mission.open`, `.desanitize`, `.sanitize`,
`.restore`, `.hooks.install`, `.hooks.remove`) that toggle the sanitize block as
a whole and otherwise open the raw file in the editor. Those commands stay —
they are the scriptable surface — and the new panel drives the same service
rather than forking the logic.

**The hard requirement drives the test plan, and it is owner-stated: existing
user-modified files must keep working as-is.** People hand-edit this file today.
Never rewrite anything outside the line being toggled; render unrecognized lines
as honest "unmanaged content" rather than normalizing them away; open → toggle →
untoggle must be byte-identical. Tests over a corpus of REAL files — stock per
DCS version, desanitized variants, third-party loader lines, mixed EOL and
indent — asserting untouched bytes outside the edited line.

## The shape is decided

[Decision 10](../../decisions/10-where-missionscripting-is-managed.md) is
**Accepted**: a dedicated **MissionScripting** webview panel with controls for
the file — named for the file it owns rather than extending `dcs.mission.*`,
which is a broader namespace about mission things generally.

Its controls are the file's whole managed surface: per-item sanitize toggles,
the #73 trigger lines and their status, restore-original and view-backup, and an
honest unmanaged-content region. Nothing blocks this card now.

## Checklist

- [x] Decision 10 accepted — dedicated MissionScripting panel
- [ ] New panel: own view type, open command, contract entry and census row
- [ ] `triggerStatus` consulted on enable/install and My Mods refresh
- [ ] Blocking-severity nudge with one-click `installMissionHooks`, deep-linking to the management screen
- [ ] Healthy state visible too, not only the broken one
- [ ] Per-item sanitize toggles over the existing `missionSanitize` machinery
- [ ] Unmanaged-content state for lines the domain does not recognize
- [ ] Round-trip byte-identity test over a corpus of real modified files
- [ ] Docs name the two managed files and the trigger lines

## Comments

- **claude** (2026-08-05T19:07:50.000Z): Raised from the v0.17.0 QA batch, grouped with #74 rather than split. Worth flagging for whoever picks it up: #73 is **not** a "build the mechanism" ticket — the mechanism is complete and correct, and the entire bug is that nothing consults `triggerStatus`. Reading the issue title alone would send someone re-implementing `missionScriptTrigger.ts`.
- **claude** (2026-08-05T19:25:09.000Z): Decision 10 accepted by the owner — a dedicated **MissionScripting** webview panel with controls for the file. Sharper than the record proposed it: I had written "a dedicated Mission webview panel", and naming it after the file rather than the domain is the better call, because `dcs.mission.*` already exists as a broader namespace and a panel called Mission would imply it owns all of it. Updated `decisions/10-where-missionscripting-is-managed.md` to Accepted with that naming, and the index row with it. Card unblocked — both halves can now be built together.
