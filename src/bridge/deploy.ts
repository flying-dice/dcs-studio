import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as fsp from "fs/promises";
import {
  BRIDGE_DLLS,
  BridgeDllName,
  INJECT_LOCKED_MESSAGE,
  builtDllPath,
  dllInstallPath,
  ejectedMessage,
  hookInstallPath,
  hookSourcePath,
  injectedMessage,
  isDllLockedError,
  legacyInstallPaths,
  selectDll,
} from "../core/domain/bridgeDeploy";
import { savedGamesDir } from "./paths";
import { showError } from "../errors";

// Inject / eject the bridge — the same install layout dcs-studio uses:
//   <writeDir>\Mods\tech\DcsStudio\bin\dcs_studio_gui.dll
//   <writeDir>\Mods\tech\DcsStudio\bin\dcs_studio_mission.dll
//   <writeDir>\Scripts\Hooks\DcsStudio.lua
// Idempotent; a locked DLL (DCS running) surfaces as an actionable error.
// Stale single-DLL-era artifacts are cleaned up on both inject and eject.
// Layout, DLL selection and error classification are pure rules in
// core/domain/bridgeDeploy; this file owns the fs probes and copies.

/** The DLL to install: the freshly built workspace artifact if present, else
 *  the prebuilt one shipped in the extension. */
export function resolveDll(ctx: vscode.ExtensionContext, name: BridgeDllName): string {
  const root = ctx.extensionUri.fsPath;
  return selectDll(root, name, fs.existsSync(builtDllPath(root, name)));
}

function resolveHook(ctx: vscode.ExtensionContext): string {
  return hookSourcePath(ctx.extensionUri.fsPath);
}

/** Delete stale single-DLL-era artifacts (best-effort — a running DCS holds
 * the old DLL just like the new ones). */
async function cleanupLegacy(writeDir: string): Promise<void> {
  for (const p of legacyInstallPaths(writeDir)) {
    await fsp.rm(p, { force: true }).catch(() => undefined);
  }
}

/** Copy both DLLs + the hook into `writeDir`. Throws on IO error (incl. locked DLL). */
export async function inject(ctx: vscode.ExtensionContext, writeDir: string): Promise<void> {
  const hookDest = hookInstallPath(writeDir);
  await fsp.mkdir(path.dirname(dllInstallPath(writeDir, BRIDGE_DLLS[0])), { recursive: true });
  await fsp.mkdir(path.dirname(hookDest), { recursive: true });
  for (const name of BRIDGE_DLLS) {
    await fsp.copyFile(resolveDll(ctx, name), dllInstallPath(writeDir, name));
  }
  await fsp.copyFile(resolveHook(ctx), hookDest);
  await cleanupLegacy(writeDir);
}

/** Remove the DLLs + hook (and any legacy artifacts) from `writeDir` (best-effort). */
export async function eject(writeDir: string): Promise<void> {
  for (const name of BRIDGE_DLLS) {
    await fsp.rm(dllInstallPath(writeDir, name), { force: true }).catch(() => undefined);
  }
  await fsp.rm(hookInstallPath(writeDir), { force: true }).catch(() => undefined);
  await cleanupLegacy(writeDir);
}

/** Command: inject into the resolved Saved Games dir, with friendly errors. */
export async function injectCommand(ctx: vscode.ExtensionContext): Promise<void> {
  const writeDir = savedGamesDir();
  try {
    await inject(ctx, writeDir);
  } catch (e) {
    if (isDllLockedError(e)) {
      void showError(INJECT_LOCKED_MESSAGE);
      return;
    }
    void showError(`Inject failed: ${e instanceof Error ? e.message : String(e)}`, e);
    return;
  }
  void vscode.window.showInformationMessage(injectedMessage(writeDir));
}

/** Command: eject the bridge from the resolved Saved Games dir. */
export async function ejectCommand(): Promise<void> {
  const writeDir = savedGamesDir();
  await eject(writeDir);
  void vscode.window.showInformationMessage(ejectedMessage(writeDir));
}
