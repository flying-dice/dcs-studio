import * as vscode from "vscode";
import type { LogEffect, LogInbound } from "../core/app/logPresenter";
import { LogPresenter } from "../core/app/logPresenter";
import { MANIFEST_FILE } from "../core/domain/manifestFile";
import type { InstallRootsPort } from "../core/ports/installRoots";
import type { ManifestPort } from "../core/ports/manifest";
import { renderWebviewHtml } from "../webview/html";
import { activeColumn, createPanel, disposeWithPanel, webviewPoster } from "../webview/panel";
import { LogTailer } from "./tailer";

// The DCS Log viewer: a singleton WebviewPanel (shape copied from
// bridge/consolePanel.ts) live-tailing Saved Games/DCS/Logs/dcs.log via
// LogTailer, with parsing/buffering/mod-matching done by the tested pure core
// (src/core/domain/dcsLog.ts). Works with or without the bridge — it only
// reads a file off disk. Restarts its tailer when dcsStudio.savedGamesPath
// changes, and re-derives "my mod" identity from the workspace's
// dcs-studio.toml (hidden — no error — when there's no workspace or manifest).
//
// Everything the host decides — what a batch of lines becomes, when a tick is
// silent, what the boot handshake replays, and the "any failure means no mod"
// mapping over the manifest — lives in LogPresenter, which knows nothing about
// VS Code. This class is the shell around it: the panel, the tailer's lifetime,
// the manifest read, and the effects the presenter describes.
export class LogPanel {
  public static current: LogPanel | undefined;
  private static readonly viewType = "dcsStudio.logViewer";

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[];
  private readonly presenter: LogPresenter;
  private tailer: LogTailer | undefined;
  private disposed = false;

  static show(
    context: vscode.ExtensionContext,
    manifestPort: ManifestPort,
    roots: InstallRootsPort,
  ): void {
    const column = activeColumn();
    if (LogPanel.current) {
      LogPanel.current.panel.reveal(column);
      return;
    }
    const panel = createPanel(context, LogPanel.viewType, "DCS Log", column);
    LogPanel.current = new LogPanel(panel, context, manifestPort, roots);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    manifestPort: ManifestPort,
    roots: InstallRootsPort,
  ) {
    this.panel = panel;
    // `disposed` is set here, not just relied on through the tailer: the first
    // start is queued behind an async manifest read, so a panel closed inside
    // that window must be able to say so when the queued work finally runs.
    this.disposables = disposeWithPanel(panel, () => {
      this.disposed = true;
      LogPanel.current = undefined;
      this.tailer?.stop();
    });
    this.presenter = new LogPresenter({
      roots,
      parseManifest: (text) => manifestPort.parseToml(text),
      manifestText: () => this.manifestText(),
      post: webviewPoster(panel),
      effect: (effect) => this.perform(effect),
    });
    this.panel.webview.html = this.html(context);

    this.panel.webview.onDidReceiveMessage(
      (m: LogInbound) => this.presenter.handle(m),
      null,
      this.disposables,
    );

    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("dcsStudio.savedGamesPath")) this.restartTailer();
      }),
    );

    void this.presenter.loadModIdentity().then(() => this.restartTailer());
  }

  /** The workspace manifest's text, or `null` when no folder is open. Rejects
   * when there is no manifest to read — the presenter maps that to "no mod". */
  private async manifestText(): Promise<string | null> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return null;
    const uri = vscode.Uri.joinPath(folder.uri, MANIFEST_FILE);
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
  }

  /** Carry out one presenter-described effect. */
  private perform(effect: LogEffect): void {
    switch (effect.kind) {
      case "openSettings":
        void vscode.commands.executeCommand("dcs.setup.open");
        break;
    }
  }

  private restartTailer(): void {
    // The first start is queued behind the async manifest read, so the user can
    // close the panel before it ever runs; without this the orphaned tailer
    // would keep polling dcs.log for the rest of the session.
    if (this.disposed) return;
    this.tailer?.stop();
    this.tailer = new LogTailer({
      filePath: this.presenter.retarget(),
      onLines: (lines) => this.presenter.onLines(lines),
      onState: (state) => this.presenter.onState(state),
      onReset: () => this.presenter.onReset(),
    });
    this.tailer.start();
  }

  private html(context: vscode.ExtensionContext): string {
    return renderWebviewHtml({
      webview: this.panel.webview,
      extensionUri: context.extensionUri,
      title: "DCS Log",
      styles: ["log.css"],
      scripts: ["log.js"],
      csp: { font: true },
    });
  }
}
