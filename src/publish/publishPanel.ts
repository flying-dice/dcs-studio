import * as vscode from "vscode";
import type { PublishService, ReleaseOpts, ShareOpts } from "../core/app/publishService";
import { type Check, firstBlocker } from "../core/domain/publishChecks";
import { parseRepoRemote } from "../core/domain/repoRemote";
import type { ManifestPort } from "../core/ports/manifest";
import { openExternal } from "../external";
import { renderWebviewHtml } from "../webview/html";
import { preflight, readManifest } from "./preflight";

// The Publish panel: preflight checks, "Share to GitHub" (create repo + push),
// and "Create a release" (7z-packaged, volume-split payload + standalone manifest).
export class PublishPanel {
  public static current: PublishPanel | undefined;
  private static readonly viewType = "dcsStudio.publish";
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly root: string | undefined;

  static show(
    context: vscode.ExtensionContext,
    publish: PublishService,
    manifest: ManifestPort,
  ): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (PublishPanel.current) {
      PublishPanel.current.panel.reveal(column);
      return;
    }
    const panel = vscode.window.createWebviewPanel(PublishPanel.viewType, "Publish Mod", column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
    });
    PublishPanel.current = new PublishPanel(panel, context, publish, manifest);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly publish: PublishService,
    // Threaded to `preflight`, which needs one `parseToml` and used to build the
    // concrete manifest core from the extension context itself (#61).
    private readonly manifest: ManifestPort,
  ) {
    this.panel = panel;
    this.root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.png");
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage((m) => void this.onMessage(m), null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    void this.refresh();
  }

  // Takes `root` rather than re-reading the field: the only caller has already
  // established it, so a second null-guard here would be unreachable code.
  private async detectRepo(root: string): Promise<{ owner: string; name: string } | null> {
    const url = await this.publish.remoteUrl(root, "origin");
    return url ? parseRepoRemote(url) : null;
  }

  /** Run preflight, re-render the panel from it, and hand back the checks. */
  private async pushInit(root: string): Promise<Check[]> {
    const checks = await preflight(this.manifest, root, this.publish);
    const m = readManifest(this.manifest, root);
    const repo = await this.detectRepo(root);
    this.post({
      type: "init",
      checks,
      repo,
      defaults: {
        name: m?.project.name || "",
        description: m?.project.description || "",
        version: m?.project.version || "0.1.0",
      },
    });
    return checks;
  }

  private async refresh(): Promise<void> {
    if (!this.root) {
      this.post({ type: "nofolder" });
      return;
    }
    await this.pushInit(this.root);
  }

  /**
   * Re-run preflight at the moment an action is taken, rather than trusting the
   * disabled state the webview derived from the last run. A manifest deleted or
   * a [[bundle]] path removed since then would otherwise sail through to a real
   * repository, because the host validates nothing on the way in.
   */
  private async blocked(root: string): Promise<boolean> {
    const blocker = firstBlocker(await this.pushInit(root));
    if (!blocker) return false;
    this.log(`✖ ${blocker.label}: ${blocker.detail}`);
    return true;
  }

  private async onMessage(msg: {
    type: string;
    opts?: ShareOpts | ReleaseOpts;
    url?: string;
  }): Promise<void> {
    if (!this.root) return;
    const root = this.root; // narrowed once; the async closures below keep it
    switch (msg.type) {
      case "refresh":
        await this.refresh();
        break;
      case "share":
        await this.guard("share", async () => {
          if (await this.blocked(root)) return;
          const res = await this.publish.share(root, msg.opts as ShareOpts, (l) => this.log(l));
          this.post({ type: "shareDone", result: res });
        });
        break;
      case "release":
        await this.guard("release", async () => {
          if (await this.blocked(root)) return;
          const res = await this.publish.cutRelease(root, msg.opts as ReleaseOpts, (l) =>
            this.log(l),
          );
          this.post({ type: "releaseDone", result: res });
        });
        break;
      case "openExternal":
        if (msg.url) openExternal(msg.url);
        break;
    }
  }

  private async guard(scope: string, fn: () => Promise<void>): Promise<void> {
    this.post({ type: "busy", scope, busy: true });
    try {
      await fn();
    } catch (e) {
      this.log(`✖ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.post({ type: "busy", scope, busy: false });
    }
  }

  private log(line: string): void {
    this.post({ type: "log", line });
  }
  private post(msg: unknown): void {
    void this.panel.webview.postMessage(msg);
  }

  private dispose(): void {
    PublishPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }

  private html(): string {
    return renderWebviewHtml({
      webview: this.panel.webview,
      extensionUri: this.context.extensionUri,
      title: "Publish Mod",
      styles: ["publish.css"],
      scripts: ["publish.js"],
    });
  }
}
