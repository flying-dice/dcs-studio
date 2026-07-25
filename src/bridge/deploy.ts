// DCS write-dir paths are Windows paths — the product is Windows-only, and the
// layout rules in core/domain/bridgeDeploy build them with `path.win32`. Taking
// `dirname` of `D:\Saved Games\DCS\Mods\...` with the host's native `path`
// yields "." off-Windows, so the mkdir would target the wrong directory and the
// module could not be exercised outside Windows at all. Pin win32 to match.
import { win32 as path } from "node:path";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as vscode from "vscode";
import {
  BRIDGE_DLLS,
  type BridgeDllName,
  builtDllPath,
  dllInstallPath,
  ejectedMessage,
  hookInstallPath,
  hookSourcePath,
  INJECT_LOCKED_MESSAGE,
  injectedMessage,
  isDllLockedError,
  legacyInstallPaths,
  selectDll,
} from "../core/domain/bridgeDeploy";
import { showError } from "../errors";
import { savedGamesDir } from "./paths";

// Inject / eject the bridge — the same install layout dcs-studio uses:
//   <writeDir>\Mods\tech\DcsStudio\bin\dcs_studio_gui.dll
//   <writeDir>\Mods\tech\DcsStudio\bin\dcs_studio_mission.dll
//   <writeDir>\Scripts\Hooks\DcsStudio.lua
// Idempotent; a locked DLL (DCS running) surfaces as an actionable error.
// Stale single-DLL-era artifacts are cleaned up on both inject and eject.
// Layout, DLL selection and error classification are pure rules in
// core/domain/bridgeDeploy; this file owns the fs probes and copies.

/**
 * The filesystem calls inject/eject make, as an injectable seam. The failures
 * that matter here — a DLL held open by a running DCS (EBUSY/EPERM), an
 * unwritable write dir — cannot be provoked against a real disk, and they are
 * exactly the ones that leave a half-installed bridge in someone's DCS.
 */
export interface BridgeFs {
  existsSync(p: string): boolean;
  mkdir(p: string, opts: { recursive: true }): Promise<string | undefined>;
  copyFile(src: string, dest: string): Promise<void>;
  rm(p: string, opts: { force: true }): Promise<void>;
}

/** The real filesystem. */
export const nodeBridgeFs: BridgeFs = {
  existsSync: fs.existsSync,
  mkdir: fsp.mkdir,
  copyFile: fsp.copyFile,
  rm: fsp.rm,
};

let io: BridgeFs = nodeBridgeFs;

/** The filesystem in force. `launch.ts` probes DCS.exe through the same seam. */
export function bridgeFs(): BridgeFs {
  return io;
}

/** Swap the filesystem seam; returns a function that puts the previous one back. */
export function useBridgeFs(next: BridgeFs): () => void {
  const previous = io;
  io = next;
  return () => {
    io = previous;
  };
}

/** The DLL to install: the freshly built workspace artifact if present, else
 *  the prebuilt one shipped in the extension. */
export function resolveDll(ctx: vscode.ExtensionContext, name: BridgeDllName): string {
  const root = ctx.extensionUri.fsPath;
  return selectDll(root, name, io.existsSync(builtDllPath(root, name)));
}

function resolveHook(ctx: vscode.ExtensionContext): string {
  return hookSourcePath(ctx.extensionUri.fsPath);
}

/** Delete stale single-DLL-era artifacts (best-effort — a running DCS holds
 * the old DLL just like the new ones). */
async function cleanupLegacy(writeDir: string): Promise<void> {
  for (const p of legacyInstallPaths(writeDir)) {
    await io.rm(p, { force: true }).catch(() => undefined);
  }
}

/** Copy both DLLs + the hook into `writeDir`. Throws on IO error (incl. locked DLL). */
export async function inject(ctx: vscode.ExtensionContext, writeDir: string): Promise<void> {
  const hookDest = hookInstallPath(writeDir);
  await io.mkdir(path.dirname(dllInstallPath(writeDir, BRIDGE_DLLS[0])), { recursive: true });
  await io.mkdir(path.dirname(hookDest), { recursive: true });
  for (const name of BRIDGE_DLLS) {
    await io.copyFile(resolveDll(ctx, name), dllInstallPath(writeDir, name));
  }
  await io.copyFile(resolveHook(ctx), hookDest);
  await cleanupLegacy(writeDir);
}

/** Remove the DLLs + hook (and any legacy artifacts) from `writeDir` (best-effort). */
export async function eject(writeDir: string): Promise<void> {
  for (const name of BRIDGE_DLLS) {
    await io.rm(dllInstallPath(writeDir, name), { force: true }).catch(() => undefined);
  }
  await io.rm(hookInstallPath(writeDir), { force: true }).catch(() => undefined);
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
