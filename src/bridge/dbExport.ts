import * as os from "os";
import * as vscode from "vscode";
import { dbExportFileBase, shouldOpenExport } from "../core/domain/bridgeConsole";
import { fmtBytes } from "../core/domain/format";
import { showError } from "../errors";
import type { BridgeClients } from "./clients";
import type { DbExportWhat } from "./dbTypes";
import { saveExport } from "./saveExport";

// "DCS Studio: Export DCS Unit Database (JSON)…" — a quick-pick over the GUI
// bridge's db_export method. Mirrors the console export flow: the sim writes the
// JSON to a temp file under the DCS write dir (a big dump never rides the
// WebSocket), we copy it to a user-chosen location, open it if it's small, then
// tidy the temp. GUI bridge only, and the sim must be pumping.

interface ScopePick extends vscode.QuickPickItem {
  scope: "all" | "weapons" | "category" | "unit";
}

/** Resolve the `db_export` `what` via a quick-pick, or undefined if cancelled. */
async function pickWhat(clients: BridgeClients): Promise<DbExportWhat | undefined> {
  const scope = await vscode.window.showQuickPick<ScopePick>(
    [
      {
        label: "$(database) Everything",
        description: "The whole DCS database (tens of MB)",
        scope: "all",
      },
      {
        label: "$(list-tree) A category…",
        description: "Planes, Helicopters, Ships, …",
        scope: "category",
      },
      { label: "$(rocket) A single unit…", description: "One unit record by type", scope: "unit" },
      {
        label: "$(tools) Weapons / stores",
        description: "db.Weapons (CLSIDs + display names)",
        scope: "weapons",
      },
    ],
    { title: "Export DCS Database — what to export?", matchOnDescription: true },
  );
  if (!scope) return undefined;
  if (scope.scope === "all") return "all";
  if (scope.scope === "weapons") return "weapons";

  const { categories } = await clients.gui.dbCategories();
  const cat = await vscode.window.showQuickPick(
    categories.map((c) => ({ label: c.name, description: `${c.count} entries` })),
    { title: "Export DCS Database — pick a category", matchOnDescription: true },
  );
  if (!cat) return undefined;
  if (scope.scope === "category") return `category:${cat.label}`;

  // Single unit: list the picked category's types.
  const { units } = await clients.gui.dbUnitTypes({ category: cat.label });
  const unit = await vscode.window.showQuickPick(
    units.map((u) => ({ label: u.type, description: u.display_name })),
    { title: `Export DCS Database — pick a unit in ${cat.label}`, matchOnDescription: true },
  );
  if (!unit) return undefined;
  return `unit:${unit.label}`;
}

/** Run the DCS database export command end to end. */
export async function dbExportCommand(clients: BridgeClients): Promise<void> {
  if (!clients.gui.current.connected) {
    void showError(
      "The DCS bridge is not connected. Launch DCS with the bridge and wait for the status bar to show DCS online, then try again.",
    );
    return;
  }

  // Tracked outside the try so the tidy-up runs on EVERY path out of it: a copy
  // the user's disk refuses would otherwise leave a tens-of-megabytes dump in
  // the DCS write dir forever.
  let temp: vscode.Uri | undefined;
  try {
    const what = await pickWhat(clients);
    if (!what) return;

    const { path, bytes } = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Exporting DCS database (${what})…`,
      },
      () => clients.gui.dbExport(what),
    );

    temp = vscode.Uri.file(path);
    await saveExport(temp, dbExportFileBase(what), bytes);
  } catch (e) {
    void showError(`DCS database export failed: ${e instanceof Error ? e.message : String(e)}`, e);
  } finally {
    if (temp) {
      try {
        await vscode.workspace.fs.delete(temp);
      } catch {
        /* best-effort tidy of the sim-side temp file */
      }
    }
  }
}
