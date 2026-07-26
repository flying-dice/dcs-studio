import * as vscode from "vscode";
import type { DebugEnv } from "../core/domain/debugProtocol";
import { isMissionScriptingFile, MISSION_SCRIPT_REFUSAL } from "../core/domain/debugTarget";
import type { BridgeRouterPort } from "../core/ports/debugBridge";
import type { InstallRootsPort } from "../core/ports/installRoots";
import type { SchedulerPort } from "../core/ports/scheduler";
import { showError } from "../errors";
import { DcsDebugAdapter } from "./adapter";

export const DEBUG_TYPE = "dcs-lua";

/** Inline adapter: runs in the extension host and shares the extension's two
 * bridge clients (the adapter picks the one serving the session's env).
 *
 * Every dependency is required and supplied by the composition root. The
 * scheduler used to default to `nodeScheduler`, which meant this file named a
 * concrete adapter — a boundary violation (#61) — and, worse, that forgetting
 * to pass one in a test silently bound the session's poll loop to real timers
 * instead of failing. */
export class DcsDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
  constructor(
    private readonly clients: BridgeRouterPort,
    private readonly roots: InstallRootsPort,
    private readonly scheduler: SchedulerPort,
  ) {}

  createDebugAdapterDescriptor(
    session: vscode.DebugSession,
  ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    return new vscode.DebugAdapterInlineImplementation(
      new DcsDebugAdapter(this.clients, session.configuration, this.scheduler, this.roots),
    );
  }
}

/** Fills defaults so F5 on a .lua file works with no launch.json. */
export class DcsDebugConfigProvider implements vscode.DebugConfigurationProvider {
  /**
   * The last gate before a session starts, and the only one that sees the
   * resolved target: `${file}` is substituted by VS Code between
   * `resolveDebugConfiguration` and this hook, so a `launch.json` saying
   * `"program": "${file}"` looks harmless until here.
   *
   * F5 and a hand-written launch.json never touch the command handler where
   * the other refusal lives (issue #30).
   */
  resolveDebugConfigurationWithSubstitutedVariables(
    _folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
  ): vscode.ProviderResult<vscode.DebugConfiguration> {
    if (typeof config.program === "string" && isMissionScriptingFile(config.program)) {
      void showError(MISSION_SCRIPT_REFUSAL);
      // `undefined` cancels the session silently; the toast above is what the
      // user sees. Returning `null` would open launch.json instead, which is
      // wrong here — the configuration is not malformed, the target is refused.
      return undefined;
    }
    return config;
  }

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
      // Refused here as well as after substitution: this branch fabricates a
      // config from the active editor, so it is the one path where the target
      // is already known and `${file}` never appears.
      if (isMissionScriptingFile(doc.fileName)) {
        void showError(MISSION_SCRIPT_REFUSAL);
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
  if (isMissionScriptingFile(target.fsPath)) {
    void showError(MISSION_SCRIPT_REFUSAL);
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
