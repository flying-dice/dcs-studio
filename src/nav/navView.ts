import * as vscode from "vscode";
import { type DualBridgeStatus, displayTime } from "../core/domain/bridgeProtocol";
import { MANIFEST_FILE } from "../core/domain/manifestFile";
import type { BridgeRouterPort } from "../core/ports/debugBridge";
import type { SkillsCatalogPort } from "../core/ports/skillsCatalog";
import { mediaUri, renderWebviewHtml } from "../webview/html";
import { webviewCapabilities } from "../webview/panel";

// The sidebar as website-style page navigation: a WebviewView rendering a logo
// header, nav rows (Browse Mods / Create Mods / Publish Mod / DCS Console /
// MissionScripting / Agent Skills / Settings) and a live bridge-status footer.
// Each row runs the matching command. Publish Mod only shows once
// dcs-studio.toml exists; Agent Skills badges when an installed skill file
// is older than the bundled one.
export class NavViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "dcsStudio.launcher";
  private view: vscode.WebviewView | undefined;
  private statusSub: vscode.Disposable | undefined;
  private skillsSub: vscode.Disposable | undefined;
  private manifestSubs: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly clients: BridgeRouterPort,
    private readonly skills: SkillsCatalogPort,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    // The same capability decision the panels get, from the same place. This
    // used to be its own copy — and the sidebar is the worst surface to let
    // drift: it is registered at activation and lives for the whole session,
    // where a panel is opened on demand and closed.
    webviewView.webview.options = webviewCapabilities(this.extensionUri);
    webviewView.webview.html = this.html(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((m: { type: string; command?: string }) => {
      if (m.type === "run" && m.command) void vscode.commands.executeCommand(m.command);
    });

    this.statusSub?.dispose();
    this.statusSub = this.clients.onStatus((s) => this.postStatus(s));

    // Badge the Agent Skills row when an installed skill file is outdated.
    this.skillsSub?.dispose();
    this.skillsSub = this.skills.onDidChange(() => void this.postSkillsState());
    void this.postSkillsState();

    // The "Create a Mod" row reads as "Edit Project" once a manifest exists;
    // track the workspace's dcs-studio.toml so the phrasing stays true.
    this.watchManifest();

    webviewView.onDidDispose(() => {
      this.statusSub?.dispose();
      this.statusSub = undefined;
      this.skillsSub?.dispose();
      this.skillsSub = undefined;
      this.disposeManifestSubs();
      this.view = undefined;
    });
  }

  private postStatus(s: DualBridgeStatus): void {
    // The footer only needs the coarse single-status shape: connected when
    // either bridge is up; dcsTime > 0 reads as "mission running".
    void this.view?.webview.postMessage({
      type: "status",
      status: { connected: s.gui.connected || s.mission.connected, dcsTime: displayTime(s) },
    });
  }

  private async postSkillsState(): Promise<void> {
    const updates = (await this.skills.updatesAvailable()).length;
    void this.view?.webview.postMessage({ type: "skills", updates });
  }

  private watchManifest(): void {
    this.disposeManifestSubs();
    void this.postManifestState();
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, MANIFEST_FILE),
      );
      watcher.onDidCreate(() => void this.postManifestState());
      watcher.onDidDelete(() => void this.postManifestState());
      this.manifestSubs.push(watcher);
    }
    this.manifestSubs.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.watchManifest()),
    );
  }

  private async postManifestState(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    let hasManifest = false;
    if (folder) {
      hasManifest = await vscode.workspace.fs
        .stat(vscode.Uri.joinPath(folder.uri, MANIFEST_FILE))
        .then(
          () => true,
          () => false,
        );
    }
    void this.view?.webview.postMessage({ type: "manifest", hasManifest });
  }

  private disposeManifestSubs(): void {
    while (this.manifestSubs.length) this.manifestSubs.pop()?.dispose();
  }

  private html(webview: vscode.Webview): string {
    return renderWebviewHtml({
      webview,
      extensionUri: this.extensionUri,
      title: "DCS Studio",
      styles: ["nav.css"],
      inlineScripts: [`window.__LOGO__ = "${mediaUri(webview, this.extensionUri, "icon.png")}";`],
      scripts: ["nav.js"],
      csp: { img: "data:" },
      viewport: false,
    });
  }
}
