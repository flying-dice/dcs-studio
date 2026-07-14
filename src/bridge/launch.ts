import { type ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import * as vscode from "vscode";
import {
  DCS_LAUNCH_ARGS,
  dcsBinDir,
  dcsExePath,
  isDllLockedError,
  LAUNCH_LOCKED_MESSAGE,
  shouldEjectOnShutdown,
} from "../core/domain/bridgeDeploy";
import { showError } from "../errors";
import { eject, inject } from "./deploy";
import { gameInstallDir, savedGamesDir } from "./paths";

// Managed launch, mirroring dcs-studio's launcher: assert the bridge is injected,
// spawn DCS.exe --no-launcher, and eject the bridge once DCS exits. Fails closed
// — a locked DLL (DCS already running) aborts before spawning. The launch rules
// (exe path, args, locked-DLL classification, eject-on-exit policy) are pure and
// live in core/domain/bridgeDeploy.
let child: ChildProcess | undefined;

export async function launchDcs(ctx: vscode.ExtensionContext): Promise<void> {
  if (child) {
    void vscode.window.showInformationMessage("DCS was already launched by DCS Studio.");
    return;
  }
  const gameInstall = gameInstallDir();
  if (!gameInstall) {
    void showError("Set dcsStudio.gameInstallPath to your DCS install folder to launch DCS.");
    return;
  }
  const binDir = dcsBinDir(gameInstall);
  const exe = dcsExePath(gameInstall);
  if (!fs.existsSync(exe)) {
    void showError(`DCS.exe not found at ${exe}.`);
    return;
  }
  const writeDir = savedGamesDir();

  // Assert-inject first: a locked DLL means DCS is already running — abort.
  try {
    await inject(ctx, writeDir);
  } catch (e) {
    if (isDllLockedError(e)) {
      void showError(LAUNCH_LOCKED_MESSAGE);
      return;
    }
    void showError(`Inject failed before launch: ${e instanceof Error ? e.message : String(e)}`, e);
    return;
  }

  // `--no-launcher` is mandatory (skip the ED launcher). Detached, no IO.
  const proc = spawn(exe, [...DCS_LAUNCH_ARGS], { cwd: binDir, detached: true, stdio: "ignore" });
  child = proc;
  proc.on("error", (e) => {
    child = undefined;
    void showError(`Failed to start DCS: ${e.message}`, e);
  });
  proc.on("exit", () => {
    child = undefined;
    void eject(writeDir); // restore on exit
  });
  proc.unref();
  void vscode.window.showInformationMessage("Launching DCS with the DCS Studio bridge…");
}

/** On extension shutdown, best-effort eject if DCS is no longer holding the DLL. */
export function launchCleanup(): void {
  const writeDir = savedGamesDir();
  if (shouldEjectOnShutdown(!!child)) void eject(writeDir);
  // If DCS is still up, the DLL is locked and stays until DCS exits — nothing to do.
}
