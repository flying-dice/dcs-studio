import * as vscode from "vscode";
import {
  type MarketplaceEffect,
  type MarketplaceInbound,
  MarketplacePresenter,
} from "../core/app/marketplacePresenter";
import type { SubscriptionService } from "../core/app/subscriptionService";
import { DISCOVERY_TOPIC } from "../core/domain/githubMarketplace";
import type { AuthPort } from "../core/ports/auth";
import type { MarketplacePort } from "../core/ports/marketplace";
import { showError } from "../errors";
import { openExternal } from "../external";
import { renderWebviewHtml } from "../webview/html";

// The full-screen storefront, hosted as a webview panel. The webview owns all
// view state (grid, product page, search/tag/sort); everything the host decides
// — the sign-in state machine, the product cache, install guards, error
// mapping — lives in MarketplacePresenter, which knows nothing about VS Code.
// This class is the shell around it: it owns the panel, the URI plumbing, and
// performs the effects the presenter describes.
export class MarketplacePanel {
  public static current: MarketplacePanel | undefined;
  private static readonly viewType = "dcsStudio.marketplace";

  private readonly disposables: vscode.Disposable[] = [];
  private readonly presenter: MarketplacePresenter;

  static show(
    context: vscode.ExtensionContext,
    subs: SubscriptionService,
    market: MarketplacePort,
    auth: AuthPort,
  ): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (MarketplacePanel.current) {
      MarketplacePanel.current.panel.reveal(column);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      MarketplacePanel.viewType,
      "DCS Marketplace",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
      },
    );
    MarketplacePanel.current = new MarketplacePanel(panel, context, subs, market, auth);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    subs: SubscriptionService,
    market: MarketplacePort,
    auth: AuthPort,
  ) {
    this.presenter = new MarketplacePresenter({
      subs,
      market,
      auth,
      topic: () => this.topic(),
      post: (msg) => void this.panel.webview.postMessage(msg),
      effect: (effect) => this.perform(effect),
    });

    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.png");
    this.panel.webview.html = this.html();

    this.panel.webview.onDidReceiveMessage(
      (m: MarketplaceInbound) => void this.presenter.handle(m),
      null,
      this.disposables,
    );
    // Re-run auth state if the user signs in/out of GitHub elsewhere in VS Code.
    this.disposables.push(
      vscode.authentication.onDidChangeSessions((e) => {
        if (e.provider.id === "github") void this.presenter.refreshAuth();
      }),
    );
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  refresh(): void {
    void this.presenter.discover(true);
  }

  private topic(): string {
    return (
      vscode.workspace.getConfiguration("dcsStudio").get<string>("discoveryTopic")?.trim() ||
      DISCOVERY_TOPIC
    );
  }

  /** Carry out one presenter-described effect. */
  private perform(effect: MarketplaceEffect): void {
    switch (effect.kind) {
      case "openExternal":
        openExternal(effect.url);
        break;
      case "openDocs":
        void vscode.commands.executeCommand("dcs.docs.open", effect.page);
        break;
      case "info":
        void vscode.window.showInformationMessage(effect.message);
        break;
      case "installFailed":
        void showError(effect.message, effect.cause);
        break;
    }
  }

  private dispose(): void {
    MarketplacePanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }

  private html(): string {
    return renderWebviewHtml({
      webview: this.panel.webview,
      extensionUri: this.context.extensionUri,
      title: "DCS Marketplace",
      styles: ["marketplace.css"],
      scripts: ["marketplace.js"],
      csp: { img: "https: data:", font: true },
    });
  }
}
