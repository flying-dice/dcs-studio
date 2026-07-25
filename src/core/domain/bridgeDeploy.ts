// Pure deploy/launch decision rules for the in-DCS bridge. The adapters
// (bridge/deploy.ts, bridge/launch.ts) own fs and child_process; everything
// here — install layout, built-vs-shipped DLL selection, locked-DLL error
// classification and messaging, launch arguments, eject-on-exit policy — is
// deterministic path/string math.

import { win32 as path } from "node:path";

// Install layout inside the DCS write dir (same layout dcs-studio uses).
// Two DLLs: the GUI bridge (loaded by the GameGUI hook) and the mission bridge
// (loaded into the mission scripting state by the hook's boot dispatch).
//
// LOCKSTEP: bridge/deploy/deploy.ps1 hard-codes this exact layout independently
// (DLL names, Mods\tech\DcsStudio\bin, Scripts\Hooks\DcsStudio.lua, the legacy
// artifacts). It's a standalone PowerShell dev-deploy, so a shared constant
// isn't feasible across the two runtimes — change one, change the other.
export const BRIDGE_DLLS = ["dcs_studio_gui.dll", "dcs_studio_mission.dll"] as const;
export type BridgeDllName = (typeof BRIDGE_DLLS)[number];

export const BIN_RELATIVE_DIR = path.join("Mods", "tech", "DcsStudio", "bin");
export const HOOK_RELATIVE_PATH = path.join("Scripts", "Hooks", "DcsStudio.lua");

/** Stale artifacts of earlier single-DLL installs, removed on inject AND eject:
 * the old DLL names (they'd bind port 25569 too) and the generated mission
 * boot file the old hook wrote. */
export const LEGACY_RELATIVE_PATHS: readonly string[] = [
  path.join(BIN_RELATIVE_DIR, "dcs_studio.dll"),
  path.join(BIN_RELATIVE_DIR, "dcs_bridge.dll"),
  path.join("Scripts", "DcsStudioMission.lua"),
];

/** Where `name` lands inside `writeDir`. */
export function dllInstallPath(writeDir: string, name: BridgeDllName): string {
  return path.join(writeDir, BIN_RELATIVE_DIR, name);
}

/** Where the hook script lands inside `writeDir`. */
export function hookInstallPath(writeDir: string): string {
  return path.join(writeDir, HOOK_RELATIVE_PATH);
}

/** Stale single-DLL-era artifacts to delete inside `writeDir`. */
export function legacyInstallPaths(writeDir: string): string[] {
  return LEGACY_RELATIVE_PATHS.map((p) => path.join(writeDir, p));
}

/** The freshly built workspace DLL inside the extension (one shared target dir). */
export function builtDllPath(extensionRoot: string, name: BridgeDllName): string {
  return path.join(extensionRoot, "bridge", "target", "release", name);
}

/** The prebuilt DLL shipped with the extension (staged into bridge/prebuilt). */
export function shippedDllPath(extensionRoot: string, name: BridgeDllName): string {
  return path.join(extensionRoot, "bridge", "prebuilt", name);
}

/** The DLL to install: the freshly built workspace artifact if present, else the shipped one. */
export function selectDll(
  extensionRoot: string,
  name: BridgeDllName,
  builtExists: boolean,
): string {
  return builtExists ? builtDllPath(extensionRoot, name) : shippedDllPath(extensionRoot, name);
}

/** The hook script source shipped with the extension. */
export function hookSourcePath(extensionRoot: string): string {
  return path.join(extensionRoot, "bridge", "hook", "DcsStudio.lua");
}

// ── Locked-DLL classification (DCS holds the bridge DLLs while running) ──

/** Whether an IO error means a DLL is locked by a running DCS (EBUSY/EPERM). */
export function isDllLockedError(e: unknown): boolean {
  const code = (e as { code?: string } | null | undefined)?.code;
  return code === "EBUSY" || code === "EPERM";
}

export const INJECT_LOCKED_MESSAGE =
  "Could not overwrite the bridge DLLs — DCS appears to be running. Close DCS and inject again.";

