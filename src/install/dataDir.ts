import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";

// The DCS Studio data dir: where subscribed mods are downloaded and unpacked.
// Symlinks are maintained from here into the DCS folders. Configurable via
// dcsStudio.dataDir (set through the Settings selector); defaults under the
// user profile, deliberately OUTSIDE the DCS install/Saved Games so DCS never
// scans the raw unpacked assets.
export function dataDir(): string {
  const cfg = vscode.workspace.getConfiguration("dcsStudio").get<string>("dataDir")?.trim();
  if (cfg) return cfg;
  const home = process.env.USERPROFILE || os.homedir();
  return path.join(home, "DCSStudio", "mods");
}
