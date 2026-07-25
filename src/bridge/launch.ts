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
import type { InstallRootsPort } from "../core/ports/installRoots";
import { showError } from "../errors";
import { type BridgeFs, builtDlls, eject, type InjectError, inject } from "./deploy";

// Managed launch, mirroring dcs-studio's launcher: assert the bridge is injected,
// spawn DCS.exe --no-launcher, and eject the bridge once DCS exits. Fails closed
// — a locked DLL (DCS already running) aborts before spawning. The launch rules
// (exe path, args, locked-DLL classification, eject-on-exit policy) are pure and
// live in core/domain/bridgeDeploy.
/**
 * One managed DCS process, and the two facts that decide whether another may
 * start. Constructed by the composition root, which is the only place entitled
 * to decide that this extension host owns at most one sim.
 *
 * `spawnProcess` and `io` are the seams: what matters here is what happens
 * AROUND a running sim — the abort when a DLL is already locked, the eject that
 * restores the user's install once the process exits — and none of it is
 * reachable without launching DCS for real.
 */
export class DcsLauncher {
  private child: ChildProcess | undefined;

  // `child` is only assignable once the spawn has happened, and the inject
  // before it is awaited — so the guard needs something claimed synchronously to
  // close that window. The command is reachable from the palette, the status bar
  // dispatcher and the console's inline button at the same time, and two DCS.exe
  // writing one config and log directory corrupts both.
  private launching = false;

  constructor(
    private readonly io: BridgeFs,
    private readonly roots: InstallRootsPort,
    private readonly spawnProcess: typeof spawn = spawn,
  ) {}

  async launch(ctx: vscode.ExtensionContext): Promise<void> {
    if (this.child) {
      void vscode.window.showInformationMessage("DCS was already launched by DCS Studio.");
      return;
    }
    if (this.launching) {
      void vscode.window.showInformationMessage("DCS Studio is already starting DCS.");
      return;
    }
    this.launching = true;
    try {
      await this.startDcs(ctx);
    } finally {
      // Every failure path frees the claim; a success has set `child` by now,
      // which is what blocks the next launch.
      this.launching = false;
    }
  }

  /** On extension shutdown, best-effort eject if DCS is no longer holding the DLL. */
  cleanup(): void {
    const writeDir = this.roots.savedGames();
    if (shouldEjectOnShutdown(!!this.child)) void eject(writeDir, this.io);
    // If DCS is still up, the DLL is locked and stays until DCS exits.
  }

  private async startDcs(ctx: vscode.ExtensionContext): Promise<void> {
    const io = this.io;
    const gameInstall = this.roots.gameInstall();
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
    const writeDir = this.roots.savedGames();

    // Assert-inject first: a locked DLL means DCS is already running — abort.
    try {
      await inject(ctx, writeDir, io);
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
    const proc = this.spawnProcess(exe, [...DCS_LAUNCH_ARGS], {
      cwd: binDir,
      detached: true,
      stdio: "ignore",
    });
    this.child = proc;
    proc.on("error", (e) => {
      this.child = undefined;
      void showError(`Failed to start DCS: ${e.message}`, e);
    });
    proc.on("exit", (code, signal) => {
      this.child = undefined;
      void eject(writeDir, io); // restore on exit
      // A sim that dies on startup otherwise looks exactly like a clean quit:
      // the bridge simply never connects and the status bar stays offline.
      const note = dcsExitNote(code, signal);
      if (note) void vscode.window.showWarningMessage(note);
    });
    proc.unref();
    void vscode.window.showInformationMessage(
      `Launching DCS with the DCS Studio bridge…${builtDllNote(builtDlls(ctx, io))}`,
    );
  }
}
