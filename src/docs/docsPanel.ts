import * as vscode from "vscode";

// The Documentation experience: a webview panel with a table-of-contents
// sidebar and per-feature guide pages (Mod Manager, manifest reference,
// publishing, console, debugger…). Content lives in media/docs-content.js;
// this class is only the host shell. Pages can deep-link each other and run
// extension commands ("Open Marketplace") via postMessage.
export class DocsPanel {
  public static current: DocsPanel | undefined;
  private static readonly viewType = "dcsStudio.docs";
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static show(context: vscode.ExtensionContext, page?: string): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (DocsPanel.current) {
      DocsPanel.current.panel.reveal(column);
      if (page) DocsPanel.current.post({ type: "goto", page });
      return;
    }
    const panel = vscode.window.createWebviewPanel(DocsPanel.viewType, "Documentation", column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
    });
    DocsPanel.current = new DocsPanel(panel, context, page);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    initialPage?: string,
  ) {
    this.panel = panel;
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.png");
    this.panel.webview.html = this.html(initialPage);
    this.panel.webview.onDidReceiveMessage((m) => void this.onMessage(m), null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private async onMessage(msg: { type: string; command?: string; url?: string }): Promise<void> {
    switch (msg.type) {
      case "run":
        if (msg.command) void vscode.commands.executeCommand(msg.command);
        break;
      case "openExternal":
        if (msg.url) void vscode.env.openExternal(vscode.Uri.parse(msg.url));
        break;
    }
  }

  private post(msg: unknown): void {
    void this.panel.webview.postMessage(msg);
  }

  private dispose(): void {
    DocsPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }

  private html(initialPage?: string): string {
    const webview = this.panel.webview;
    const media = (f: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", f));
    const nonce = getNonce();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${media("docs.css")}" rel="stylesheet" />
  <title>Documentation</title>
</head><body>
  <div id="app"></div>
  <script nonce="${nonce}">window.__INITIAL_PAGE__ = ${JSON.stringify(initialPage ?? "")};</script>
  <script nonce="${nonce}" src="${media("docs-content.js")}"></script>
  <script nonce="${nonce}" src="${media("docs.js")}"></script>
</body></html>`;
  }
}

function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}
