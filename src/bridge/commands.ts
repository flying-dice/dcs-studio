import * as vscode from "vscode";
import { OFFLINE_DISPATCH_OPTIONS, statusBarClickAction } from "../core/domain/bridgeStatusView";
import type { InstallRootsPort } from "../core/ports/installRoots";
import { buildBridge } from "./build";
import type { BridgeClients } from "./clients";
import { ConsolePanel } from "./consolePanel";
import { dbExportCommand } from "./dbExport";
import { type BridgeFs, ejectCommand, injectCommand } from "./deploy";
import type { DcsLauncher } from "./launch";

// The commands that act on the in-sim bridges: open the console, inject/eject
// the DLLs, launch DCS with them, rebuild them, export the unit database, and
// the status bar item's own click handler.
//
// Beside `registerDebugCommands` and `registerMissionCommands`. The composition
// root still constructs everything — this takes the finished services and only
// decides which command id reaches which one, so nothing here chooses an
// implementation. `roots` and `io` arrive as ports rather than as the concrete
// adapters for the same reason.

/** What the bridge commands act on, all built by the composition root. */
export interface BridgeCommandDeps {
  /** Both bridge clients, already started. */
  clients: BridgeClients;
  /** The one managed DCS process. */
  dcs: DcsLauncher;
  /** Filesystem for inject/eject. */
  io: BridgeFs;
  /** Resolver for the DCS install roots. */
  roots: InstallRootsPort;
}

export function registerBridgeCommands(
  context: vscode.ExtensionContext,
  { clients, dcs, io, roots }: BridgeCommandDeps,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("dcs.bridge.console", () =>
      ConsolePanel.show(context, clients),
    ),
    // The status bar item's click handler: not palette-contributed, it is only
    // reachable by clicking "DCS: offline"/"at menu"/"mission" in the footer.
    // Online it opens the console directly; offline it offers Launch DCS
    // alongside Console/Inject. The decision itself (statusBarClickAction) is
    // pure and covered by domain tests.
    vscode.commands.registerCommand("dcs.bridge.statusBarClick", async () => {
      if (statusBarClickAction(clients.current) === "openConsole") {
        ConsolePanel.show(context, clients);
        return;
      }
      const picked = await vscode.window.showQuickPick(
        OFFLINE_DISPATCH_OPTIONS.map((o) => ({
          label: o.label,
          description: o.description,
          command: o.command,
        })),
        {
          title: "DCS Bridge Offline",
          placeHolder: "Neither bridge is reachable — choose an action",
        },
      );
      if (picked) void vscode.commands.executeCommand(picked.command);
    }),
    vscode.commands.registerCommand("dcs.bridge.inject", () => injectCommand(context, io, roots)),
    vscode.commands.registerCommand("dcs.bridge.eject", () => ejectCommand(io, roots)),
    vscode.commands.registerCommand("dcs.bridge.launch", async () => {
      await dcs.launch(context);
      clients.reconnect();
    }),
    vscode.commands.registerCommand("dcs.bridge.build", () => buildBridge(context)),
    vscode.commands.registerCommand("dcs.db.export", () => dbExportCommand(clients)),
  );
}
