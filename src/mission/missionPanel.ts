import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { gameInstallDir } from "../bridge/paths";
import type { MissionSanitizeService } from "../core/app/missionSanitizeService";
import { allItems, backupPath } from "../core/domain/missionSanitize";
import { showError } from "../errors";

// MissionScripting.lua management against the real file under the configured DCS
// install: <gameInstall>\Scripts\MissionScripting.lua. Opens the actual file and
// toggles its sanitization block (desanitize / re-sanitize / restore-from-backup)
// so the bridge and mission scripts can use the full Lua environment.
export const MISSION_FILE = "MissionScripting.lua";

/** The MissionScripting.lua path from the configured install, or undefined. */
export function missionScriptPath(): string | undefined {
  const gi = gameInstallDir();
  return gi ? path.join(gi, "Scripts", MISSION_FILE) : undefined;
}

async function requireFile(): Promise<string | undefined> {
  const p = missionScriptPath();
  if (!p) {
    const choice = await vscode.window.showInformationMessage(
      "Set your DCS installation path to manage MissionScripting.lua.",
      "Set DCS Paths",
    );
    if (choice) void vscode.commands.executeCommand("dcs.setup.open");
    return undefined;
  }
  if (!fs.existsSync(p)) {
    void showError(
      `MissionScripting.lua not found at ${p}. Check your DCS install path in Settings.`,
    );
    return undefined;
  }
  return p;
}

/** Open the real MissionScripting.lua in the editor. */
export async function openMissionScripting(svc: MissionSanitizeService): Promise<void> {
  const p = await requireFile();
  if (!p) return;
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(p));
  await vscode.window.showTextDocument(doc, { preview: false });
  const s = await svc.status(p);
  const locked = s.items.filter((i) => i.present && i.sanitized).map((i) => i.name);
  if (locked.length) {
    void vscode.window.showInformationMessage(
      `MissionScripting.lua is sanitized (${locked.join(", ")} locked). Use "Desanitize" to unlock for the bridge/mods.`,
    );
  }
}

function permissionHint(e: unknown): string {
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === "EPERM" || code === "EACCES") {
    return "Access denied — MissionScripting.lua is under Program Files. Run VS Code as administrator, or edit it manually.";
  }
  return e instanceof Error ? e.message : String(e);
}

/** Ensure the open editor for `p` reflects the on-disk change (revert if dirty-free). */
async function refreshOpen(p: string): Promise<void> {
  const open = vscode.window.visibleTextEditors.find(
    (ed) => ed.document.uri.fsPath.toLowerCase() === p.toLowerCase(),
  );
  if (open && !open.document.isDirty) {
    // VS Code auto-reloads unmodified files, but revert makes it immediate.
    await vscode.window.showTextDocument(open.document, open.viewColumn);
    await vscode.commands.executeCommand("workbench.action.files.revert");
  }
}

async function apply(
  svc: MissionSanitizeService,
  desired: Record<string, boolean>,
  okMsg: string,
): Promise<void> {
  const p = await requireFile();
  if (!p) return;
  const open = vscode.workspace.textDocuments.find(
    (d) => d.uri.fsPath.toLowerCase() === p.toLowerCase(),
  );
  if (open?.isDirty) {
    void vscode.window.showWarningMessage(
      "MissionScripting.lua has unsaved changes. Save or close it first, then try again.",
    );
    return;
  }
  try {
    await svc.setItems(p, desired);
    await refreshOpen(p);
    void vscode.window.showInformationMessage(`${okMsg} (backup: ${path.basename(backupPath(p))})`);
  } catch (e) {
    void showError(permissionHint(e), e);
  }
}

/** Comment out the lockdown → full Lua env available in mission scripts. */
export function desanitizeMission(svc: MissionSanitizeService): Promise<void> {
  return apply(
    svc,
    allItems(false),
    "Desanitized MissionScripting.lua — os/io/lfs/require/package are available.",
  );
}

/** Uncomment the lockdown → DCS's default sanitized state. */
export function sanitizeMission(svc: MissionSanitizeService): Promise<void> {
  return apply(
    svc,
    allItems(true),
    "Re-sanitized MissionScripting.lua — DCS's default lockdown restored.",
  );
}

/** Copy the pristine backup back over the live file. */
export async function restoreMission(svc: MissionSanitizeService): Promise<void> {
  const p = await requireFile();
  if (!p) return;
  try {
    await svc.restore(p);
    await refreshOpen(p);
    void vscode.window.showInformationMessage("Restored MissionScripting.lua from the backup.");
  } catch (e) {
    void showError(permissionHint(e), e);
  }
}

/** A human summary of the two trigger statuses, e.g. "before: valid, after: missing". */
function summarizeTriggers(s: { before: string; after: string }): string {
  return `before-sanitize: ${s.before}, after-sanitize: ${s.after}`;
}

/**
 * Install/fix the managed mod-script trigger dofile lines in MissionScripting.lua
 * (idempotent, backup-first). If both are already valid, reports and does
 * nothing further. These are the MOD-script hooks; they are independent of the
 * bridge boot, which uses no MissionScripting.lua edits.
 */
export async function installMissionHooks(svc: MissionSanitizeService): Promise<void> {
  const p = await requireFile();
  if (!p) return;
  const open = vscode.workspace.textDocuments.find(
    (d) => d.uri.fsPath.toLowerCase() === p.toLowerCase(),
  );
  if (open?.isDirty) {
    void vscode.window.showWarningMessage(
      "MissionScripting.lua has unsaved changes. Save or close it first, then try again.",
    );
    return;
  }
  try {
    const status = await svc.installTriggers(p);
    await refreshOpen(p);
    void vscode.window.showInformationMessage(
      `Mission-script hooks installed in MissionScripting.lua (${summarizeTriggers(status)}). Backup: ${path.basename(backupPath(p))}.`,
    );
  } catch (e) {
    void showError(permissionHint(e), e);
  }
}

/** Remove the managed mod-script trigger dofile lines from MissionScripting.lua. */
export async function removeMissionHooks(svc: MissionSanitizeService): Promise<void> {
  const p = await requireFile();
  if (!p) return;
  const open = vscode.workspace.textDocuments.find(
    (d) => d.uri.fsPath.toLowerCase() === p.toLowerCase(),
  );
  if (open?.isDirty) {
    void vscode.window.showWarningMessage(
      "MissionScripting.lua has unsaved changes. Save or close it first, then try again.",
    );
    return;
  }
  try {
    await svc.removeTriggers(p);
    await refreshOpen(p);
    void vscode.window.showInformationMessage(
      "Mission-script hooks removed from MissionScripting.lua.",
    );
  } catch (e) {
    void showError(permissionHint(e), e);
  }
}
