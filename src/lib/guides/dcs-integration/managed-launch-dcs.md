# Managed Launch (DCS)

Managed Launch starts DCS World for you with the bridge already injected and a lightweight graphics profile applied, then puts everything back the way it was when DCS exits. It is the fastest way to get from the editor to a live sim connection without touching files by hand.

## Where to find it

Managed Launch lives at the bottom of the **Inject** panel. Open it from the right-hand tool rail (the **Inject** icon), select your DCS install at the top, and scroll to the **Launch** section. See the **Injecting the bridge** guide for how install detection and the bridge artifacts work.

## What one launch does

When you click **Launch DCS (windowed, low-spec)**, DCS Studio performs these steps in order:

1. **Injects the bridge** into the selected write dir if it is missing or out of date.
2. **Backs up your graphics config** — `Config\options.lua` is copied once to `Config\options.lua.dcs-launcher.bak`, a pristine snapshot.
3. **Writes a low-spec windowed profile** — only the `options.graphics` block is replaced (windowed, low detail). Every other setting in `options.lua` is left untouched. DCS has no command-line switch for windowed or low-detail mode, so this is done by editing the config.
4. **Starts DCS** — it spawns `bin\DCS.exe` from your detected game install.

You will see the notice *"DCS launching — windowed, low-spec."* and a **running** badge appears next to the Launch header.

## Why low-spec and windowed

A managed launch is for iterating on scripts, not for flying. A windowed, low-detail DCS starts faster, stays out of the way beside the editor, and leaves more of your machine for the IDE. The profile is fixed — there are no options to tune here.

## Stopping DCS

While a launched session is running, the button becomes **Stop DCS**. Clicking it kills the DCS process and runs the same teardown a normal exit would. You will see *"DCS stopped — bridge ejected, config restored."*

## What happens on exit

Whether DCS closes on its own or you click **Stop DCS**, the launcher cleans up once per session:

- The **bridge is ejected** (best effort — a failed eject never blocks the next step).
- Your **original `options.lua` is restored** from the pristine backup. This runs *after* DCS has exited, so it overwrites the copy DCS writes on its own shutdown.

Because cleanup is guarded to run a single time, an explicit Stop and the automatic on-exit watcher can never double-eject or double-restore.

## When launch is blocked

The Launch button is disabled, with a short reason, when:

- **The bridge DLL has not been built** — build it first (see the **Injecting the bridge** guide).
- **DCS is already running** — the panel shows *"DCS is already running — stop it before launching from here."* A live DCS holds the bridge DLL locked, so the launcher fails closed: it surfaces the locked-DLL error and leaves your `options.lua` untouched rather than disturbing a running sim.

## Tips and gotchas

- **One session at a time.** The launcher manages a single DCS child process.
- **Your settings are safe.** Only the graphics block is swapped, and your original config is always restored from the backup on exit.
- **If a launch is interrupted mid-step**, the launcher restores the backup before returning the error, so a half-applied config does not survive.
- After the sim is up, use the **Lua Console**, the **In-sim Lua Debugger**, or **Sync Types from DCS** against the live connection, and watch the **DCS Log viewer** for in-sim output.
