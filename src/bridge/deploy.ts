import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as fsp from "fs/promises";
import {
  INJECT_LOCKED_MESSAGE,
  dllInstallPath,
  ejectedMessage,
  hookInstallPath,
  hookSourcePath,
  injectedMessage,
  isDllLockedError,
  selectDll,
} from "../core/domain/bridgeDeploy";
import { savedGamesDir } from "./paths";
import { showError } from "../errors";

// Inject / eject the bridge — the same install layout dcs-studio uses:
//   <writeDir>\Mods\tech\DcsStudio\bin\dcs_studio.dll
//   <writeDir>\Scripts\Hooks\DcsStudio.lua
// Idempotent; a locked DLL (DCS running) surfaces as an actionable error.
// Layout, DLL selection and error classification are pure rules in
// core/domain/bridgeDeploy; this file owns the fs probes and copies.

/** The DLL to install: the freshly built native crate if present, else the
 *  prebuilt one shipped in the extension. */
export function resolveDll(ctx: vscode.ExtensionContext): string {
  const root = ctx.extensionUri.fsPath;
  const built = path.join(root, "native", "target", "release", "dcs_studio.dll");
  return selectDll(root, fs.existsSync(built));
}

function resolveHook(ctx: vscode.ExtensionContext): string {
  return hookSourcePath(ctx.extensionUri.fsPath);
}

/** Copy the DLL + hook into `writeDir`. Throws on IO error (incl. locked DLL). */
export async function inject(ctx: vscode.ExtensionContext, writeDir: string): Promise<void> {
  const dllDest = dllInstallPath(writeDir);
  const hookDest = hookInstallPath(writeDir);
  await fsp.mkdir(path.dirname(dllDest), { recursive: true });
  await fsp.mkdir(path.dirname(hookDest), { recursive: true });
  await fsp.copyFile(resolveDll(ctx), dllDest);
  await fsp.copyFile(resolveHook(ctx), hookDest);
}

/** Remove the DLL + hook from `writeDir` (best-effort). */
export async function eject(writeDir: string): Promise<void> {
  await fsp.rm(dllInstallPath(writeDir), { force: true }).catch(() => undefined);
  await fsp.rm(hookInstallPath(writeDir), { force: true }).catch(() => undefined);
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
