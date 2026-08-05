import * as path from "path";
import * as vscode from "vscode";
import { GithubMarketplace } from "./adapters/github/marketplace";
import { SystemClock } from "./adapters/node/clock";
import { FetchDownloader } from "./adapters/node/downloader";
import { NodeEnv } from "./adapters/node/env";
import { NodeFileSystem } from "./adapters/node/fs";
import { GhCli } from "./adapters/node/gh";
import { GitCli } from "./adapters/node/git";
import { JsonLedgerStore } from "./adapters/node/jsonLedgerStore";
import { Linker } from "./adapters/node/linker";
import { ProcessLauncher } from "./adapters/node/processLauncher";
import { RegExeRegistry } from "./adapters/node/registry";
import { nodeScheduler } from "./adapters/node/scheduler";
import { SevenZipArchive } from "./adapters/node/sevenZip";
import { WsBridgeTransport } from "./adapters/node/wsTransport";
import { VsCodeGitHubAuth } from "./adapters/vscode/auth";
import { installRoots } from "./adapters/vscode/installRoots";
import { VsCodeManifest } from "./adapters/vscode/manifest";
import { BridgeClient } from "./bridge/client";
import { BridgeClients } from "./bridge/clients";
import { registerBridgeCommands } from "./bridge/commands";
import { type BridgeFs, nodeBridgeFs } from "./bridge/deploy";
import { DcsLauncher } from "./bridge/launch";
import { BundlePreviewService } from "./core/app/bundlePreviewService";
import { DetectService } from "./core/app/detectService";
import { MissionSanitizeService } from "./core/app/missionSanitizeService";
import { PublishService } from "./core/app/publishService";
// ── Core services + their port adapters (wired only here, in the composition
//    root — see ARCHITECTURE.md) ──
import { SubscriptionService } from "./core/app/subscriptionService";
import { GUI_BRIDGE_PORT, MISSION_BRIDGE_PORT } from "./core/domain/bridgeProtocol";
import { statusBarView } from "./core/domain/bridgeStatusView";
import { MANIFEST_FILE } from "./core/domain/manifestFile";
import {
  DcsDebugAdapterFactory,
  DcsDebugConfigProvider,
  DEBUG_TYPE,
  registerDebugCommands,
} from "./debug/factory";
import { setupDevReload } from "./devReload";
import { DocsPanel } from "./docs/docsPanel";
import { MyModsPanel } from "./install/myModsPanel";
import { createMyModsShortcut, MYMODS_URI_PATH } from "./install/shortcut";
import { LogPanel } from "./log/logPanel";
import { ManifestFormPanel } from "./manifest/formPanel";
import { MarketplacePanel } from "./marketplace/panel";
import { registerMissionCommands } from "./mission/missionPanel";
import { NavViewProvider } from "./nav/navView";
import { NewProjectPanel, PENDING_OPEN_KEY } from "./project/newProjectPanel";
import { PublishPanel } from "./publish/publishPanel";
import { SetupPanel } from "./setup/panel";
import { type SkillInfo, SkillsLibrary } from "./skills/library";
import { SkillsPanel, showInstallFailed } from "./skills/skillsPanel";

// A My Mods deep link that arrived in a window with a project open: the handler
// spawns a fresh empty window and stamps this key so that window finishes the
// hand-off (mirrors PENDING_OPEN_KEY for new projects).
const PENDING_MYMODS_KEY = "dcs.pendingMyMods";

let bridge: BridgeClients | undefined;
// The one managed DCS process. Held here rather than inside launch.ts because
// `deactivate()` takes no arguments — VS Code's shape, not ours — so the
// composition root is the only place that can hand it to the shutdown path.
// Initialised eagerly, not on activation: `deactivate()` must still eject a
// bridge a PREVIOUS session injected even if this activation threw before it got
// here, and at that point the real filesystem is the only sensible guess.
// `activate()` replaces it with one built from its injected dependencies.
let dcsLauncher: DcsLauncher = new DcsLauncher(nodeBridgeFs, installRoots);

function isManifest(doc: vscode.TextDocument): boolean {
  return doc.uri.scheme === "file" && doc.uri.path.endsWith(`/${MANIFEST_FILE}`);
}

/**
 * What the composition root builds the extension out of. VS Code only ever
 * passes the context, so the defaults are the real thing; the parameter exists
 * so a test can drive activation against a substitute without a mutable slot
 * that leaks from one spec into the next.
 */
