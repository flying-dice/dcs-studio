import * as vscode from "vscode";
import { currentSession } from "../adapters/vscode/auth";
import { dataDir } from "./dataDir";
import type { SubscriptionService } from "../core/app/subscriptionService";
import type { MarketplacePort } from "../core/ports/marketplace";
import type { JsonLedgerStore } from "../adapters/node/jsonLedgerStore";
import { toModDto, isUpToDate } from "../core/domain/subscriptions";
import { showError } from "../errors";

// The "My Mods" experience: manage subscribed mods — enable/disable the symlinks,
// update to a newer release, or uninstall (unsubscribe). Reads the subscription
// ledger from the data dir; drives the subscription lifecycle. The webview DTO
// projection and the version-skip rule are core domain functions. The subscription
// service, ledger and marketplace backend are injected by the composition root
// (extension.ts); the Update release lookup goes through the MarketplacePort.
export class MyModsPanel {
  public static current: MyModsPanel | undefined;
  private static readonly viewType = "dcsStudio.myMods";
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static show(
    context: vscode.ExtensionContext,
    subs: SubscriptionService,
    ledger: JsonLedgerStore,
    market: MarketplacePort,
  ): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (MyModsPanel.current) {
      MyModsPanel.current.panel.reveal(column);
      void MyModsPanel.current.pushInit();
      return;
    }
    const panel = vscode.window.createWebviewPanel(MyModsPanel.viewType, "My Mods", column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
    });
    MyModsPanel.current = new MyModsPanel(panel, context, subs, ledger, market);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly subs: SubscriptionService,
    private readonly ledger: JsonLedgerStore,
    private readonly market: MarketplacePort,
  ) {
    this.panel = panel;
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.png");
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage((m) => void this.onMessage(m), null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    void this.pushInit();
  }

  private async pushInit(): Promise<void> {
    this.ledger.ensureUninstallBat(); // keep the script present so Reveal/Run always work
    this.post({
      type: "init",
      dataDir: dataDir(),
      uninstallBat: this.ledger.uninstallBatPath(),
      mods: (await this.subs.list()).map(toModDto),
    });
  }

  private async onMessage(msg: { type: string; repo?: string; url?: string }): Promise<void> {
    const repo = msg.repo;
    switch (msg.type) {
      case "refresh":
        await this.pushInit();
        break;
      case "enable":
        if (repo) await this.act(repo, () => this.subs.enable(repo), "Enabled");
        break;
      case "disable":
        if (repo) await this.act(repo, () => this.subs.disable(repo), "Disabled");
        break;
      case "uninstall":
        if (repo) await this.act(repo, () => this.subs.unsubscribe(repo), "Uninstalled");
        break;
      case "update":
        if (repo) await this.runUpdate(repo);
        break;
      case "openDir":
        if (repo) {
          const sub = (await this.subs.list()).find((s) => s.repo === repo);
          if (sub) void vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(sub.dir));
        }
        break;
      case "openExternal":
        if (msg.url) void vscode.env.openExternal(vscode.Uri.parse(msg.url));
        break;
      case "createShortcut":
        void vscode.commands.executeCommand("dcs.mymods.createShortcut");
        break;
      case "revealBat":
        void vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(this.ledger.ensureUninstallBat()));
        break;
      case "cleanUninstall": {
        const choice = await vscode.window.showWarningMessage(
          "Run the clean-uninstall script? This removes ALL DCS Studio mod links from your DCS folders and deletes the unpacked mod data.",
          { modal: true },
          "Run uninstall-all.bat",
        );
        if (choice) {
          const term = vscode.window.createTerminal("DCS Studio uninstall");
          term.show();
          term.sendText(`& "${this.ledger.ensureUninstallBat()}"`);
        }
        break;
      }
    }
  }

  private async act(repo: string, fn: () => Promise<void> | void, verb: string): Promise<void> {
    this.post({ type: "busy", repo, busy: true });
    try {
      await fn();
      void vscode.window.showInformationMessage(`${verb} ${repo}.`);
    } catch (e) {
      void showError(`${verb} failed: ${e instanceof Error ? e.message : String(e)}`, e);
    } finally {
      await this.pushInit();
    }
  }

  private async runUpdate(repo: string): Promise<void> {
    this.post({ type: "busy", repo, busy: true });
    try {
      const session = await currentSession(); // token feeds the payload download
      const product = await this.market.loadProduct(repo);
      const sub = (await this.subs.list()).find((s) => s.repo === repo);
      if (!product.release_tag) throw new Error("No release found on GitHub.");
      if (sub && isUpToDate(sub, product.release_tag)) {
        void vscode.window.showInformationMessage(`${repo} is already up to date (${sub.tag}).`);
        return;
      }
      await this.subs.update(
        { repo: product.repo, name: product.name, tag: product.release_tag, assets: product.assets },
        session?.accessToken,
        (p) => this.post({ type: "progress", repo, label: p.label, pct: p.pct }),
      );
      void vscode.window.showInformationMessage(`Updated ${repo} to ${product.release_tag}.`);
    } catch (e) {
      void showError(`Update failed: ${e instanceof Error ? e.message : String(e)}`, e);
    } finally {
      await this.pushInit();
    }
  }

  private post(msg: unknown): void {
    void this.panel.webview.postMessage(msg);
  }
  private dispose(): void {
    MyModsPanel.current = undefined;
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
<html lang="en"><head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${media("mymods.css")}" rel="stylesheet" />
  <title>My Mods</title>
</head><body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${media("mymods.js")}"></script>
</body></html>`;
  }
}

function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}
