import * as fs from "fs";
import * as os from "os";
import * as vscode from "vscode";
import type { DetectService } from "../core/app/detectService";
import type { SetupEffect, SetupInbound } from "../core/app/setupPresenter";
import { SetupPresenter } from "../core/app/setupPresenter";
import type { SetupPaths } from "../core/app/webviewContract";
import { type DcsCandidate, defaultDataDir } from "../core/domain/dcsDetect";
import type { ArchivePort } from "../core/ports/archive";
import { renderWebviewHtml } from "../webview/html";
import { activeColumn, createPanel, disposeWithPanel, webviewPoster } from "../webview/panel";

// The DCS install selector: pick (or browse to) the userdata (Saved Games) and
// installation folders, with auto-detected candidates. Saves to the
// dcsStudio.savedGamesPath / gameInstallPath settings (global) that inject,
// launch and the manifest form's {SavedGames}/{GameInstall} resolution read.
//
// Everything the host decides — what seeds the form and what each field falls
// back to, which role a browse dialog is for, how a hand-picked path is
// validated, and that saving writes all four settings even when a box was
// cleared — lives in `SetupPresenter`, which knows nothing about VS Code. This
// class is the shell around it: the panel, the settings read/write, the open
// dialog, the existence probe, and the one effect the presenter describes.
export class SetupPanel {
  public static current: SetupPanel | undefined;
  private static readonly viewType = "dcsStudio.setup";
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[];
  private readonly presenter: SetupPresenter;

  static show(context: vscode.ExtensionContext, detect: DetectService, archive: ArchivePort): void {
    const column = activeColumn();
    if (SetupPanel.current) {
      SetupPanel.current.panel.reveal(column);
      return;
    }
    const panel = createPanel(context, SetupPanel.viewType, "DCS Setup", column);
    SetupPanel.current = new SetupPanel(panel, context, detect, archive);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    detect: DetectService,
    // The port, not `find7z`: this panel only needs to answer "where would we
    // find 7-Zip", which is exactly `available()`, and naming the concrete
    // adapter from a feature was a boundary violation (#61). The adapter reads
    // the same `sevenZipPath` setting this panel displays, so the answer is
    // the one the installer will actually get.
    archive: ArchivePort,
  ) {
    this.panel = panel;
    this.disposables = disposeWithPanel(panel, () => {
      SetupPanel.current = undefined;
    });
    this.presenter = new SetupPresenter({
      detectSavedGames: () => detect.detectSavedGames(),
      detectGameInstalls: () => detect.detectGameInstalls(),
      settings: () => ({
        savedGamesPath: this.cfg().get<string>("savedGamesPath"),
        gameInstallPath: this.cfg().get<string>("gameInstallPath"),
        dataDir: this.cfg().get<string>("dataDir"),
        sevenZipPath: this.cfg().get<string>("sevenZipPath"),
      }),
      // Global, not workspace: these paths describe the machine's DCS install,
      // and a per-folder value would silently stop applying elsewhere.
      saveSetting: (key, value) =>
        Promise.resolve(this.cfg().update(key, value, vscode.ConfigurationTarget.Global)),
      defaultDataDir: () => defaultDataDir(process.env.USERPROFILE || os.homedir()),
      detectedSevenZip: () => archive.available(),
      browse: (request) => this.browse(request),
      exists: (p) => fs.existsSync(p),
      post: webviewPoster(panel),
      effect: (effect) => this.perform(effect),
    });
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage(
      (m: SetupInbound) => void this.presenter.handle(m),
      null,
      this.disposables,
    );
    void this.presenter.refresh();
  }

  private cfg() {
    return vscode.workspace.getConfiguration("dcsStudio");
  }

  /** Show the picker the presenter asked for, and report what was chosen. */
  private async browse(request: {
    file: boolean;
    openLabel: string;
    extensions: readonly string[] | null;
  }): Promise<string | null> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: request.file,
      canSelectFolders: !request.file,
      canSelectMany: false,
      openLabel: request.openLabel,
      filters: request.extensions ? { Executable: [...request.extensions] } : undefined,
    });
    return picked?.[0]?.fsPath ?? null;
  }

  /** Carry out one presenter-described effect. */
  private perform(effect: SetupEffect): void {
    switch (effect.kind) {
      case "notify":
        void vscode.window.showInformationMessage(effect.message);
        break;
    }
  }

  private html(): string {
    return renderWebviewHtml({
      webview: this.panel.webview,
      extensionUri: this.context.extensionUri,
      title: "DCS Setup",
      styles: ["setup.css"],
      scripts: ["setup.js"],
      csp: { font: true },
    });
  }
}

// Convenience for types used by the webview payload.
export type { DcsCandidate, SetupPaths };
