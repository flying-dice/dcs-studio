import * as vscode from "vscode";
import { gitRemoteUrlSync } from "../adapters/node/git";
import { parseRepoRemote } from "../core/domain/repoRemote";
import { preflight, readManifest, Check } from "./preflight";
import type { PublishService, ShareOpts, ReleaseOpts } from "../core/app/publishService";

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
    this.pushInit();
  }

  private detectRepo(): { owner: string; name: string } | null {
    if (!this.root) return null;
    const url = gitRemoteUrlSync(this.root, "origin");
    return url ? parseRepoRemote(url) : null;
  }

  private pushInit(): void {
    if (!this.root) {
      this.post({ type: "nofolder" });
      return;
    }
    const checks = preflight(this.context, this.root);
    const m = readManifest(this.context, this.root);
    const repo = this.detectRepo();
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
    switch (msg.type) {
      case "refresh":
        this.pushInit();
        break;
      case "share":
        await this.guard("share", async () => {
          const res = await this.publish.share(this.root!, msg.opts as ShareOpts, (l) => this.log(l));
          this.post({ type: "shareDone", result: res });
        });
        break;
      case "release":
        await this.guard("release", async () => {
          const res = await this.publish.cutRelease(this.root!, msg.opts as ReleaseOpts, (l) => this.log(l));
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
      this.post({ type: "failed", scope, message: e instanceof Error ? e.message : String(e) });
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
    const webview = this.panel.webview;
    const media = (f: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", f));
    const nonce = getNonce();
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${media("publish.css")}" rel="stylesheet" />
  <title>Publish Mod</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${media("publish.js")}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}
