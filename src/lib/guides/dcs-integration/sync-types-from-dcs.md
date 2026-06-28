# Sync Types from DCS

Sync Types pulls authoritative Lua type definitions straight from the running DCS build and writes them into your project, so the editor's hover and diagnostics match the exact game and bridge version you are connected to — with no manual upkeep.

## Running a sync

1. Start DCS with the bridge connected — see the **Injecting the bridge** and **Managed Launch (DCS)** guides.
2. Open a project.
3. Choose **Run → Sync Types from DCS**, or click the **Types** indicator in the status bar.

The action reads the running build's identity, pulls the type definitions over the live link, writes them under your project, and re-indexes — all without reopening the project.

## What it writes

A sync writes one fixed file:

```
types/generated/dcs.d.lua
```

This path is constant and internal. It lives in `types/generated/`, which is kept separate from the hand-written `types/*.d.lua` stubs a project scaffolds — so a sync can only ever land in the generated file and can never clobber a stub you maintain by hand.

The generated file carries a version stamp in a header comment recording the bridge DLL version and the DCS `_APP_VERSION` it came from. Drift is judged against this stamp.

## Fail-closed: start DCS first

The sync needs a live sim. If the link is down, it refuses and **writes nothing**, surfacing the message:

```
Start DCS first — live type sync needs a running sim link
```

This is deliberate: rather than overwrite your types with stale or empty data, the sync does nothing until a sim is available. The menu item stays enabled while a project is open so the prompt can guide you; it is disabled only while a sync is already in flight.

## The status-bar indicator

The **Types** chip in the status bar reflects how your synced types compare with the *running* build (never a byte comparison of files on disk):

- **Types: synced** (green) — your types match the running build.
- **Types: drift** (amber) — you synced earlier, but the running bridge or DCS version has changed. The tooltip names exactly which moved, e.g. `DCS 2.9.1 → 2.9.2`. Click to re-sync.
- **Types: offline** (grey) — synced before, but DCS is not running, so the running build is unknown. Your last sync still resolves hover offline; this is not an alarm.
- **Types: not synced** (grey) — nothing has ever been synced for this project.
- **Types: syncing…** (pulsing) — a sync is in flight.

Click the chip to run a sync (the same as the menu action).

## After a sync

The new definitions take effect immediately — the language layer re-indexes the project in place, so hover reflects the new types without a reopen. When DCS later shuts down, hover keeps resolving against the last synced types; only a *new* sync requires a running sim again.

## Not yet implemented

Live sync delivers authoritative **hover** and **diagnostics** from the running sim. **Autocomplete** from the synced types is not yet available — it depends on a completion query the engine does not expose yet, tracked as a separate engine ticket. The generated `.d.lua` powers hover the moment it is written; completion will follow when that capability lands.

## Tips and gotchas

- **Keep your hand-written stubs.** They live outside `types/generated/` and are never touched by a sync.
- **Re-sync after updating DCS or the bridge.** A drift indicator is your cue.
- The synced definitions feed the editor's hover and inline diagnostics; see the Language intelligence guide for how those surface as you type.
