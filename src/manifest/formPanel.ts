import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";

// The manifest authoring FORM as a companion webview opened beside the normal
// text editor — a split view: raw dcs-studio.toml (real editor: TOML syntax +
// LSP) on one side, the form on the other, two-way bound to the same document.
// Type in the TOML and the form updates; edit the form and the TOML updates.
// One panel per document; closing the document's text editor closes its form.
export class ManifestFormPanel {
  private static readonly panels = new Map<string, ManifestFormPanel>();

  private readonly disposables: vscode.Disposable[] = [];
  // The last text WE wrote into the document, so a form-originated edit echoing
  // back through onDidChangeTextDocument doesn't clobber the form (and its focus).
  private lastWritten: string | null = null;

  /** Open (or reveal) the form beside the editor showing `document`. */
  static openBeside(context: vscode.ExtensionContext, document: vscode.TextDocument): void {
    const key = document.uri.toString();
    const existing = ManifestFormPanel.panels.get(key);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Beside, true);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "dcsStudio.manifestForm",
      `Form: ${path.basename(document.uri.fsPath)}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
      },
    );
    ManifestFormPanel.panels.set(key, new ManifestFormPanel(panel, context, document));
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly document: vscode.TextDocument,
  ) {
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.png");
    this.panel.webview.html = this.html();

    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() !== this.document.uri.toString()) return;
        if (this.document.getText() === this.lastWritten) return; // our own echo
        void this.panel.webview.postMessage({ type: "external", rawText: this.document.getText() });
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        // The code editor for this manifest went away — close its form too.
        if (doc.uri.toString() === this.document.uri.toString()) this.panel.dispose();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("dcsStudio"))
          void this.panel.webview.postMessage({ type: "roots", roots: this.roots() });
      }),
    );

    this.panel.webview.onDidReceiveMessage((m) => void this.onMessage(m), null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private roots(): { savedGames: string; gameInstall: string } {
    const cfg = vscode.workspace.getConfiguration("dcsStudio");
    const home = process.env.USERPROFILE || os.homedir();
    const savedGames =
      cfg.get<string>("savedGamesPath")?.trim() || path.join(home, "Saved Games", "DCS");
    const gameInstall = cfg.get<string>("gameInstallPath")?.trim() || "";
    return { savedGames, gameInstall };
  }

  private async onMessage(msg: { type: string; text?: string; url?: string }): Promise<void> {
    switch (msg.type) {
      case "edit": {
        if (typeof msg.text !== "string" || msg.text === this.document.getText()) return;
        this.lastWritten = msg.text;
        const edit = new vscode.WorkspaceEdit();
        edit.replace(this.document.uri, new vscode.Range(0, 0, this.document.lineCount, 0), msg.text);
        await vscode.workspace.applyEdit(edit);
        break;
      }
      case "openExternal":
        if (msg.url) void vscode.env.openExternal(vscode.Uri.parse(msg.url));
        break;
    }
  }

  private dispose(): void {
    ManifestFormPanel.panels.delete(this.document.uri.toString());
    this.panel.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }

  private html(): string {
    const webview = this.panel.webview;
    const media = (f: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", f));
    const nonce = getNonce();
    const bootstrap = {
      rawText: this.document.getText(),
      targetPath: this.document.uri.fsPath,
      roots: this.roots(),
    };
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
  <link href="${media("manifest.css")}" rel="stylesheet" />
  <title>dcs-studio.toml form</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}">window.__BOOTSTRAP__ = ${JSON.stringify(bootstrap)};</script>
  <script nonce="${nonce}" src="${media("manifest-core.js")}"></script>
  <script nonce="${nonce}" src="${media("manifest.js")}"></script>
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