export interface ExtensionDeps {
  /** Filesystem for bridge inject/eject/launch. */
  bridgeIo: BridgeFs;
}

export function activate(
  context: vscode.ExtensionContext,
  deps: ExtensionDeps = { bridgeIo: nodeBridgeFs },
): void {
  // Dev-host only: reload the window when out/ or media/ changes.
  setupDevReload(context);

  // Held in a module slot as well as locally, because `deactivate()` takes no
  // arguments and still has to eject the bridge.
  const dcs = new DcsLauncher(deps.bridgeIo, installRoots);
  dcsLauncher = dcs;

  // The live in-sim bridges (created early so the sidebar nav can show their
  // status): the GUI bridge is up whenever DCS runs; the mission bridge only
  // while a mission is loaded — its client just keeps retrying in between.
  const bridgeCfg = vscode.workspace.getConfiguration("dcsStudio");
  bridge = new BridgeClients(
    new BridgeClient(
      "127.0.0.1",
      bridgeCfg.get<number>("bridgeGuiPort") ?? GUI_BRIDGE_PORT,
      new WsBridgeTransport(),
      "GUI bridge",
    ),
    new BridgeClient(
      "127.0.0.1",
      bridgeCfg.get<number>("bridgeMissionPort") ?? MISSION_BRIDGE_PORT,
      new WsBridgeTransport(),
      "Mission bridge",
    ),
  );
  const clients = bridge;
  context.subscriptions.push(new vscode.Disposable(() => clients.dispose()));

  // Agent skill files the extension ships, installable into the workspace repo
  // (created before the nav so its row can badge pending updates).
  const skills = new SkillsLibrary(context.extensionUri);
  context.subscriptions.push(skills);

  // The sidebar: website-style page navigation (a WebviewView).
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      NavViewProvider.viewId,
      new NavViewProvider(context.extensionUri, clients, skills),
    ),
  );

  // ── Composition root ──────────────────────────────────────────────────────
  // Construct the port adapters ONCE and inject them into the core services the
  // panels/commands drive. This is the only place implementations are chosen;
  // panels receive service instances (never adapter classes) via their show(…)
  // entry points. Adapter constructors are cheap (no I/O), and the manifest core
  // (media/manifest-core.js) is loaded lazily on first use, so this adds no
  // measurable activation cost. Shared stateless adapters are reused.
  const fsPort = new NodeFileSystem();

  const archive = new SevenZipArchive(() =>
    vscode.workspace.getConfiguration("dcsStudio").get<string>("sevenZipPath"),
  );
  const manifestPort = new VsCodeManifest(context);
  // One resolver for the three DCS roots, shared by everything that needs them.
  const ledger = new JsonLedgerStore(() => installRoots.dataDir());
  // Tracks mod entrypoint processes launched from My Mods. A single shared
  // instance so running state survives closing/reopening the panel. On IDE exit
  // its children are deliberately left running (see deactivate()).
  const launcher = new ProcessLauncher();
  const subscriptions = new SubscriptionService({
    ledger,
    archive,
    downloader: new FetchDownloader(),
    linker: new Linker(),
    manifest: manifestPort,
    roots: installRoots,
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
  // GitHub auth (AuthPort): the sole place vscode's auth API is reached. The
  // marketplace backend sources its own token through it; the panels receive it
  // to read the session (token + account label) they surface.
  const auth = new VsCodeGitHubAuth();
  // The marketplace backend (MarketplacePort). The port has a second
  // implementation — the sample catalog in test/support/mockMarketplace.ts,
  // which the shared contract suite runs against alongside this one — so the
  // swap below is a checked claim rather than an aspiration.
  const marketplace = new GithubMarketplace(auth);
  // ──────────────────────────────────────────────────────────────────────────

  // Opening a dcs-studio.toml keeps the real text editor and auto-opens the
  // authoring form beside it (a split view). The document is the source of truth;
  // form and code editor are two-way bound.
  //
  // Wired after the adapters rather than before them, where it used to sit: the
  // form's archive preview needs a real `FileSystemPort`, and the `forEach`
  // below opens forms DURING activation — so the service has to exist by the
  // time this block runs, not merely by the end of `activate`.
  const bundlePreview = new BundlePreviewService(fsPort);
  const openFormFor = (doc: vscode.TextDocument | undefined) => {
    if (doc && isManifest(doc))
      ManifestFormPanel.openBeside(context, doc, installRoots, bundlePreview);
  };
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(openFormFor),
    vscode.commands.registerCommand("dcs.manifest.openForm", () => {
      openFormFor(vscode.window.activeTextEditor?.document);
    }),
  );
  // A manifest already open when the extension activates.
  vscode.workspace.textDocuments.forEach(openFormFor);

  registerPanelCommands(context, {
    publish,
    bundlePreview,
    manifestPort,
    subscriptions,
    marketplace,
    auth,
    ledger,
    launcher,
    skills,
    detect,
    archive,
  });
  registerMissionCommands(context, missionSanitize, installRoots);

  // A storefront entry point that's always visible, mirroring the real app's
  // status-bar affordances.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.text = "$(package) DCS Marketplace";
  status.tooltip = "Browse community mods for DCS World";
  status.command = "dcs.marketplace.open";
  status.show();
  context.subscriptions.push(status);

  // ── Bridges: live in-sim links + Lua console (clients created above) ──
  // A status item reflecting both bridges; click routes through a dispatcher
  // (dcs.bridge.statusBarClick below): online it opens the console directly,
  // offline it offers Launch DCS alongside Console/Inject. The rendering rule
  // (statusBarView) and the click decision (statusBarClickAction) are pure and
  // covered by domain tests.
  const bridgeStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  bridgeStatus.command = "dcs.bridge.statusBarClick";
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

  registerBridgeCommands(context, { clients, dcs, io: deps.bridgeIo, roots: installRoots });

  // ── Debugger: run/debug Lua inside DCS (mission + hooks envs) over the bridges ──
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory(
      DEBUG_TYPE,
      new DcsDebugAdapterFactory(clients, installRoots, nodeScheduler),
    ),
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
          MyModsPanel.show(
            context,
            subscriptions,
            ledger,
            marketplace,
            launcher,
            installRoots,
            auth,
          );
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
      MyModsPanel.show(context, subscriptions, ledger, marketplace, launcher, installRoots, auth);
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
      void openManifest(context, bundlePreview);
    }
  }

  // Installed skill files older than what this build ships: nudge once per
  // skill per bundled version (a workspaceState key remembers the nudge, so
  // updating the extension re-alerts but reloading the window doesn't).
  //
  // Deferred a tick rather than started inline. `updatesAvailable` reads every
  // bundled and installed SKILL.md through `workspace.fs`, and nothing about
  // activation depends on the answer — it only decides whether to show a toast
  // later. Kicking it off inside `activate()` puts that I/O on the path VS Code
  // measures as this extension's startup cost, for a notification the user
  // would not miss a few milliseconds later. The timeout is disposed with the
  // extension so a window closed during activation does not leave it pending.
  const skillScan = setTimeout(() => {
    void skills.updatesAvailable().then((outdated) => {
      for (const s of outdated) {
        if (context.workspaceState.get(nudgeKey(s))) continue;
        void nudgeSkillUpdate(context, skills, s);
      }
    });
  }, 0);
  context.subscriptions.push(new vscode.Disposable(() => clearTimeout(skillScan)));

  // First run: if no DCS paths are configured, nudge to the selector once.
  const cfg = vscode.workspace.getConfiguration("dcsStudio");
  const configured =
    cfg.get<string>("savedGamesPath")?.trim() || cfg.get<string>("gameInstallPath")?.trim();
  if (!configured && !context.globalState.get("dcs.setupPrompted")) {
    void context.globalState.update("dcs.setupPrompted", true);
    void vscode.window
      .showInformationMessage(
        "Set your DCS folders to enable inject, launch and the Lua console.",
        "Set DCS Paths",
      )
      .then((choice) => {
        if (choice) SetupPanel.show(context, detect, archive);
      });
  }
}

