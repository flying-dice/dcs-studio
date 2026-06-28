# Injecting the bridge

The bridge is the small piece of DCS Studio that runs *inside* DCS World. Once it is installed and DCS is restarted, the editor can talk to the live sim — that link powers the **Lua Console**, the **In-sim Lua Debugger**, the **Inspect console**, **Sync Types from DCS**, the **Database browser**, and the **DCS Log viewer** (each covered by its own guide). The Injection Manager installs, updates, and removes the bridge for you, replacing the old manual deploy script.

## What the bridge is

The bridge is two files written into a DCS *write directory* (your `Saved Games\DCS` folder, not the game install):

- **Bridge DLL** — `Mods\tech\DcsStudio\bin\dcs_studio.dll`. The native module the editor connects to over the editor-to-sim link.
- **Export hook** — `Scripts\Hooks\DcsStudio.lua`. DCS runs every Lua file in `Scripts\Hooks` at startup; this GameGUI hook loads the bridge DLL into the running sim.

Both must be present and current for the link to work, and DCS only loads them at startup — so a fresh install or an update always needs a DCS restart.

## Opening the Injection Manager

In the right-hand tool rail, click the **Inject** icon. The panel has three parts: the list of detected installs, the bridge artifact status, and (below it) the managed launch controls described in the **Managed Launch (DCS)** guide.

## Choosing an install

DCS Studio scans `%USERPROFILE%\Saved Games` for write dirs named `DCS` or `DCS.<variant>` (for example `DCS.openbeta`). Plain `DCS` is listed first, then variants alphabetically.

- A green check next to a row means the folder looks like a real DCS write dir (it contains a `Config` subfolder). A red cross means it might not be one.
- Use **Add folder…** (the folder-plus button) to point at a write dir manually if yours is not auto-detected.
- Use **Refresh** (the circular-arrow button) to re-scan.

If nothing is found you will see *"No DCS write dirs found in Saved Games. Use 'Add folder…' to point at one manually."*

## Reading the status

Under the selected install, the header shows the bridge version this build of the app would install (for example **Bridge v1.2.0**), followed by two rows:

- **Bridge DLL**
- **Export hook**

Each row has a coloured dot and a label:

- Grey dot, **not installed** — the file is absent.
- Amber dot, **update available** — installed, but it does not match this build. The DLL is compared byte-for-byte; the hook is compared with line endings normalised, so a CRLF checkout never reads as stale on its own.
- Green dot, **up to date** — installed and current.

## Installing or updating

Click the primary button. Its label reflects what will happen:

- **Inject** — nothing is installed yet.
- **Update** — something is installed but out of date.
- **Reinstall** — everything is already current.

On success you will see *"Bridge installed. Restart DCS to load it."* The button is disabled while a previous action is still running.

If the source DLL has not been built, the button is disabled and a hint appears:

```
Build the DCS Studio DLL: cargo build -p dcs-bridge --release
```

Run that command, then click **Refresh** and try again.

## Removing the bridge

When anything is installed, an **Eject** button appears. It deletes the DLL and the hook (missing files are fine) and tidies the now-empty `Mods\tech\DcsStudio` folder, then reports *"Bridge removed."*

## The DCS link readout

Below the actions, a small **DCS link** line mirrors the status-bar indicator:

- **offline** — the editor is not connected to a bridge.
- **connected** — the bridge is loaded and DCS is at the menu.
- **mission running** — the bridge is loaded and a mission is live.

## Tips and gotchas

- **A restart is required.** Injecting copies files; DCS only loads hooks at startup. Quit and relaunch DCS after an Inject or Update.
- **A running DCS locks the DLL.** If the bridge is already loaded, the file cannot be overwritten. The Injection Manager surfaces the locked-file error rather than silently failing — stop DCS first, then update.
- **Prefer the launcher.** **Managed Launch (DCS)** injects, starts DCS, and cleans up on exit in one step, so you rarely need to inject by hand.
