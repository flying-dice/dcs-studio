import * as vscode from "vscode";
import * as path from "path";
import { LogTailer, FileState } from "./tailer";
import { LogBuffer, LogEntry, ModIdentity, modIdentity } from "../core/domain/dcsLog";
import type { ManifestPort } from "../core/ports/manifest";
import { savedGamesDir } from "../bridge/paths";

// The DCS Log viewer: a singleton WebviewPanel (shape copied from
// bridge/consolePanel.ts) live-tailing Saved Games/DCS/Logs/dcs.log via
// LogTailer, with parsing/buffering/mod-matching done by the tested pure core
// (src/core/domain/dcsLog.ts). Works with or without the bridge — it only
// reads a file off disk. Restarts its tailer when dcsStudio.savedGamesPath
// changes, and re-derives "my mod" identity from the workspace's
// dcs-studio.toml (hidden — no error — when there's no workspace or manifest).
export class LogPanel {
  public static current: LogPanel | undefined;
  private static readonly viewType = "dcsStudio.logViewer";

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly buffer = new LogBuffer();
  private tailer: LogTailer | undefined;
  private mod: ModIdentity | null = null;
  private lastDropped = 0;
  private fileState: FileState = "missing";
  private filePath = "";

  static show(context: vscode.ExtensionContext, manifestPort: ManifestPort): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (LogPanel.current) {
      LogPanel.current.panel.reveal(column);
      return;
    }
    const panel = vscode.window.createWebviewPanel(LogPanel.viewType, "DCS Log", column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
    });
    LogPanel.current = new LogPanel(panel, context, manifestPort);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    private readonly manifestPort: ManifestPort,
  ) {
    this.panel = panel;
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.png");
    this.panel.webview.html = this.html(context);

    this.panel.webview.onDidReceiveMessage((m) => void this.onMessage(m), null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("dcsStudio.savedGamesPath")) this.restartTailer();
      }),
    );

    void this.loadModIdentity().then(() => this.restartTailer());
  }

  /** Re-derive "my mod" identity from the workspace's dcs-studio.toml; null on any failure. */
  private async loadModIdentity(): Promise<void> {
    try {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        this.mod = null;
      } else {
        const uri = vscode.Uri.joinPath(folder.uri, "dcs-studio.toml");
        const bytes = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(bytes).toString("utf8");
        const model = this.manifestPort.parseToml(text);
        this.mod = modIdentity(model.project?.name);
      }
    } catch {
      this.mod = null;
    }
    this.post({ type: "mod", mod: this.mod });
  }

  private restartTailer(): void {
    this.tailer?.stop();
    this.buffer.clear();
    this.lastDropped = 0;
    this.filePath = path.join(savedGamesDir(), "Logs", "dcs.log");
    this.tailer = new LogTailer({
      filePath: this.filePath,
      onLines: (lines) => this.handleLines(lines),
      onState: (state) => this.handleState(state),
      onReset: () => this.handleReset(),
    });
    this.tailer.start();
  }

  private handleLines(lines: string[]): void {
    const entries: LogEntry[] = [];
    const cont: { seq: number; cont: string[] }[] = [];
    for (const line of lines) {
      const ev = this.buffer.push(line, this.mod);
      if (ev.kind === "added") entries.push(ev.entry);
      else cont.push({ seq: ev.entry.seq, cont: ev.entry.cont });
    }
    const dropped = this.buffer.droppedCount - this.lastDropped;
    this.lastDropped = this.buffer.droppedCount;
    if (entries.length || cont.length || dropped) {
      this.post({ type: "append", entries, cont, dropped });
    }
  }

  private handleState(state: FileState): void {
    this.fileState = state;
    this.post({ type: "fileState", state, file: this.filePath });
  }

  private handleReset(): void {
    this.buffer.clear();
    this.lastDropped = 0;
    this.post({ type: "reset" });
  }

  private async onMessage(msg: { type: string }): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.post({
          type: "init",
          entries: this.buffer.list(),
          mod: this.mod,
          file: this.filePath,
          state: this.fileState,
        });
        break;
      case "clear":
        this.buffer.clear();
        this.lastDropped = 0;
        break;
      case "openSettings":
        void vscode.commands.executeCommand("dcs.setup.open");
        break;
    }
  }

  private post(msg: unknown): void {
    void this.panel.webview.postMessage(msg);
  }

  private dispose(): void {
    LogPanel.current = undefined;
    this.tailer?.stop();
    this.panel.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }

  private html(context: vscode.ExtensionContext): string {
    const webview = this.panel.webview;
    const media = (f: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", f));
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
  <link href="${media("log.css")}" rel="stylesheet" />
  <title>DCS Log</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${media("log.js")}"></script>
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
