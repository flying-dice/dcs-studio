import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

// Shared DCS path resolution, mirroring dcs-studio's detect: the Saved Games
// write dir (where the bridge DLL + hook are injected) and the game install
// (where DCS.exe lives). Both are overridable via settings.

/** The DCS Saved Games write dir — settings override, else the platform default. */
export function savedGamesDir(): string {
  const cfg = vscode.workspace.getConfiguration("dcsStudio").get<string>("savedGamesPath")?.trim();
  if (cfg) return cfg;
  const home = process.env.USERPROFILE || os.homedir();
  const candidates = [
    path.join(home, "Saved Games", "DCS"),
    path.join(home, "Saved Games", "DCS.openbeta"),
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? candidates[0];
}

/** The DCS game-install dir (contains bin\\DCS.exe), or undefined if unset. */
export function gameInstallDir(): string | undefined {
  return (
    vscode.workspace.getConfiguration("dcsStudio").get<string>("gameInstallPath")?.trim() ||
    undefined
  );
}
