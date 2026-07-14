import * as vscode from "vscode";
import { MarketplacePanel } from "./marketplace/panel";
import { ManifestFormPanel } from "./manifest/formPanel";
import {
  openMissionScripting,
  desanitizeMission,
  sanitizeMission,
  restoreMission,
} from "./mission/missionPanel";
import { BridgeClient } from "./bridge/client";
import { BridgeClients } from "./bridge/clients";
import {
  GUI_BRIDGE_PORT,
  MISSION_BRIDGE_PORT,
  statusBarView,
} from "./core/domain/bridgeProtocol";
import { ConsolePanel } from "./bridge/consolePanel";
import { injectCommand, ejectCommand } from "./bridge/deploy";
import { launchDcs, launchCleanup } from "./bridge/launch";
import { buildBridge } from "./bridge/build";
import { SetupPanel } from "./setup/panel";
import {
  DEBUG_TYPE,
  DcsDebugAdapterFactory,
  DcsDebugConfigProvider,
  registerDebugCommands,
} from "./debug/factory";
import { NavViewProvider } from "./nav/navView";
import { setupDevReload } from "./devReload";
import { PublishPanel } from "./publish/publishPanel";
import { MyModsPanel } from "./install/myModsPanel";
import { createMyModsShortcut, MYMODS_URI_PATH } from "./install/shortcut";
import { NewProjectPanel, PENDING_OPEN_KEY } from "./project/newProjectPanel";
import { DocsPanel } from "./docs/docsPanel";
import { SkillsManager } from "./skills/manager";
import { SkillsPanel } from "./skills/skillsPanel";
import * as path from "path";

// ── Core services + their port adapters (wired only here, in the composition
//    root — see ARCHITECTURE.md) ──
import { SubscriptionService } from "./core/app/subscriptionService";
import { PublishService } from "./core/app/publishService";
import { MissionSanitizeService } from "./core/app/missionSanitizeService";
import { DetectService } from "./core/app/detectService";
import { NodeFileSystem } from "./adapters/node/fs";
import { SystemClock } from "./adapters/node/clock";
import { SevenZipArchive } from "./adapters/node/sevenZip";
import { FetchDownloader } from "./adapters/node/downloader";
import { Linker } from "./adapters/node/linker";
import { JsonLedgerStore } from "./adapters/node/jsonLedgerStore";
import { GitCli } from "./adapters/node/git";
import { GhCli } from "./adapters/node/gh";
import { RegExeRegistry } from "./adapters/node/registry";
import { NodeEnv } from "./adapters/node/env";
import { VsCodeInstallRoots } from "./adapters/vscode/installRoots";
import { VsCodeManifestPort } from "./adapters/vscode/manifestPort";
import { VsCodeGitHubAuth } from "./adapters/vscode/auth";
import { GithubMarketplace } from "./adapters/github/marketplace";
import { dataDir } from "./install/dataDir";

const MANIFEST_FILE = "dcs-studio.toml";

// A My Mods deep link that arrived in a window with a project open: the handler
// spawns a fresh empty window and stamps this key so that window finishes the
// hand-off (mirrors PENDING_OPEN_KEY for new projects).
const PENDING_MYMODS_KEY = "dcs.pendingMyMods";

let bridge: BridgeClients | undefined;

function isManifest(doc: vscode.TextDocument): boolean {
  return doc.uri.scheme === "file" && doc.uri.path.endsWith(`/${MANIFEST_FILE}`);
}

