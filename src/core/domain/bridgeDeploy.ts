// Pure deploy/launch decision rules for the in-DCS bridge. The adapters
// (bridge/deploy.ts, bridge/launch.ts) own fs and child_process; everything
// here — install layout, built-vs-shipped DLL selection, locked-DLL error
// classification and messaging, launch arguments, eject-on-exit policy — is
// deterministic path/string math.

import * as path from "path";

// Install layout inside the DCS write dir (same layout dcs-studio uses).
// Two DLLs: the GUI bridge (loaded by the GameGUI hook) and the mission bridge
// (loaded into the mission scripting state by the hook's boot dispatch).
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
export function selectDll(extensionRoot: string, name: BridgeDllName, builtExists: boolean): string {
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

/** Post-inject toast. */
export function injectedMessage(writeDir: string): string {
  return `Bridge injected into ${writeDir}. Restart DCS (or run DCS Studio: Launch DCS) to load it.`;
}

/** Post-eject toast. */
export function ejectedMessage(writeDir: string): string {
  return `Bridge ejected from ${writeDir}.`;
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
export function shouldEjectOnShutdown(dcsLaunched: boolean): boolean {
  return !dcsLaunched;
}
