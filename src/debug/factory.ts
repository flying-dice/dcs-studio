import * as vscode from "vscode";
import type { DebugEnv } from "../bridge/client";
import type { BridgeClients } from "../bridge/clients";
import { showError } from "../errors";
import { DcsDebugAdapter } from "./adapter";

export const DEBUG_TYPE = "dcs-lua";

/** Inline adapter: runs in the extension host and shares the extension's two
 * bridge clients (the adapter picks the one serving the session's env). */
export class DcsDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
  constructor(private readonly clients: BridgeClients) {}

  createDebugAdapterDescriptor(
    session: vscode.DebugSession,
  ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    return new vscode.DebugAdapterInlineImplementation(
      new DcsDebugAdapter(this.clients, session.configuration),
    );
  }
}

/** Fills defaults so F5 on a .lua file works with no launch.json. */
export class DcsDebugConfigProvider implements vscode.DebugConfigurationProvider {
  resolveDebugConfiguration(
    _folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
  ): vscode.ProviderResult<vscode.DebugConfiguration> {
    // Empty config: user hit F5 with no launch.json — debug the active file.
    if (!config.type && !config.request && !config.name) {
      const doc = vscode.window.activeTextEditor?.document;
      if (!doc?.fileName.toLowerCase().endsWith(".lua")) {
        void showError("Open a .lua file to debug it in DCS.");
        return undefined;
      }
      config = {
        type: DEBUG_TYPE,
        name: "Debug Lua in DCS Mission",
        request: "launch",
        program: doc.fileName,
        env: "mission",
      };
    }
    if (!config.program) config.program = "${file}";
    if (config.env !== "gui") config.env = "mission";
    return config;
  }

  provideDebugConfigurations(): vscode.ProviderResult<vscode.DebugConfiguration[]> {
    return [
      {
        type: DEBUG_TYPE,
        request: "launch",
        name: "DCS: Debug Mission Script",
        program: "${file}",
        env: "mission",
      },
      {
        type: DEBUG_TYPE,
        request: "launch",
        name: "DCS: Debug Hook (GUI) Script",
        program: "${file}",
        env: "gui",
      },
    ];
  }
}

/** Editor run/debug buttons: start a session for the given (or active) file. */
async function startSession(
  uri: vscode.Uri | undefined,
  env: DebugEnv,
  noDebug: boolean,
): Promise<void> {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (target?.scheme !== "file" || !target.fsPath.toLowerCase().endsWith(".lua")) {
    void showError("Open a .lua file to run it in DCS.");
    return;
  }
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === target.toString());
  if (doc?.isDirty) await doc.save();
  const where = env === "mission" ? "DCS Mission" : "DCS GUI";
  await vscode.debug.startDebugging(
    vscode.workspace.getWorkspaceFolder(target),
    {
      type: DEBUG_TYPE,
      name: `${noDebug ? "Run" : "Debug"} in ${where}`,
      request: "launch",
      program: target.fsPath,
      env,
    },
    { noDebug },
  );
}

export function registerDebugCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("dcs.debug.runMission", (uri?: vscode.Uri) =>
      startSession(uri, "mission", true),
    ),
    vscode.commands.registerCommand("dcs.debug.debugMission", (uri?: vscode.Uri) =>
      startSession(uri, "mission", false),
    ),
    vscode.commands.registerCommand("dcs.debug.runGui", (uri?: vscode.Uri) =>
      startSession(uri, "gui", true),
    ),
    vscode.commands.registerCommand("dcs.debug.debugGui", (uri?: vscode.Uri) =>
      startSession(uri, "gui", false),
    ),
  );
}
