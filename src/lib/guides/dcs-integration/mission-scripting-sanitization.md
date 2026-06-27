# Mission Scripting sanitization

By default, DCS removes ("sanitizes") several powerful Lua features from the mission scripting environment, so missions cannot read your disk or load native code. While you are developing a mod, you often need those features back. The Mission Scripting manager toggles DCS's sanitization block for you, file by file, and keeps a pristine backup so you can restore the stock file at any time.

## What sanitization is

DCS ships a `Scripts\MissionScripting.lua` in each install that disables six items before any mission script runs:

- `os`, `io`, `lfs` — the OS, file I/O, and filesystem libraries (via `sanitizeModule`).
- `require`, `loadlib`, `package` — module loading (set to `nil`).

**Desanitizing** an item comments out its line, so DCS leaves that feature available to mission scripts. **Re-sanitizing** uncomments the line, restoring DCS's default protection.

## Opening the manager

In the right-hand tool rail, click the **Mission** icon. The panel lists the `MissionScripting.lua` files it found, with a per-item view and quick actions for the selected file.

## Finding the file

DCS Studio detects installs from the Eagle Dynamics registry entries first, then probes the usual Program Files locations (DCS World, OpenBeta, Server) on the C:, D:, and E: drives. Each row shows the install variant and a green check (the file exists) or a red cross (not found there).

If your install is not listed, use **Locate MissionScripting.lua…** (the file-plus button) to pick the file directly. **Refresh** (the circular-arrow button) re-scans.

## Toggling items

For the selected file, each of the six items shows a coloured dot, a state label, and a switch:

- Amber dot, **sanitized** — DCS will disable this item (the line is active).
- Green dot, **desanitized** — the item is available to scripts (the line is commented out).
- Grey dot, **not found** — no matching line exists in this file; its switch is disabled.

Flip a switch to toggle one item. Confirmation appears inline, e.g. *"lfs desanitized."* or *"require re-sanitized."*

Two quick actions apply to every present item at once:

- **Desanitize all** — enabled while anything is still sanitized.
- **Re-sanitize all** — enabled while anything is desanitized.

Edits preserve the file's indentation and its dominant line ending, and touch only the sanitization lines — nothing else in the file changes.

## Backup and restore

The first time you change a file, a pristine copy is saved next to it as `MissionScripting.lua.dcsstudio.bak` *before* anything is written. Once a backup exists, a **Restore stock** button appears; it copies the backup back over the live file, returning it to the exact stock state.

## Administrator rights

If the file is not writable — typically because the install lives under Program Files — the panel warns:

```
Requires administrator rights — restart DCS Studio as admin to edit this file.
```

Restart DCS Studio as an administrator and try again.

## Tips and gotchas

- **This affects multiplayer.** As the panel notes, editing `MissionScripting.lua` disables multiplayer integrity checks.
- **DCS updates revert it.** A game update can replace `MissionScripting.lua`, re-sanitizing it. Re-apply your changes (or keep the backup) after updating.
- This is separate from the bridge — see the **Injecting the bridge** guide for the editor-to-sim link, which does not require desanitizing anything.
