import * as os from "os";
import * as vscode from "vscode";
import { exportFileBase, shouldOpenExport } from "../core/domain/bridgeConsole";
import type { DualBridgeStatus } from "../core/domain/bridgeProtocol";
import { fmtBytes } from "../core/domain/format";
import { renderWebviewHtml } from "../webview/html";
import type { BridgeClient, LuaEnv } from "./client";
import type { BridgeClients } from "./clients";

// The Lua console: a REPL against the live sim over the bridges, with a target
// environment picker (GUI/hooks, mission scripting env, or another net state).
// Calls route to the bridge serving the chosen env: mission → the mission
// bridge (port 25570), everything else → the GUI bridge. Code runs via
// `repl_eval` and shows the return value; `print` output streams in via
// `console_read` polling — each bridge has its OWN output ring, so both are
// tailed. An Explorer tab is a lazy `_G` tree per env
// (repl_inspect/repl_expand) with function signatures resolved on demand
// (repl_signature — the runtime reads parameter names off a call hook, never
// running the function), a path-glob sweep bounded by the
// `dcsStudio.explorerWildcardDepth` setting (pushed to the webview as an
// `explorerConfig` message), and a full-table JSON export: the sim writes the file, we
// copy it wherever the user picks.
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
    const panel = vscode.window.createWebviewPanel(
      ConsolePanel.viewType,
      "DCS Lua Console",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
      },
    );
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

    // The sweep's `**` depth budget is a user setting; push it now and whenever
    // it changes so the explorer's sweep math stays in sync without a reload.
    this.postConfig();
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("dcsStudio.explorerWildcardDepth")) this.postConfig();
      }),
    );

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
      case "ready":
        // The webview finished booting — (re)push the current status and the
        // explorer's sweep-depth config so it renders from a known state.
        this.postStatus(this.clients.current);
        this.postConfig();
        break;
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
          // `luaType` (not `type`) carries the value's Lua type — the envelope's
          // own `type` field is "inspectResult" and must not be shadowed.
          this.post({
            type: "inspectResult",
            id: msg.id,
            env,
            expr: msg.expr,
            ok: r.ok,
            err: r.err,
            luaType: r.type,
            value: r.value,
            ref: r.ref,
          });
        } catch (e) {
          this.post({
            type: "inspectResult",
            id: msg.id,
            env,
            expr: msg.expr,
            ok: false,
            err: errText(e),
          });
        }
        break;
      }
      case "expand": {
        if (typeof msg.ref !== "number") return;
        try {
          const r = await client.replExpand(env, msg.ref);
          this.post({
            type: "expandResult",
            nodeId: msg.nodeId,
            ok: true,
            variables: r.variables ?? [],
          });
        } catch (e) {
          this.post({ type: "expandResult", nodeId: msg.nodeId, ok: false, err: errText(e) });
        }
        break;
      }
      case "signature": {
        if (typeof msg.ref !== "number") return;
        try {
          const r = await client.replSignature(env, msg.ref);
          this.post({
            type: "signatureResult",
            reqId: msg.reqId,
            ok: r.ok,
            params: r.params,
            native: r.native,
            err: r.err,
          });
        } catch (e) {
          this.post({ type: "signatureResult", reqId: msg.reqId, ok: false, err: errText(e) });
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
      case "launch":
        // The offline status line's inline CTA — funnel into the same
        // dcs.bridge.launch command as the Command Palette and the status
        // bar dispatcher (single implementation, per ARCHITECTURE.md).
        void vscode.commands.executeCommand("dcs.bridge.launch");
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
          void vscode.window.showInformationMessage(
            `Exported ${fmtBytes(bytes)} to ${target.fsPath}`,
          );
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

  /** Push the explorer's sweep depth budget (the `**` wildcard cost). */
  private postConfig(): void {
    const wildcardDepth = vscode.workspace
      .getConfiguration("dcsStudio")
      .get<number>("explorerWildcardDepth", 1);
    this.post({ type: "explorerConfig", wildcardDepth });
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
    return renderWebviewHtml({
      webview: this.panel.webview,
      extensionUri: context.extensionUri,
      title: "DCS Lua Console",
      styles: ["console.css"],
      scripts: ["explorer-core.js", "console-explorer.js", "console.js"],
      csp: { font: true },
    });
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
