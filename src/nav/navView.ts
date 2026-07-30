import * as vscode from "vscode";
import type { NavEffect, NavInbound } from "../core/app/navPresenter";
import { NavPresenter } from "../core/app/navPresenter";
import type { DualBridgeStatus } from "../core/domain/bridgeProtocol";
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
//
// Everything the sidebar decides — collapsing two bridges into one footer,
// counting the outdated skills into a badge, and the one manifest boolean behind
// two rows — lives in `NavPresenter`, which knows nothing about VS Code. This
// class is the shell around it: the view, the document, the three subscriptions
// and their teardown, the manifest watcher and the `dcs-studio.toml` stat.
//
// The teardown below is hand-rolled rather than card 07's `disposeWithPanel`, and
// stays that way: a `WebviewView`'s lifetime is per `resolveWebviewView` — the
// editor may drop and re-resolve the sidebar any number of times over one
// session — so what has to be released is a set of NAMED subscriptions this
// provider re-creates each time, not an array a panel owns once. That is a fact
// about disposal and not about messages, which is why the presenter above
// changes nothing about it (card 14's journal has the reasoning).
export class NavViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "dcsStudio.launcher";
  private view: vscode.WebviewView | undefined;
  private statusSub: vscode.Disposable | undefined;
  private skillsSub: vscode.Disposable | undefined;
  private manifestSubs: vscode.Disposable[] = [];
  private readonly presenter: NavPresenter;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly clients: BridgeRouterPort,
    private readonly skills: SkillsCatalogPort,
  ) {
    // One presenter per PROVIDER, not per resolve — the opposite choice to the
    // manifest form's presenter-per-panel, and for the mirror-image reason: this
    // one holds no state at all, so there is nothing a second view could inherit
    // from the first. The `this.view?.` in `post` is what makes that safe, and it
    // is deliberately on this side of the boundary: the three signals outlive the
    // view they draw, so a push after disposal must be a no-op, and the shell
    // holds the only reference that can tell.
    this.presenter = new NavPresenter({
      // The router holds the authoritative pair; the presenter reads it when the
      // webview's `ready` asks for the opening state, rather than keeping a copy
      // fed by the subscription below.
      status: () => this.clients.current,
      updatesAvailable: () => this.skills.updatesAvailable(),
      manifestExists: () => this.manifestExists(),
      post: (msg) => void this.view?.webview.postMessage(msg),
      effect: (effect) => this.perform(effect),
    });
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    // The same capability decision the panels get, from the same place. This
    // used to be its own copy — and the sidebar is the worst surface to let
    // drift: it is registered at activation and lives for the whole session,
    // where a panel is opened on demand and closed.
    webviewView.webview.options = webviewCapabilities(this.extensionUri);
    webviewView.webview.html = this.html(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((m: NavInbound) => void this.presenter.handle(m));

    this.statusSub?.dispose();
    this.statusSub = this.clients.onStatus((s: DualBridgeStatus) => this.presenter.pushStatus(s));

    // Badge the Agent Skills row when an installed skill file is outdated.
    //
    // This push and `watchManifest`'s are the FIRST chance, not the only one:
    // both are async and can resolve before `media/nav.js` has attached its
    // listener, so the webview's `ready` is answered with all three (card 29).
    this.skillsSub?.dispose();
    this.skillsSub = this.skills.onDidChange(() => void this.presenter.pushSkills());
    void this.presenter.pushSkills();

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

  /** Carry out one presenter-described effect. */
  private perform(effect: NavEffect): void {
    switch (effect.kind) {
      case "runCommand":
        void vscode.commands.executeCommand(effect.command);
        break;
    }
  }

  private watchManifest(): void {
    this.disposeManifestSubs();
    void this.presenter.pushManifest();
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, MANIFEST_FILE),
      );
      watcher.onDidCreate(() => void this.presenter.pushManifest());
      watcher.onDidDelete(() => void this.presenter.pushManifest());
      this.manifestSubs.push(watcher);
    }
    this.manifestSubs.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.watchManifest()),
    );
  }

  /** Whether the open workspace has a `dcs-studio.toml`, as the stat answers. */
  private async manifestExists(): Promise<boolean> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return false;
    return vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, MANIFEST_FILE)).then(
      () => true,
      () => false,
    );
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
