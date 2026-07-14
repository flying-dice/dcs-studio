import * as os from "os";
import * as vscode from "vscode";
import { exportFileBase, shouldOpenExport } from "../core/domain/bridgeConsole";
import { fmtBytes } from "../core/domain/format";
import { DualBridgeStatus } from "../core/domain/bridgeProtocol";
import { BridgeClient, LuaEnv } from "./client";
import { BridgeClients } from "./clients";

// The Lua console: a REPL against the live sim over the bridges, with a target
// environment picker (GUI/hooks, mission scripting env, or another net state).
// Calls route to the bridge serving the chosen env: mission → the mission
// bridge (port 25570), everything else → the GUI bridge. Code runs via
// `repl_eval` and shows the return value; `print` output streams in via
// `console_read` polling — each bridge has its OWN output ring, so both are
// tailed. An Explorer tab drills into Lua tables lazily
// (repl_inspect/repl_expand) and can export any table in full as JSON: the sim
// writes the file, we copy it wherever the user picks.
export class ConsolePanel {
  public static current: ConsolePanel | undefined;
  private static readonly viewType = "dcsStudio.console";

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  /** Per-bridge tail state. A reconnect means the server (and its ring)
   * restarted — reset the cursor so the fresh ring is read from the start. */
  private readonly tails = new Map<BridgeClient, { lastSeq: number; wasConnected: boolean }>();

  static show(context: vscode.ExtensionContext, clients: BridgeClients): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (ConsolePanel.current) {
      ConsolePanel.current.panel.reveal(column);
      return;
    }
    const panel = vscode.window.createWebviewPanel(ConsolePanel.viewType, "DCS Lua Console", column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
    });
    ConsolePanel.current = new ConsolePanel(panel, context, clients);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    private readonly clients: BridgeClients,
  ) {
    this.panel = panel;
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.png");
    this.panel.webview.html = this.html(context);

    this.tails.set(clients.gui, { lastSeq: 0, wasConnected: false });
    this.tails.set(clients.mission, { lastSeq: 0, wasConnected: false });

    this.panel.webview.onDidReceiveMessage((m) => void this.onMessage(m), null, this.disposables);
    this.disposables.push(this.clients.onStatus((s) => this.postStatus(s)));
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // Stream sim `print` output from BOTH bridges while connected.
    this.pollTimer = setInterval(() => void this.poll(), 1000);
  }

  private async onMessage(msg: {
    type: string;
    env?: LuaEnv;
    envs?: LuaEnv[];
    code?: string;
    expr?: string;
    ref?: number;
    id?: number;
    nodeId?: number;
    reqId?: number;
    label?: string;
  }): Promise<void> {
    const env: LuaEnv = msg.env ?? "gui";
    const client = this.clients.forEnv(env);
    switch (msg.type) {
      case "eval": {
        if (typeof msg.code !== "string") return;
        try {
          const r = await client.replEval(env, msg.code);
          if (r.ok) this.post({ type: "result", value: r.result === undefined ? null : r.result });
          else this.post({ type: "error", message: r.err || "error" });
        } catch (e) {
          this.post({ type: "error", message: errText(e) });
        }
        break;
      }
      case "inspect": {
        if (typeof msg.expr !== "string") return;
        try {
          const r = await client.replInspect(env, msg.expr);
          this.post({ type: "inspectResult", id: msg.id, env, expr: msg.expr, ...r });
        } catch (e) {
          this.post({ type: "inspectResult", id: msg.id, env, expr: msg.expr, ok: false, err: errText(e) });
        }
        break;
      }
      case "expand": {
        if (typeof msg.ref !== "number") return;
        try {
          const r = await client.replExpand(env, msg.ref);
          this.post({ type: "expandResult", nodeId: msg.nodeId, ok: true, variables: r.variables ?? [] });
        } catch (e) {
          this.post({ type: "expandResult", nodeId: msg.nodeId, ok: false, err: errText(e) });
        }
        break;
      }
      case "clearExplorer": {
        // Release sim-side refs in every env the tree touched (routed to the
        // env's own bridge); an env that is gone (mission ended) has nothing
        // to release — ignore its error.
        for (const e of msg.envs ?? []) {
          try {
            await this.clients.forEnv(e).replClear(e);
          } catch {
            /* state gone; nothing held */
          }
        }
        break;
      }
      case "export": {
        await this.export(env, msg);
        break;
      }
      case "clear":
        // Client-side clear only; the sim buffer keeps its own tail.
        break;
    }
  }

  /** Full-table JSON export: the sim serializes to a temp file in its write
   * dir; we copy that to wherever the user picks, then open it if it's small
   * enough to view comfortably. */
  private async export(
    env: LuaEnv,
    msg: { ref?: number; expr?: string; label?: string; reqId?: number },
  ): Promise<void> {
    try {
      const { path, bytes } = await this.clients
        .forEnv(env)
        .replExport(env, { ref: msg.ref, expr: msg.expr });
      const temp = vscode.Uri.file(path);
      const base = exportFileBase(msg.label);
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(os.homedir());
      const target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.joinPath(folder, `${base}.json`),
        filters: { JSON: ["json"] },
      });
      if (target) {
        await vscode.workspace.fs.copy(temp, target, { overwrite: true });
        if (shouldOpenExport(bytes)) {
          const doc = await vscode.workspace.openTextDocument(target);
          await vscode.window.showTextDocument(doc, { preview: true });
        } else {
          void vscode.window.showInformationMessage(`Exported ${fmtBytes(bytes)} to ${target.fsPath}`);
        }
      }
      try {
        await vscode.workspace.fs.delete(temp);
      } catch {
        /* best-effort tidy of the sim-side temp file */
      }
      this.post({ type: "exportDone", reqId: msg.reqId, saved: !!target });
    } catch (e) {
      this.post({ type: "exportDone", reqId: msg.reqId, saved: false, error: errText(e) });
    }
  }

  private async poll(): Promise<void> {
    await Promise.all([this.pollOne(this.clients.gui), this.pollOne(this.clients.mission)]);
  }

  private async pollOne(client: BridgeClient): Promise<void> {
    const tail = this.tails.get(client);
    if (!tail) return;
    const connected = client.current.connected;
    if (!connected) {
      tail.wasConnected = false;
      return;
    }
    if (!tail.wasConnected) {
      // Fresh connection = the server restarted with a fresh ring (both
      // servers outlive missions and only restart with DCS) — read it from 0.
      tail.wasConnected = true;
      tail.lastSeq = 0;
    }
    try {
      const { lines, latest } = await client.consoleRead(tail.lastSeq);
      if (lines.length) {
        tail.lastSeq = latest;
        this.post({ type: "print", lines });
      } else if (latest > tail.lastSeq) {
        tail.lastSeq = latest;
      }
    } catch {
      /* transient; next tick retries */
    }
  }

  private postStatus(s: DualBridgeStatus): void {
    this.post({ type: "status", status: s });
  }

  private post(msg: unknown): void {
    void this.panel.webview.postMessage(msg);
  }

  private dispose(): void {
    ConsolePanel.current = undefined;
    if (this.pollTimer) clearInterval(this.pollTimer);
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
  <link href="${media("console.css")}" rel="stylesheet" />
  <title>DCS Lua Console</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${media("console.js")}"></script>
</body>
</html>`;
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}
