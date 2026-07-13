import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import { TEMPLATES } from "../core/domain/projectTemplates";
import { scaffoldInPlace, scaffoldNewFolder } from "./scaffold";
import { initialForm, browseStart } from "../core/domain/projectForm";

// The guided New Project experience — the VS Code port of the real app's
// launcher card: template tiles, name, location with live path preview,
// Create. Scaffolds via src/project/scaffold.ts, then opens the new folder
// (the pending-open flag makes the manifest + form appear after the reload).

const LAST_LOCATION_KEY = "dcs.lastProjectLocation";
export const PENDING_OPEN_KEY = "dcs.pendingProjectOpen";

export class NewProjectPanel {
  public static current: NewProjectPanel | undefined;
  private static readonly viewType = "dcsStudio.newProject";
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static show(context: vscode.ExtensionContext): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (NewProjectPanel.current) {
      NewProjectPanel.current.panel.reveal(column);
      return;
    }
    const panel = vscode.window.createWebviewPanel(NewProjectPanel.viewType, "New Project", column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
    });
    NewProjectPanel.current = new NewProjectPanel(panel, context);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
  ) {
    this.panel = panel;
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.png");
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage((m) => void this.onMessage(m), null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    void this.pushInit();
  }

  /** The open workspace folder to bootstrap in place, if any. */
  private workspaceFolder(): string | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder?.uri.scheme === "file" ? folder.uri.fsPath : undefined;
  }

  private pushInit(): void {
    const folder = this.workspaceFolder();
    const last = this.context.globalState.get<string>(LAST_LOCATION_KEY);
    this.post({
      type: "init",
      templates: TEMPLATES,
      sep: path.sep,
      ...initialForm(folder, last, os.homedir()),
    });
  }

  private async onMessage(msg: {
    type: string;
    template?: string;
    name?: string;
    location?: string;
    inPlace?: boolean;
  }): Promise<void> {
    switch (msg.type) {
      case "browse": {
        const last = this.context.globalState.get<string>(LAST_LOCATION_KEY);
        const start = browseStart(msg.location, last, os.homedir());
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: "Use as location",
          defaultUri: vscode.Uri.file(start),
        });
        if (picked?.[0]) this.post({ type: "browsed", path: picked[0].fsPath });
        break;
      }
      case "create":
        await this.create(msg.template ?? "", msg.name ?? "", msg.location ?? "", !!msg.inPlace);
        break;
    }
  }

  private async create(template: string, name: string, location: string, inPlace: boolean): Promise<void> {
    try {
      const folder = this.workspaceFolder();
      if (inPlace && folder) {
        // Bootstrap the open folder itself — no reload needed.
        const result = await scaffoldInPlace(this.context.extensionUri, template, name, folder);
        this.post({ type: "created" });
        this.panel.dispose();
        if (result.skipped.length) {
          void vscode.window.showInformationMessage(
            `Kept ${result.skipped.length} existing file(s) the template also provides: ${result.skipped.join(", ")}`,
          );
        }
        await vscode.commands.executeCommand("dcs.manifest.author");
        return;
      }

      const result = await scaffoldNewFolder(this.context.extensionUri, template, name, location);
      await this.context.globalState.update(LAST_LOCATION_KEY, location);
      this.post({ type: "created" });
      // Opening the folder reloads the extension host; the pending flag
      // tells the next activation to open the manifest + form.
      await this.context.globalState.update(PENDING_OPEN_KEY, result.root);
      await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(result.root), {
        forceNewWindow: false,
      });
    } catch (err) {
      this.post({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  private post(msg: unknown): void {
    void this.panel.webview.postMessage(msg);
  }

  private dispose(): void {
    NewProjectPanel.current = undefined;
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
  <link href="${media("newproject.css")}" rel="stylesheet" />
  <title>New Project</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${media("newproject.js")}"></script>
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
