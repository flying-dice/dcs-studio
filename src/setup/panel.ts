import * as vscode from "vscode";
import * as fs from "fs";
import type { DetectService } from "../core/app/detectService";
import { roleProbePath, type DcsCandidate } from "../core/domain/dcsDetect";
import { find7z } from "../adapters/node/sevenZip";

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
      sevenZipDetected: find7z() ?? "",
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
        await this.cfg().update("savedGamesPath", msg.savedGames ?? "", vscode.ConfigurationTarget.Global);
        await this.cfg().update("gameInstallPath", msg.gameInstall ?? "", vscode.ConfigurationTarget.Global);
        await this.cfg().update("dataDir", msg.dataDir ?? "", vscode.ConfigurationTarget.Global);
        await this.cfg().update("sevenZipPath", msg.sevenZip ?? "", vscode.ConfigurationTarget.Global);
        this.post({ type: "saved" });
        void vscode.window.showInformationMessage("DCS paths saved.");
        break;
    }
  }

  /** Whether a hand-picked path looks right for its role. The per-role path rule
   *  is pure (core/domain/dcsDetect); the panel only performs the existence probe. */
  private validate(which: "saved" | "install" | "data" | "sevenzip" | undefined, target: string): boolean {
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
    const webview = this.panel.webview;
    const media = (f: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", f));
    const nonce = getNonce();
    const csp = [
      `default-src 'none'`,
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
  <link href="${media("setup.css")}" rel="stylesheet" />
  <title>DCS Setup</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${media("setup.js")}"></script>
</body>
</html>`;
  }
}

// Convenience for a type used by the webview payload.
export type { DcsCandidate };

function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}