/**
 * The services the panel-opening commands need, all built by `activate()`.
 *
 * Concrete adapter types rather than ports, deliberately: this function stays
 * inside the composition root, so it is already the one place allowed to name
 * implementations, and the boundary rule in
 * test/integration/architecture/boundaries.test.ts exempts `extension.ts` alone.
 */
interface PanelCommandDeps {
  publish: PublishService;
  bundlePreview: BundlePreviewService;
  manifestPort: VsCodeManifest;
  subscriptions: SubscriptionService;
  marketplace: GithubMarketplace;
  auth: VsCodeGitHubAuth;
  ledger: JsonLedgerStore;
  launcher: ProcessLauncher;
  skills: SkillsLibrary;
  detect: DetectService;
  archive: SevenZipArchive;
}

/**
 * Register the commands that open a panel.
 *
 * Unlike the mission and bridge sets, this one cannot move next to its
 * handlers: the panels it opens belong to eight different feature units, and
 * the composition root is the only module permitted to reach across all of
 * them. So it stays here — but as its own function, which is enough to keep
 * `activate()` about wiring instead of about forty consecutive registrations.
 */
function registerPanelCommands(
  context: vscode.ExtensionContext,
  {
    publish,
    bundlePreview,
    manifestPort,
    subscriptions,
    marketplace,
    auth,
    ledger,
    launcher,
    skills,
    detect,
    archive,
  }: PanelCommandDeps,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("dcs.manifest.author", () =>
      openManifest(context, bundlePreview),
    ),
    vscode.commands.registerCommand("dcs.project.new", () => NewProjectPanel.show(context)),
    vscode.commands.registerCommand("dcs.publish.open", () =>
      PublishPanel.show(context, publish, manifestPort),
    ),
    vscode.commands.registerCommand("dcs.marketplace.open", () => {
      MarketplacePanel.show(context, subscriptions, marketplace, auth);
    }),
    vscode.commands.registerCommand("dcs.mymods.open", () =>
      MyModsPanel.show(context, subscriptions, ledger, marketplace, launcher, installRoots, auth),
    ),
    vscode.commands.registerCommand("dcs.docs.open", (page?: string) =>
      DocsPanel.show(context, page),
    ),
    vscode.commands.registerCommand("dcs.skills.open", () => SkillsPanel.show(context, skills)),
    vscode.commands.registerCommand(
      "dcs.mymods.createShortcut",
      () => void createMyModsShortcut(context),
    ),
    vscode.commands.registerCommand("dcs.marketplace.refresh", () => {
      MarketplacePanel.current?.refresh();
    }),
    vscode.commands.registerCommand("dcs.setup.open", () =>
      SetupPanel.show(context, detect, archive),
    ),
    vscode.commands.registerCommand("dcs.log.open", () =>
      LogPanel.show(context, manifestPort, installRoots),
    ),
  );
}

