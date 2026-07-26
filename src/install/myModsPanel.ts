import * as vscode from "vscode";
import type {
  MyModsConfirm,
  MyModsEffect,
  MyModsInbound,
  MyModsLedger,
} from "../core/app/myModsPresenter";
import { type EntrypointLauncher, MyModsPresenter } from "../core/app/myModsPresenter";
import type { SubscriptionService } from "../core/app/subscriptionService";
import type { AuthPort } from "../core/ports/auth";
import type { InstallRootsPort } from "../core/ports/installRoots";
import type { MarketplacePort } from "../core/ports/marketplace";
import { showError } from "../errors";
import { openExternal } from "../external";
import { renderWebviewHtml } from "../webview/html";
import { activeColumn, createPanel } from "../webview/panel";

// The "My Mods" experience: manage subscribed mods — enable/disable the symlinks,
// update to a newer release, or uninstall (unsubscribe). Everything the host
// decides — which mods are actionable, the launch consent rules, update-vs-
// reinstall, the error→message mapping — lives in MyModsPresenter, which knows
// nothing about VS Code. This class is the shell around it: it owns the panel,
// the URI plumbing and the memento, performs the effects the presenter
// describes, and asks the modal questions the presenter branches on.
export class MyModsPanel {
  public static current: MyModsPanel | undefined;
  private static readonly viewType = "dcsStudio.myMods";
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly presenter: MyModsPresenter;

  static show(
    context: vscode.ExtensionContext,
    subs: SubscriptionService,
    ledger: MyModsLedger,
    market: MarketplacePort,
    launcher: EntrypointLauncher,
    roots: InstallRootsPort,
    auth: AuthPort,
  ): void {
    const column = activeColumn();
    if (MyModsPanel.current) {
      MyModsPanel.current.panel.reveal(column);
      void MyModsPanel.current.presenter.refresh();
      return;
    }
    const panel = createPanel(context, MyModsPanel.viewType, "My Mods", column);
    MyModsPanel.current = new MyModsPanel(
      panel,
      context,
      subs,
      ledger,
      market,
      launcher,
      roots,
      auth,
    );
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    subs: SubscriptionService,
    ledger: MyModsLedger,
    market: MarketplacePort,
    private readonly launcher: EntrypointLauncher,
    roots: InstallRootsPort,
    auth: AuthPort,
  ) {
    this.presenter = new MyModsPresenter({
      subs,
      ledger,
      market,
      launcher,
      roots,
      auth,
      consent: {
        granted: (key) => !!context.globalState.get<boolean>(key),
        remember: async (key) => void (await context.globalState.update(key, true)),
      },
      dataDir: () => roots.dataDir(),
      post: (msg) => void this.panel.webview.postMessage(msg),
      effect: (effect) => this.perform(effect),
      confirm: (request) => this.confirm(request),
    });

    this.panel = panel;
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage(
      (m: MyModsInbound) => void this.presenter.handle(m),
      null,
      this.disposables,
    );
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    // A tracked entrypoint that exits/errors on its own refreshes the list so the
    // Launch/Stop state stays truthful without the user hitting Refresh.
    this.launcher.setOnChange(() => void this.presenter.refresh());
    void this.presenter.refresh();
  }

  /** Ask one presenter-described modal question and answer with the choice. */
  private async confirm(request: MyModsConfirm): Promise<string | undefined> {
    return await vscode.window.showWarningMessage(
      request.message,
      { modal: true, detail: request.detail },
      ...request.actions,
    );
  }

  /** Carry out one presenter-described effect. */
  private perform(effect: MyModsEffect): void {
    switch (effect.kind) {
      case "info":
        void vscode.window.showInformationMessage(effect.message);
        break;
      case "warn":
        void vscode.window.showWarningMessage(effect.message);
        break;
      case "failed":
        void showError(effect.message, effect.cause);
        break;
      case "openExternal":
        openExternal(effect.url);
        break;
      case "openDocs":
        void vscode.commands.executeCommand("dcs.docs.open", effect.page);
        break;
      case "reveal":
        void vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(effect.path));
        break;
      case "createShortcut":
        void vscode.commands.executeCommand("dcs.mymods.createShortcut");
        break;
      case "runUninstallScript": {
        const term = vscode.window.createTerminal("DCS Studio uninstall");
        term.show();
        term.sendText(`& "${effect.path}"`);
        break;
      }
    }
  }

  private dispose(): void {
    MyModsPanel.current = undefined;
    this.launcher.setOnChange(() => {}); // stop refreshing a disposed panel
    this.panel.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }

  private html(): string {
    return renderWebviewHtml({
      webview: this.panel.webview,
      extensionUri: this.context.extensionUri,
      title: "My Mods",
      styles: ["mymods.css"],
      scripts: ["mymods.js"],
    });
  }
}
