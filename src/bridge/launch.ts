import { type ChildProcess, spawn } from "child_process";
import * as vscode from "vscode";
import {
  builtDllNote,
  DCS_LAUNCH_ARGS,
  dcsBinDir,
  dcsExePath,
  dcsExitNote,
  isDllLockedError,
  LAUNCH_LOCKED_MESSAGE,
  partialInstallMessage,
  shouldEjectOnShutdown,
} from "../core/domain/bridgeDeploy";
import { showError } from "../errors";
import { bridgeFs, builtDlls, eject, type InjectError, inject } from "./deploy";
import { gameInstallDir, savedGamesDir } from "./paths";

// Managed launch, mirroring dcs-studio's launcher: assert the bridge is injected,
// spawn DCS.exe --no-launcher, and eject the bridge once DCS exits. Fails closed
// — a locked DLL (DCS already running) aborts before spawning. The launch rules
// (exe path, args, locked-DLL classification, eject-on-exit policy) are pure and
// live in core/domain/bridgeDeploy.
// TODO: clean-code - 0.65 - COUPLING (#41): `child` and `launching` are module
// singletons, so "is DCS running" is process-global state that no caller can see
// or inject. It works because exactly one window may launch DCS, but it makes
// the launch policy untestable except through this module's own globals, and it
// silently assumes one extension host per machine. A small Launcher object owned
// by the composition root would carry the same invariant explicitly.
let child: ChildProcess | undefined;

// `child` is only assignable once the spawn has happened, and the inject before
// it is awaited — so the guard needs something claimed synchronously to close
// that window. The command is reachable from the palette, the status bar
// dispatcher and the console's inline button at the same time, and two DCS.exe
// writing one config and log directory corrupts both.
let launching = false;

// `spawnProcess` is a seam: what matters here is what happens around a running
// sim — the abort when a DLL is already locked, and the eject that restores the
// user's DCS install once the process exits — and none of it is reachable
// without launching DCS for real. The filesystem comes from deploy.ts's seam,
// so a test drives both through one substitution.
export async function launchDcs(
  ctx: vscode.ExtensionContext,
  spawnProcess: typeof spawn = spawn,
): Promise<void> {
  if (child) {
    void vscode.window.showInformationMessage("DCS was already launched by DCS Studio.");
    return;
  }
  if (launching) {
    void vscode.window.showInformationMessage("DCS Studio is already starting DCS.");
    return;
  }
  launching = true;
  try {
    await startDcs(ctx, spawnProcess);
  } finally {
    // Every failure path frees the claim; a success has set `child` by now,
    // which is what blocks the next launch.
    launching = false;
  }
}

async function startDcs(ctx: vscode.ExtensionContext, spawnProcess: typeof spawn): Promise<void> {
  const io = bridgeFs();
  const gameInstall = gameInstallDir();
  if (!gameInstall) {
    void showError("Set dcsStudio.gameInstallPath to your DCS install folder to launch DCS.");
    return;
  }
  const binDir = dcsBinDir(gameInstall);
  const exe = dcsExePath(gameInstall);
  if (!io.existsSync(exe)) {
    void showError(`DCS.exe not found at ${exe}.`);
    return;
  }
  const writeDir = savedGamesDir();

  // Assert-inject first: a locked DLL means DCS is already running — abort.
  try {
    await inject(ctx, writeDir);
  } catch (e) {
    // `inject` wraps everything it can throw, so this is always an InjectError:
    // its message is the underlying failure's, and it names what had landed.
    const failure = e as InjectError;
    const note = partialInstallMessage(failure.installed) ?? "";
    if (isDllLockedError(e)) {
      void showError(`${LAUNCH_LOCKED_MESSAGE}${note}`);
      return;
    }
    void showError(`Inject failed before launch: ${failure.message}${note}`, e);
    return;
  }

  // `--no-launcher` is mandatory (skip the ED launcher). Detached, no IO.
  const proc = spawnProcess(exe, [...DCS_LAUNCH_ARGS], {
    cwd: binDir,
    detached: true,
    stdio: "ignore",
  });
  child = proc;
  proc.on("error", (e) => {
    child = undefined;
    void showError(`Failed to start DCS: ${e.message}`, e);
  });
  proc.on("exit", (code, signal) => {
    child = undefined;
    void eject(writeDir); // restore on exit
    // A sim that dies on startup otherwise looks exactly like a clean quit:
    // the bridge simply never connects and the status bar stays offline.
    const note = dcsExitNote(code, signal);
    if (note) void vscode.window.showWarningMessage(note);
  });
  proc.unref();
  void vscode.window.showInformationMessage(
    `Launching DCS with the DCS Studio bridge…${builtDllNote(builtDlls(ctx))}`,
  );
}

/** On extension shutdown, best-effort eject if DCS is no longer holding the DLL. */
export function launchCleanup(): void {
  const writeDir = savedGamesDir();
  if (shouldEjectOnShutdown(!!child)) void eject(writeDir);
  // If DCS is still up, the DLL is locked and stays until DCS exits — nothing to do.
}