/** workspaceState key remembering that one skill was nudged at one version. */
function nudgeKey(s: SkillInfo): string {
  return `dcs.skillUpdateNudged.${s.id}.${s.bundledVersion}`;
}

/**
 * Offer one outdated skill's update. The nudge is marked as delivered only
 * once it has been dealt with — dismissed, deferred to the panel, or installed
 * successfully. A failed install (a read-only repo is the usual cause) reports
 * through the Skills panel's own error surface and leaves the key unwritten,
 * so the next activation offers it again instead of the failure being both
 * silent and permanent.
 */
async function nudgeSkillUpdate(
  context: vscode.ExtensionContext,
  skills: SkillsLibrary,
  s: SkillInfo,
): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    `The "${s.name}" agent skill in this repo is outdated (v${s.installedVersion} installed, v${s.bundledVersion} bundled).`,
    "Update",
    "Manage Skills",
  );
  if (choice === "Update") {
    try {
      await skills.install(s.id);
    } catch (err) {
      showInstallFailed(err);
      return;
    }
    void vscode.window.showInformationMessage(
      `"${s.name}" skill updated to v${s.bundledVersion} — commit the change.`,
    );
  } else if (choice === "Manage Skills") {
    SkillsPanel.show(context, skills);
  }
  await context.workspaceState.update(nudgeKey(s), true);
}

/**
 * Create a Mod: if the workspace already has a dcs-studio.toml, open it as a
 * split view (text editor + authoring form beside it). Otherwise open the
 * guided New Project experience to bootstrap a project from a template.
 */
async function openManifest(
  context: vscode.ExtensionContext,
  bundlePreview: BundlePreviewService,
): Promise<void> {
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
      ManifestFormPanel.openBeside(context, doc, installRoots, bundlePreview);
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
  // Best-effort cleanup: eject the bridge if DCS isn't holding the DLL. Nothing
  // to do if no launcher was ever built — that means no DCS was launched here.
  dcsLauncher.cleanup();
  // Mod entrypoint processes (ProcessLauncher) are deliberately LEFT RUNNING on
  // IDE exit — matching the DCS launcher's policy of not killing DCS when the
  // extension shuts down. The tracking map simply goes away with the process; a
  // companion app like SRS keeps running until the user stops it themselves.
}