export const LAUNCH_LOCKED_MESSAGE = "A bridge DLL is locked — is DCS already running?";

/**
 * What an inject left behind when it failed part-way through. DCS loads the
 * two DLLs and the hook as a set, so a copy that fails after an earlier one
 * succeeded leaves a mixed install — the user has to be told which half moved.
 *
 * Nothing is rolled back: the failure that dominates here is a DLL held open by
 * a running DCS, and deleting the file DCS is currently executing would fail
 * for the same reason while destroying a working install.
 */
export function partialInstallMessage(installed: readonly string[]): string | undefined {
  if (!installed.length) return undefined;
  return ` The install is now mixed: ${fileList(installed)} ${installed.length === 1 ? "was" : "were"} replaced and the rest were not — inject again once the problem is fixed, because DCS loads them as a set.`;
}

/** Basenames of a list of paths, as prose. */
function fileList(paths: readonly string[]): string {
  const names = paths.map((p) => path.basename(p));
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Which DLLs are being taken from the workspace build rather than the shipped
 * set — the choice is made on existence alone, so a stale `bridge/target/release`
 * outranks a newer shipped DLL until the user deletes it. */
export function builtDllNote(built: readonly BridgeDllName[]): string {
  if (!built.length) return "";
  return ` Deploying the locally built ${fileList([...built])} from bridge\\target\\release — delete that folder to go back to the DLLs shipped with the extension.`;
}

/** Post-inject toast. */
export function injectedMessage(writeDir: string, built: readonly BridgeDllName[] = []): string {
  return `Bridge injected into ${writeDir}. Restart DCS (or run DCS Studio: Launch DCS) to load it.${builtDllNote(built)}`;
}

/** Post-eject toast. */
export function ejectedMessage(writeDir: string): string {
  return `Bridge ejected from ${writeDir}.`;
}

/** Post-eject report when some files could not be removed (a running DCS holds
 * its DLLs open) — the plain toast would claim a clean uninstall that did not
 * happen. */
export function ejectIncompleteMessage(writeDir: string, left: readonly string[]): string {
  return `Bridge only partly ejected from ${writeDir} — ${fileList(left)} could not be removed. Close DCS and eject again.`;
}

// ── Launch rules ──

/** `--no-launcher` is mandatory (skip the ED launcher). */
export const DCS_LAUNCH_ARGS: readonly string[] = ["--no-launcher"];

/** DCS.exe's directory inside the game install (also the spawn cwd). */
export function dcsBinDir(gameInstall: string): string {
  return path.join(gameInstall, "bin");
}

/** The DCS executable inside the game install. */
export function dcsExePath(gameInstall: string): string {
  return path.join(dcsBinDir(gameInstall), "DCS.exe");
}

/**
 * Eject-on-shutdown policy: eject only when no managed DCS process is alive —
 * if DCS is still up, the DLL is locked and stays until DCS exits.
 */
// TODO: clean-code - 0.6 - NAMING: the parameter reads as "did we launch DCS",
// past tense, but the policy turns on whether a managed DCS is alive RIGHT NOW —
// `shouldEjectOnShutdown(true)` at a call site looks like "we launched it, so
// eject" and means the opposite. Rename to `dcsStillRunning`.
export function shouldEjectOnShutdown(dcsLaunched: boolean): boolean {
  return !dcsLaunched;
}

/**
 * What to say about how DCS ended. A clean quit says nothing; anything else
 * gets reported, because a sim that dies on startup (a bad mod, a corrupt
 * install, a DLL it cannot load) otherwise looks exactly like the user closing
 * it — the bridge just never connects and the status bar stays offline.
 */
export function dcsExitNote(code: number | null, signal: string | null | undefined): string {
  if (code === 0) return "";
  if (code === null)
    return `DCS was terminated by ${signal ?? "a signal"} before it exited on its own. The bridge has been ejected.`;
  return `DCS exited with code ${code} — it may have failed on startup. Check dcs.log (command: “DCS Studio: Open DCS Log Viewer”). The bridge has been ejected.`;
}
