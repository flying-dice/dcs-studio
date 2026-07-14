import * as vscode from "vscode";
import type { PublishService, ReleaseOpts, ShareOpts } from "../core/app/publishService";
import { parseRepoRemote } from "../core/domain/repoRemote";
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

  static show(context: vscode.ExtensionContext, publish: PublishService): void {
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
    PublishPanel.current = new PublishPanel(panel, context, publish);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly publish: PublishService,
  ) {
    this.panel = panel;
    this.root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.png");
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage((m) => void this.onMessage(m), null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    void this.pushInit();
  }

  private async detectRepo(): Promise<{ owner: string; name: string } | null> {
    if (!this.root) return null;
    const url = await this.publish.remoteUrl(this.root, "origin");
    return url ? parseRepoRemote(url) : null;
  }

  private async pushInit(): Promise<void> {
    if (!this.root) {
      this.post({ type: "nofolder" });
      return;
    }
    const checks = await preflight(this.context, this.root, this.publish);
    const m = readManifest(this.context, this.root);
    const repo = await this.detectRepo();
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
        await this.pushInit();
        break;
      case "share":
        await this.guard("share", async () => {
          const res = await this.publish.share(root, msg.opts as ShareOpts, (l) => this.log(l));
          this.post({ type: "shareDone", result: res });
        });
        break;
      case "release":
        await this.guard("release", async () => {
          const res = await this.publish.cutRelease(root, msg.opts as ReleaseOpts, (l) =>
            this.log(l),
          );
          this.post({ type: "releaseDone", result: res });
        });
        break;
      case "openExternal":
        if (msg.url) void vscode.env.openExternal(vscode.Uri.parse(msg.url));
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
