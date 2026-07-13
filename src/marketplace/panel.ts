import * as vscode from "vscode";
import { currentSession, signIn } from "../adapters/vscode/auth";
import { DISCOVERY_TOPIC } from "../core/domain/githubMarketplace";
import type { MarketplacePort } from "../core/ports/marketplace";
import type { ProductDetail } from "../core/domain/types";
import type { SubscriptionService } from "../core/app/subscriptionService";
import { showError } from "../errors";

// The full-screen storefront, hosted as a webview panel. The webview owns all
// view state (grid, product page, search/tag/sort); the host owns the sign-in
// state machine and answers the webview's messages; discovery/product loads go
// through the injected `MarketplacePort` (backend chosen in extension.ts).
// Sign-in gated like dcs-studio's /marketplace, with a
// browse-without-signing-in fallback (rate-limited, public only). The panel's
// cached token feeds the subscription flows (fetchPlan/install); the market
// port sources its own token from AuthPort — same silent session either way.
export class MarketplacePanel {
  public static current: MarketplacePanel | undefined;
  private static readonly viewType = "dcsStudio.marketplace";

  private readonly panel: vscode.WebviewPanel;
  private readonly context: vscode.ExtensionContext;
  private readonly disposables: vscode.Disposable[] = [];

  private token: string | undefined;
  private browsing = false; // chose to browse without signing in
  private readonly products = new Map<string, ProductDetail>();

  static show(
    context: vscode.ExtensionContext,
    subs: SubscriptionService,
    market: MarketplacePort,
  ): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (MarketplacePanel.current) {
      MarketplacePanel.current.panel.reveal(column);
      return;
    }
    const panel = vscode.window.createWebviewPanel(MarketplacePanel.viewType, "DCS Marketplace", column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
    });
    MarketplacePanel.current = new MarketplacePanel(panel, context, subs, market);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    private readonly subs: SubscriptionService,
    private readonly market: MarketplacePort,
  ) {
    this.panel = panel;
    this.context = context;
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.png");
    this.panel.webview.html = this.html();

    this.panel.webview.onDidReceiveMessage((m) => void this.onMessage(m), null, this.disposables);
    // Re-run auth state if the user signs in/out of GitHub elsewhere in VS Code.
    this.disposables.push(
      vscode.authentication.onDidChangeSessions((e) => {
        if (e.provider.id === "github") void this.refreshAuth();
      }),
    );
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  refresh(): void {
    void this.runDiscover(true);
  }

  private topic(): string {
    return (
      vscode.workspace.getConfiguration("dcsStudio").get<string>("discoveryTopic")?.trim() ||
      DISCOVERY_TOPIC
    );
  }

  private post(msg: unknown): void {
    void this.panel.webview.postMessage(msg);
  }

  private async onMessage(msg: { type: string; repo?: string; name?: string; force?: boolean; url?: string }): Promise<void> {
    switch (msg.type) {
      case "ready":
        await this.refreshAuth();
        break;
      case "signIn": {
        const session = await signIn();
        this.token = session?.accessToken;
        this.browsing = false;
        await this.refreshAuth();
        break;
      }
      case "browseAnon":
        this.browsing = true;
        this.post({ type: "auth", signedIn: false, browsing: true, topic: this.topic() });
        await this.runDiscover(false);
        break;
      case "discover":
        await this.runDiscover(!!msg.force);
        break;
      case "openProduct":
        if (msg.repo) await this.runProduct(msg.repo);
        break;
      case "openExternal":
        if (msg.url) void vscode.env.openExternal(vscode.Uri.parse(msg.url));
        break;
      case "install":
        if (msg.repo) await this.runInstall(msg.repo);
        break;
      case "uninstall":
        if (msg.repo) {
          try {
            await this.subs.unsubscribe(msg.repo);
            this.post({ type: "uninstalled", repo: msg.repo });
            void vscode.window.showInformationMessage(`Uninstalled ${msg.repo}.`);
          } catch (e) {
            this.post({ type: "installError", repo: msg.repo, message: e instanceof Error ? e.message : String(e) });
          }
        }
        break;
    }
  }

  private async runInstall(repo: string): Promise<void> {
    const product = this.products.get(repo.toLowerCase());
    if (!product) return;
    if (!product.release_tag) {
      this.post({ type: "installError", repo, message: "This mod has no release to install." });
      return;
    }
    this.post({ type: "installProgress", repo, phase: "download", label: "Starting…", pct: 0 });
    try {
      await this.subs.install(
        { repo: product.repo, name: product.name, tag: product.release_tag, assets: product.assets },
        this.token,
        (p) => this.post({ type: "installProgress", repo, phase: p.phase, label: p.label, pct: p.pct }),
      );
      this.post({ type: "installed", repo });
      void vscode.window.showInformationMessage(`Installed ${product.name} into your DCS folders.`);
    } catch (e) {
      this.post({ type: "installError", repo, message: e instanceof Error ? e.message : String(e) });
      void showError(`Install failed: ${e instanceof Error ? e.message : String(e)}`, e);
    }
  }

  /** Push current auth state to the webview; auto-discover when we have access. */
  private async refreshAuth(): Promise<void> {
    const session = await currentSession();
    this.token = session?.accessToken;
    const signedIn = !!session;
    this.post({ type: "auth", signedIn, browsing: this.browsing, login: session?.account.label, topic: this.topic() });
    if (signedIn || this.browsing) await this.runDiscover(false);
  }

  private async runDiscover(force: boolean): Promise<void> {
    this.post({ type: "listings:busy" });
    try {
      const listings = await this.market.discover(this.topic());
      this.post({ type: "listings", listings, force });
    } catch (e) {
      this.post({ type: "listings:error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  private async runProduct(repo: string): Promise<void> {
    this.post({ type: "product:busy", repo });
    try {
      const product = await this.market.loadProduct(repo);
      this.products.set(product.repo.toLowerCase(), product);
      let plan = null;
      try {
        plan = await this.subs.fetchPlan(product.assets, this.token);
      } catch {
        // A missing/unreadable manifest just means no plan preview.
      }
      this.post({ type: "product", product, plan, installed: await this.subs.isSubscribed(product.repo) });
    } catch (e) {
      this.post({ type: "product:error", repo, message: e instanceof Error ? e.message : String(e) });
    }
  }

  private dispose(): void {
    MarketplacePanel.current = undefined;
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
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${media("marketplace.css")}" rel="stylesheet" />
  <title>DCS Marketplace</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${media("marketplace.js")}"></script>
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
