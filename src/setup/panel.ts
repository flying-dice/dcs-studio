import * as fs from "fs";
import * as vscode from "vscode";
import { find7z } from "../adapters/node/sevenZip";
import type { DetectService } from "../core/app/detectService";
import { type DcsCandidate, roleProbePath } from "../core/domain/dcsDetect";
import { renderWebviewHtml } from "../webview/html";

// The DCS install selector: pick (or browse to) the userdata (Saved Games) and
// installation folders, with auto-detected candidates. Saves to the
// dcsStudio.savedGamesPath / gameInstallPath settings (global) that inject,
// launch and the manifest form's {SavedGames}/{GameInstall} resolution read.
export class SetupPanel {
  public static current: SetupPanel | undefined;
  private static readonly viewType = "dcsStudio.setup";
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static show(context: vscode.ExtensionContext, detect: DetectService): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (SetupPanel.current) {
      SetupPanel.current.panel.reveal(column);
      return;
    }
    const panel = vscode.window.createWebviewPanel(SetupPanel.viewType, "DCS Setup", column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
    });
    SetupPanel.current = new SetupPanel(panel, context, detect);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly detect: DetectService,
  ) {
    this.panel = panel;
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.png");
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage((m) => void this.onMessage(m), null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    void this.pushInit();
  }

  private cfg() {
    return vscode.workspace.getConfiguration("dcsStudio");
  }

  private async pushInit(): Promise<void> {
    const saved = await this.detect.detectSavedGames();
    const installs = await this.detect.detectGameInstalls();
    const home = process.env.USERPROFILE || require("os").homedir();
    this.post({
      type: "init",
      savedGames: this.cfg().get<string>("savedGamesPath")?.trim() ?? "",
      gameInstall: this.cfg().get<string>("gameInstallPath")?.trim() ?? "",
      dataDir: this.cfg().get<string>("dataDir")?.trim() ?? "",
      dataDirDefault: require("path").join(home, "DCSStudio", "mods"),
      sevenZip: this.cfg().get<string>("sevenZipPath")?.trim() ?? "",
      sevenZipDetected: find7z(this.cfg().get<string>("sevenZipPath")?.trim() || undefined) ?? "",
      savedCandidates: saved,
      installCandidates: installs,
    });
  }

  private async onMessage(msg: {
    type: string;
    which?: "saved" | "install" | "data" | "sevenzip";
    savedGames?: string;
    gameInstall?: string;
    dataDir?: string;
    sevenZip?: string;
  }): Promise<void> {
    switch (msg.type) {
      case "redetect":
        await this.pushInit();
        break;
      case "browse": {
        const isFile = msg.which === "sevenzip";
        const labels: Record<string, string> = {
          install: "Use as DCS install",
          data: "Use as data dir",
          sevenzip: "Use this 7z.exe",
          saved: "Use as DCS userdata",
        };
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: isFile,
          canSelectFolders: !isFile,
          canSelectMany: false,
          openLabel: labels[msg.which ?? "saved"],
          filters: isFile ? { Executable: ["exe"] } : undefined,
        });
        if (picked?.[0]) {
          this.post({
            type: "browsed",
            which: msg.which,
            path: picked[0].fsPath,
            valid: this.validate(msg.which, picked[0].fsPath),
          });
        }
        break;
      }
      case "save":
        await this.cfg().update(
          "savedGamesPath",
          msg.savedGames ?? "",
          vscode.ConfigurationTarget.Global,
        );
        await this.cfg().update(
          "gameInstallPath",
          msg.gameInstall ?? "",
          vscode.ConfigurationTarget.Global,
        );
        await this.cfg().update("dataDir", msg.dataDir ?? "", vscode.ConfigurationTarget.Global);
        await this.cfg().update(
          "sevenZipPath",
          msg.sevenZip ?? "",
          vscode.ConfigurationTarget.Global,
        );
        this.post({ type: "saved" });
        void vscode.window.showInformationMessage("DCS paths saved.");
        break;
    }
  }

  /** Whether a hand-picked path looks right for its role. The per-role path rule
   *  is pure (core/domain/dcsDetect); the panel only performs the existence probe. */
  private validate(
    which: "saved" | "install" | "data" | "sevenzip" | undefined,
    target: string,
  ): boolean {
    try {
      const probe = roleProbePath(which, target);
      return probe === null ? true : fs.existsSync(probe);
    } catch {
      return false;
    }
  }

  private post(msg: unknown): void {
    void this.panel.webview.postMessage(msg);
  }

  private dispose(): void {
    SetupPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
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

// Convenience for a type used by the webview payload.
export type { DcsCandidate };
