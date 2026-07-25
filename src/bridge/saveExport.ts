import * as os from "os";
import * as vscode from "vscode";
import { shouldOpenExport } from "../core/domain/bridgeConsole";
import { fmtBytes } from "../core/domain/format";

// The tail every in-sim export shares: the sim writes JSON to a temp file in its
// own write dir, and this takes it from there — ask where to put it, copy, and
// either open it or say where it landed.
//
// Both callers (the console's table export and the DCS database export) had
// their own copy of these twenty lines. They are worth sharing not because they
// are long but because each one is a decision a user notices: the default
// folder, whether an existing file is overwritten, and the size above which
// opening the document would hang the editor rather than help.

/**
 * Save `temp` where the user chooses.
 *
 * Returns whether anything was written — a cancelled save dialog is a normal
 * outcome, not a failure, and the console's request/response protocol has to
 * tell the two apart. Deleting `temp` stays with the caller: it owns the
 * lifetime, and the tidy-up has to run on paths this function never reaches.
 */
export async function saveExport(
  temp: vscode.Uri,
  baseName: string,
  bytes: number,
): Promise<boolean> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(os.homedir());
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.joinPath(folder, `${baseName}.json`),
    filters: { JSON: ["json"] },
  });
  if (!target) return false;

  await vscode.workspace.fs.copy(temp, target, { overwrite: true });
  if (shouldOpenExport(bytes)) {
    const doc = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(doc, { preview: true });
  } else {
    // Too big to open without stalling the editor, so name the file instead —
    // otherwise a successful export of a huge table looks like nothing happened.
    void vscode.window.showInformationMessage(`Exported ${fmtBytes(bytes)} to ${target.fsPath}`);
  }
  return true;
}
