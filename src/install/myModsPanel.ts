import * as vscode from "vscode";
import { currentSession } from "../adapters/vscode/auth";
import { dataDir } from "./dataDir";
import type { SubscriptionService } from "../core/app/subscriptionService";
import type { MarketplacePort } from "../core/ports/marketplace";
import type { InstallRootsPort } from "../core/ports/installRoots";
import type { JsonLedgerStore } from "../adapters/node/jsonLedgerStore";
import type { ProcessLauncher } from "../adapters/node/processLauncher";
import { toModDto, isUpToDate } from "../core/domain/subscriptions";
import {
  entrypointConsentKey,
  entrypointRunKey,
  resolveEntrypointLaunch,
} from "../core/domain/entrypointLaunch";
import type { InstallRoots } from "../core/domain/types";
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
    launcher: ProcessLauncher,
    roots: InstallRootsPort,
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
    MyModsPanel.current = new MyModsPanel(panel, context, subs, ledger, market, launcher, roots);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly subs: SubscriptionService,
    private readonly ledger: JsonLedgerStore,
    private readonly market: MarketplacePort,
    private readonly launcher: ProcessLauncher,
    private readonly roots: InstallRootsPort,
  ) {
    this.panel = panel;
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.png");
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage((m) => void this.onMessage(m), null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    // A tracked entrypoint that exits/errors on its own refreshes the list so the
    // Launch/Stop state stays truthful without the user hitting Refresh.
    this.launcher.setOnChange(() => void this.pushInit());
    void this.pushInit();
  }

  private installRoots(): InstallRoots {
    return { savedGames: this.roots.savedGames(), gameInstall: this.roots.gameInstall() || "" };
  }

  private async pushInit(): Promise<void> {
    this.ledger.ensureUninstallBat(); // keep the script present so Reveal/Run always work
    const mods = (await this.subs.list()).map(toModDto);
    // Running state keyed exactly as the webview looks it up (`<repo>::<id>`),
    // translated here to the launcher's (lowercased) tracking keys.
    const running: Record<string, boolean> = {};
    for (const m of mods) {
      for (const ep of m.entrypoints) {
        running[`${m.repo}::${ep.id}`] = this.launcher.isRunning(entrypointRunKey(m.repo, ep.id));
      }
    }
    this.post({
      type: "init",
      dataDir: dataDir(),
      uninstallBat: this.ledger.uninstallBatPath(),
      mods,
      running,
    });
  }

  private async onMessage(msg: { type: string; repo?: string; url?: string; id?: string }): Promise<void> {
    const repo = msg.repo;
    switch (msg.type) {
      case "refresh":
        await this.pushInit();
        break;
      case "enable":
        if (repo) await this.act(repo, () => this.subs.enable(repo), "Enabled");
        break;
      case "disable":
        if (repo) {
          await this.stopRepoEntrypoints(repo); // stop running exes before unlinking
          await this.act(repo, () => this.subs.disable(repo), "Disabled");
        }
        break;
      case "uninstall":
        if (repo) {
          await this.stopRepoEntrypoints(repo);
          await this.act(repo, () => this.subs.unsubscribe(repo), "Uninstalled");
        }
        break;
      case "launch":
        if (repo && msg.id) await this.launchEntrypoint(repo, msg.id);
        break;
      case "stop":
        if (repo && msg.id) this.stopEntrypoint(repo, msg.id);
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

  /**
   * Launch a mod entrypoint as a tracked process. First launch of a given
   * mod+entrypoint prompts a modal confirm naming the exe; "Always allow for
   * this mod" persists consent in globalState. Declining does not launch. Errors
   * (missing exe, spawn failure) surface both as a notification and inline.
   */
  private async launchEntrypoint(repo: string, id: string): Promise<void> {
    const sub = (await this.subs.list()).find((s) => s.repo === repo);
    const ep = sub?.entrypoints?.find((e) => e.id === id);
    if (!sub || !ep) return;
    const plan = resolveEntrypointLaunch(ep, sub.dir, this.installRoots());

    const consentKey = entrypointConsentKey(repo, id);
    if (!this.context.globalState.get<boolean>(consentKey)) {
      const choice = await vscode.window.showWarningMessage(
        `Launch "${ep.name}" from ${repo}?`,
        { modal: true, detail: `This runs a mod-shipped executable:\n${plan.exe}` },
        "Launch",
        "Always allow for this mod",
      );
      if (!choice) return; // declined — do not launch
      if (choice === "Always allow for this mod") await this.context.globalState.update(consentKey, true);
    }

    try {
      this.launcher.launch(entrypointRunKey(repo, id), plan);
      this.post({ type: "entrypoint", repo, id, running: true });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      void showError(`Launch failed: ${message}`, e);
      this.post({ type: "entrypoint", repo, id, running: false, error: message });
    }
  }

  /** Stop a single tracked entrypoint (kills its process tree). */
  private stopEntrypoint(repo: string, id: string): void {
    this.launcher.stop(entrypointRunKey(repo, id));
    this.post({ type: "entrypoint", repo, id, running: false });
  }

  /** Stop every declared entrypoint of a mod (used before disable/uninstall). */
  private async stopRepoEntrypoints(repo: string): Promise<void> {
    const sub = (await this.subs.list()).find((s) => s.repo === repo);
    for (const ep of sub?.entrypoints ?? []) this.launcher.stop(entrypointRunKey(repo, ep.id));
  }

  private post(msg: unknown): void {
    void this.panel.webview.postMessage(msg);
  }
  private dispose(): void {
    MyModsPanel.current = undefined;
    this.launcher.setOnChange(() => {}); // stop refreshing a disposed panel
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