export function activate(context: vscode.ExtensionContext): void {
  // Dev-host only: reload the window when out/ or media/ changes.
  setupDevReload(context);

  // The live in-sim bridges (created early so the sidebar nav can show their
  // status): the GUI bridge is up whenever DCS runs; the mission bridge only
  // while a mission is loaded — its client just keeps retrying in between.
  const bridgeCfg = vscode.workspace.getConfiguration("dcsStudio");
  bridge = new BridgeClients(
    new BridgeClient(
      "127.0.0.1",
      bridgeCfg.get<number>("bridgeGuiPort") ?? GUI_BRIDGE_PORT,
      undefined,
      "GUI bridge",
    ),
    new BridgeClient(
      "127.0.0.1",
      bridgeCfg.get<number>("bridgeMissionPort") ?? MISSION_BRIDGE_PORT,
      undefined,
      "Mission bridge",
    ),
  );
  const clients = bridge;
  context.subscriptions.push(new vscode.Disposable(() => clients.dispose()));

  // Agent skill files the extension ships, installable into the workspace repo
  // (created before the nav so its row can badge pending updates).
  const skills = new SkillsManager(context.extensionUri);
  context.subscriptions.push(skills);

  // The sidebar: website-style page navigation (a WebviewView).
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      NavViewProvider.viewId,
      new NavViewProvider(context.extensionUri, clients, skills),
    ),
  );

  // Opening a dcs-studio.toml keeps the real text editor and auto-opens the
  // authoring form beside it (a split view). The document is the source of truth;
  // form and code editor are two-way bound.
  const openFormFor = (doc: vscode.TextDocument | undefined) => {
    if (doc && isManifest(doc)) ManifestFormPanel.openBeside(context, doc);
  };
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(openFormFor),
    vscode.commands.registerCommand("dcs.manifest.openForm", () => {
      openFormFor(vscode.window.activeTextEditor?.document);
    }),
  );
  // A manifest already open when the extension activates.
  vscode.workspace.textDocuments.forEach(openFormFor);

  // ── Composition root ──────────────────────────────────────────────────────
  // Construct the port adapters ONCE and inject them into the core services the
  // panels/commands drive. This is the only place implementations are chosen;
  // panels receive service instances (never adapter classes) via their show(…)
  // entry points. Adapter constructors are cheap (no I/O), and the manifest core
  // (media/manifest-core.js) is loaded lazily on first use, so this adds no
  // measurable activation cost. Shared stateless adapters are reused.
  const fsPort = new NodeFileSystem();
  const archive = new SevenZipArchive();
  const manifestPort = new VsCodeManifestPort(context);
  const ledger = new JsonLedgerStore(dataDir);
  const subscriptions = new SubscriptionService({
    ledger,
    archive,
    downloader: new FetchDownloader(),
    linker: new Linker(),
    manifest: manifestPort,
    roots: new VsCodeInstallRoots(),
    fs: fsPort,
    clock: new SystemClock(),
  });
  const publish = new PublishService({
    git: new GitCli(),
    gh: new GhCli(),
    archive,
    fs: fsPort,
    manifest: manifestPort,
  });
  const missionSanitize = new MissionSanitizeService(fsPort);
  const detect = new DetectService({
    registry: new RegExeRegistry(),
    fs: fsPort,
    env: new NodeEnv(),
  });
  // The marketplace backend (MarketplacePort). To demo against the static
  // sample catalog, swap this single line for:
  //   const marketplace = new MockMarketplace();   // from ./adapters/mock/marketplace
  const marketplace = new GithubMarketplace(new VsCodeGitHubAuth());
  // ──────────────────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("dcs.manifest.author", () => openManifest(context)),
    vscode.commands.registerCommand("dcs.project.new", () => NewProjectPanel.show(context)),
    vscode.commands.registerCommand("dcs.publish.open", () => PublishPanel.show(context, publish)),
    vscode.commands.registerCommand("dcs.marketplace.open", () => {
      MarketplacePanel.show(context, subscriptions, marketplace);
    }),
    vscode.commands.registerCommand("dcs.mymods.open", () =>
      MyModsPanel.show(context, subscriptions, ledger, marketplace),
    ),
    vscode.commands.registerCommand("dcs.docs.open", (page?: string) => DocsPanel.show(context, page)),
    vscode.commands.registerCommand("dcs.skills.open", () => SkillsPanel.show(context, skills)),
    vscode.commands.registerCommand("dcs.mymods.createShortcut", () => void createMyModsShortcut(context)),
    vscode.commands.registerCommand("dcs.marketplace.refresh", () => {
      MarketplacePanel.current?.refresh();
    }),
    vscode.commands.registerCommand("dcs.mission.open", () => {
      void openMissionScripting(missionSanitize);
    }),
    vscode.commands.registerCommand("dcs.mission.desanitize", () => void desanitizeMission(missionSanitize)),
    vscode.commands.registerCommand("dcs.mission.sanitize", () => void sanitizeMission(missionSanitize)),
    vscode.commands.registerCommand("dcs.mission.restore", () => void restoreMission(missionSanitize)),
  );

  // A storefront entry point that's always visible, mirroring the real app's
  // status-bar affordances.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.text = "$(package) DCS Marketplace";
  status.tooltip = "Browse community mods for DCS World";
  status.command = "dcs.marketplace.open";
  status.show();
  context.subscriptions.push(status);

  // ── Bridges: live in-sim links + Lua console (clients created above) ──
  // A status item reflecting both bridges; click opens the console. The
  // rendering rule is pure (statusBarView) and covered by domain tests.
  const bridgeStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  bridgeStatus.command = "dcs.bridge.console";
  context.subscriptions.push(
    bridgeStatus,
    clients.onStatus((s) => {
      const view = statusBarView(s);
      bridgeStatus.text = view.text;
      bridgeStatus.tooltip = view.tooltip;
    }),
  );
  bridgeStatus.show();
  clients.start();

  context.subscriptions.push(
    vscode.commands.registerCommand("dcs.setup.open", () => SetupPanel.show(context, detect)),
    vscode.commands.registerCommand("dcs.bridge.console", () => ConsolePanel.show(context, clients)),
    vscode.commands.registerCommand("dcs.bridge.inject", () => injectCommand(context)),
    vscode.commands.registerCommand("dcs.bridge.eject", () => ejectCommand()),
    vscode.commands.registerCommand("dcs.bridge.launch", async () => {
      await launchDcs(context);
      clients.reconnect();
    }),
    vscode.commands.registerCommand("dcs.bridge.build", () => buildBridge(context)),
  );

  // ── Debugger: run/debug Lua inside DCS (mission + hooks envs) over the bridges ──
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, new DcsDebugAdapterFactory(clients)),
    vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, new DcsDebugConfigProvider()),
  );
  registerDebugCommands(context);

  // vscode:// deep links (e.g. the desktop shortcut): route /mymods straight
  // into the panel. If this window has a project open, hand off to a fresh
  // empty window instead so the shortcut never lands inside someone's workspace.
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri: (uri) => {
        if (uri.path !== MYMODS_URI_PATH) return;
        if (!vscode.workspace.workspaceFolders?.length) {
          MyModsPanel.show(context, subscriptions, ledger, marketplace);
          return;
        }
        void context.globalState.update(PENDING_MYMODS_KEY, Date.now()).then(() => {
          void vscode.commands.executeCommand("workbench.action.newWindow");
        });
      },
    }),
  );

  // The empty window spawned by that hand-off: open My Mods now. The timestamp
  // keeps a stale flag (a hand-off window that never opened) from hijacking a
  // later, unrelated window.
  const pendingMods = context.globalState.get<number>(PENDING_MYMODS_KEY);
  if (pendingMods) {
    void context.globalState.update(PENDING_MYMODS_KEY, undefined);
    if (Date.now() - pendingMods < 30_000 && !vscode.workspace.workspaceFolders?.length) {
      MyModsPanel.show(context, subscriptions, ledger, marketplace);
    }
  }

  // A project the New Project panel just scaffolded: opening its folder
  // reloaded the extension host, so finish the hand-off now by opening the
  // manifest + authoring form.
  const pending = context.globalState.get<string>(PENDING_OPEN_KEY);
  if (pending) {
    void context.globalState.update(PENDING_OPEN_KEY, undefined);
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (ws?.uri.scheme === "file" && samePath(ws.uri.fsPath, pending)) {
      void openManifest(context);
    }
  }

  // Installed skill files older than what this build ships: nudge once per
  // skill per bundled version (a workspaceState key remembers the nudge, so
  // updating the extension re-alerts but reloading the window doesn't).
  void skills.updatesAvailable().then(async (outdated) => {
    for (const s of outdated) {
      const key = `dcs.skillUpdateNudged.${s.id}.${s.bundledVersion}`;
      if (context.workspaceState.get(key)) continue;
      await context.workspaceState.update(key, true);
      void vscode.window
        .showInformationMessage(
          `The "${s.name}" agent skill in this repo is outdated (v${s.installedVersion} installed, v${s.bundledVersion} bundled).`,
          "Update",
          "Manage Skills",
        )
        .then((choice) => {
          if (choice === "Update") {
            void skills.install(s.id).then(() => {
              void vscode.window.showInformationMessage(`"${s.name}" skill updated to v${s.bundledVersion} — commit the change.`);
            });
          } else if (choice === "Manage Skills") {
            SkillsPanel.show(context, skills);
          }
        });
    }
  });

  // First run: if no DCS paths are configured, nudge to the selector once.
  const cfg = vscode.workspace.getConfiguration("dcsStudio");
  const configured = cfg.get<string>("savedGamesPath")?.trim() || cfg.get<string>("gameInstallPath")?.trim();
  if (!configured && !context.globalState.get("dcs.setupPrompted")) {
    void context.globalState.update("dcs.setupPrompted", true);
    void vscode.window
      .showInformationMessage("Set your DCS folders to enable inject, launch and the Lua console.", "Set DCS Paths")
      .then((choice) => {
        if (choice) SetupPanel.show(context, detect);
      });
  }
}

/**
 * Create a Mod: if the workspace already has a dcs-studio.toml, open it as a
 * split view (text editor + authoring form beside it). Otherwise open the
 * guided New Project experience to bootstrap a project from a template.
 */
async function openManifest(context: vscode.ExtensionContext): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    const uri = vscode.Uri.joinPath(folder.uri, MANIFEST_FILE);
    const exists = await vscode.workspace.fs.stat(uri).then(
      () => true,
      () => false,
    );
    if (exists) {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
      ManifestFormPanel.openBeside(context, doc);
      return;
    }
  }
  NewProjectPanel.show(context);
}

/** Case-insensitive path equality (Windows drive letters, separators). */
function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

export function deactivate(): void {
  bridge?.dispose();
  // Best-effort cleanup: eject the bridge if DCS isn't holding the DLL.
  launchCleanup();
}
