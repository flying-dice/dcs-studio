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
  ejectIncompleteMessage,
  hookInstallPath,
  hookSourcePath,
  INJECT_LOCKED_MESSAGE,
  injectedMessage,
  isDllLockedError,
  legacyInstallPaths,
  partialInstallMessage,
  selectDll,
} from "../core/domain/bridgeDeploy";
import type { InstallRootsPort } from "../core/ports/installRoots";
import { showError } from "../errors";

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

/** The DLL to install: the freshly built workspace artifact if present, else
 *  the prebuilt one shipped in the extension. */
export function resolveDll(
  ctx: vscode.ExtensionContext,
  name: BridgeDllName,
  io: BridgeFs,
): string {
  const root = ctx.extensionUri.fsPath;
  return selectDll(root, name, io.existsSync(builtDllPath(root, name)));
}

function resolveHook(ctx: vscode.ExtensionContext): string {
  return hookSourcePath(ctx.extensionUri.fsPath);
}

/** Delete stale single-DLL-era artifacts (best-effort — a running DCS holds
 * the old DLL just like the new ones). */
async function cleanupLegacy(writeDir: string, io: BridgeFs): Promise<void> {
  for (const p of legacyInstallPaths(writeDir)) {
    await io.rm(p, { force: true }).catch(() => undefined);
  }
}

/**
 * An inject that failed part-way, carrying what had already landed so the
 * caller can say so. The underlying failure's `code` is forwarded, so a locked
 * DLL is still classified as one.
 */
export class InjectError extends Error {
  readonly code: string | undefined;
  constructor(
    readonly reason: unknown,
    /** Destinations that were successfully written before the failure. */
    readonly installed: readonly string[],
  ) {
    super(reason instanceof Error ? reason.message : String(reason));
    this.name = "InjectError";
    this.code = (reason as { code?: string } | null | undefined)?.code;
  }
}

/** Copy both DLLs + the hook into `writeDir`. Throws an InjectError on any IO
 * failure (incl. a locked DLL), naming what had already been replaced. */
export async function inject(
  ctx: vscode.ExtensionContext,
  writeDir: string,
  io: BridgeFs,
): Promise<void> {
  const copies = [
    ...BRIDGE_DLLS.map((name) => ({
      src: resolveDll(ctx, name, io),
      dest: dllInstallPath(writeDir, name),
    })),
    { src: resolveHook(ctx), dest: hookInstallPath(writeDir) },
  ];
  const installed: string[] = [];
  try {
    await io.mkdir(path.dirname(dllInstallPath(writeDir, BRIDGE_DLLS[0])), { recursive: true });
    await io.mkdir(path.dirname(hookInstallPath(writeDir)), { recursive: true });
    for (const { src, dest } of copies) {
      await io.copyFile(src, dest);
      installed.push(dest);
    }
  } catch (e) {
    throw new InjectError(e, installed);
  }
  await cleanupLegacy(writeDir, io);
}

/** The DLLs taken from the workspace build rather than the shipped set. */
export function builtDlls(ctx: vscode.ExtensionContext, io: BridgeFs): BridgeDllName[] {
  const root = ctx.extensionUri.fsPath;
  return BRIDGE_DLLS.filter((name) => resolveDll(ctx, name, io) === builtDllPath(root, name));
}

/**
 * Remove the DLLs + hook (and any legacy artifacts) from `writeDir`. Every file
 * is attempted independently, so one that will not go does not strand the
 * others; the ones that survived are returned rather than swallowed.
 */
export async function eject(writeDir: string, io: BridgeFs): Promise<string[]> {
  const left: string[] = [];
  const targets = [
    ...BRIDGE_DLLS.map((name) => dllInstallPath(writeDir, name)),
    hookInstallPath(writeDir),
    ...legacyInstallPaths(writeDir),
  ];
  for (const p of targets) {
    await io.rm(p, { force: true }).catch(() => left.push(p));
  }
  return left;
}

/** Command: inject into the resolved Saved Games dir, with friendly errors. */
export async function injectCommand(
  ctx: vscode.ExtensionContext,
  io: BridgeFs,
  roots: InstallRootsPort,
): Promise<void> {
  const writeDir = roots.savedGames();
  try {
    await inject(ctx, writeDir, io);
  } catch (e) {
    // `inject` wraps everything it can throw, so this is always an InjectError:
    // its message is the underlying failure's, and it names what had landed.
    const failure = e as InjectError;
    const note = partialInstallMessage(failure.installed) ?? "";
    if (isDllLockedError(e)) {
      void showError(`${INJECT_LOCKED_MESSAGE}${note}`);
      return;
    }
    void showError(`Inject failed: ${failure.message}${note}`, e);
    return;
  }
  void vscode.window.showInformationMessage(injectedMessage(writeDir, builtDlls(ctx, io)));
}

/** Command: eject the bridge from the resolved Saved Games dir. */
export async function ejectCommand(io: BridgeFs, roots: InstallRootsPort): Promise<void> {
  const writeDir = roots.savedGames();
  const left = await eject(writeDir, io);
  if (left.length) {
    // A running DCS holds its DLLs open: claiming a clean uninstall would send
    // the user looking for a bridge that is still loaded on the next start.
    void vscode.window.showWarningMessage(ejectIncompleteMessage(writeDir, left));
    return;
  }
  void vscode.window.showInformationMessage(ejectedMessage(writeDir));
}
