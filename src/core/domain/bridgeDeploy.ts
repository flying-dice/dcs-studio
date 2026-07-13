// Pure deploy/launch decision rules for the in-DCS bridge. The adapters
// (bridge/deploy.ts, bridge/launch.ts) own fs and child_process; everything
// here — install layout, built-vs-shipped DLL selection, locked-DLL error
// classification and messaging, launch arguments, eject-on-exit policy — is
// deterministic path/string math.

import * as path from "path";

// Install layout inside the DCS write dir (same layout dcs-studio uses).
export const DLL_RELATIVE_PATH = path.join("Mods", "tech", "DcsStudio", "bin", "dcs_studio.dll");
export const HOOK_RELATIVE_PATH = path.join("Scripts", "Hooks", "DcsStudio.lua");

/** Where the bridge DLL lands inside `writeDir`. */
export function dllInstallPath(writeDir: string): string {
  return path.join(writeDir, DLL_RELATIVE_PATH);
}

/** Where the hook script lands inside `writeDir`. */
export function hookInstallPath(writeDir: string): string {
  return path.join(writeDir, HOOK_RELATIVE_PATH);
}

/** The freshly built native crate's DLL inside the extension. */
export function builtDllPath(extensionRoot: string): string {
  return path.join(extensionRoot, "native", "target", "release", "dcs_studio.dll");
}

/** The prebuilt DLL shipped with the extension. */
export function shippedDllPath(extensionRoot: string): string {
  return path.join(extensionRoot, "bridge", "dcs_studio.dll");
}

/** The DLL to install: the freshly built native crate if present, else the shipped one. */
export function selectDll(extensionRoot: string, builtExists: boolean): string {
  return builtExists ? builtDllPath(extensionRoot) : shippedDllPath(extensionRoot);
}

/** The hook script source shipped with the extension. */
export function hookSourcePath(extensionRoot: string): string {
  return path.join(extensionRoot, "bridge", "Scripts", "Hooks", "DcsStudio.lua");
}

// ── Locked-DLL classification (DCS holds dcs_studio.dll while running) ──

/** Whether an IO error means the DLL is locked by a running DCS (EBUSY/EPERM). */
export function isDllLockedError(e: unknown): boolean {
  const code = (e as { code?: string } | null | undefined)?.code;
  return code === "EBUSY" || code === "EPERM";
}

export const INJECT_LOCKED_MESSAGE =
  "Could not overwrite dcs_studio.dll — DCS appears to be running. Close DCS and inject again.";

export const LAUNCH_LOCKED_MESSAGE = "Bridge DLL is locked — is DCS already running?";

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
