import * as fs from "fs";
import * as os from "os";
import * as vscode from "vscode";
import { defaultDataDir, savedGamesCandidates } from "../../core/domain/dcsDetect";
import type { InstallRootsPort } from "../../core/ports/installRoots";

// VS Code adapter for `InstallRootsPort` — the three DCS roots, resolved from
// settings with platform defaults behind them.
//
// This is the ONLY place that resolution happens. It used to delegate upward
// into `bridge/paths.ts` and `install/dataDir.ts` — an adapter importing from
// the features it exists to serve, which is the dependency rule backwards — and
// those modules were then imported directly by six panels and commands that
// bypassed the port entirely. That is how the manifest form ended up resolving
// `{SavedGames}` differently from the installer (issue #45): two copies of one
// rule, and only one of them knew about OpenBeta.
//
// The rules themselves are pure and live in `core/domain/dcsDetect.ts`; what is
// left here is reading settings and asking the disk which candidate exists.
export class VsCodeInstallRoots implements InstallRootsPort {
  savedGames(): string {
    const configured = this.setting("savedGamesPath");
    if (configured) return configured;
    const candidates = savedGamesCandidates(this.home());
    return candidates.find((c) => fs.existsSync(c)) ?? candidates[0];
  }

  gameInstall(): string | undefined {
    // No default: unlike the write dir there is no conventional location worth
    // guessing at, and a wrong guess resolves {GameInstall} to a folder that is
    // not DCS. Unset is reported as unset, and the panels say so.
    return this.setting("gameInstallPath");
  }

  dataDir(): string {
    return this.setting("dataDir") ?? defaultDataDir(this.home());
  }

  /** A trimmed non-empty `dcsStudio.<key>`, or undefined. */
  private setting(key: string): string | undefined {
    return vscode.workspace.getConfiguration("dcsStudio").get<string>(key)?.trim() || undefined;
  }

  /** `%USERPROFILE%` first: on Windows it is the one the user's DCS uses. */
  private home(): string {
    return process.env.USERPROFILE || os.homedir();
  }
}

/**
 * The process-wide instance, for the command handlers that are plain functions
 * rather than constructed objects (bridge inject/eject/launch, the log and
 * mission panels). Those are registered as callbacks by the composition root
 * and have nowhere to receive an injected port; every consumer that IS
 * constructed takes the port as an argument instead.
 */
export const installRoots = new VsCodeInstallRoots();
