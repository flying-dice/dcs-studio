import * as vscode from "vscode";
import type {
  ConsoleEffect,
  ConsoleExportSave,
  ConsoleInbound,
} from "../core/app/consolePresenter";
import { ConsolePresenter } from "../core/app/consolePresenter";
import { renderWebviewHtml } from "../webview/html";
import { activeColumn, createPanel, disposeWithPanel } from "../webview/panel";
import type { BridgeClients } from "./clients";
import { saveExport } from "./saveExport";

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
//
// Everything the host decides — env routing, which requests are well-formed,
// how a rejected RPC becomes an answer, and the per-bridge output cursor —
// lives in ConsolePresenter, which knows nothing about VS Code. This class is
// the shell around it: it owns the panel, the poll timer, the settings read and
// the URI plumbing, and performs the effects the presenter describes.
export class ConsolePanel {
  public static current: ConsolePanel | undefined;
  private static readonly viewType = "dcsStudio.console";

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[];
  private readonly pollTimer: ReturnType<typeof setInterval>;
  private readonly presenter: ConsolePresenter;

  static show(context: vscode.ExtensionContext, clients: BridgeClients): void {
    const column = activeColumn();
    if (ConsolePanel.current) {
      ConsolePanel.current.panel.reveal(column);
      return;
    }
    const panel = createPanel(context, ConsolePanel.viewType, "DCS Lua Console", column);
    ConsolePanel.current = new ConsolePanel(panel, context, clients);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    clients: BridgeClients,
  ) {
    this.panel = panel;
    // The poll loop is a bare interval, not a Disposable, so it is the one
    // thing the shared bag cannot reach — clearing it is this panel's own
    // closing work.
    this.disposables = disposeWithPanel(panel, () => {
      ConsolePanel.current = undefined;
      clearInterval(this.pollTimer);
    });
    this.presenter = new ConsolePresenter({
      bridges: clients,
      // Both rings, named here because which bridges exist is the shell's
      // knowledge — the presenter only knows it has to tail each of them.
      tailed: [clients.gui, clients.mission],
      wildcardDepth: () => this.wildcardDepth(),
      post: (msg) => void this.panel.webview.postMessage(msg),
      effect: (effect) => this.perform(effect),
      saveExport: (request) => this.save(request),
    });
    this.panel.webview.html = this.html(context);

    this.panel.webview.onDidReceiveMessage(
      (m: ConsoleInbound) => void this.presenter.handle(m),
      null,
      this.disposables,
    );
    this.disposables.push(clients.onStatus((s) => this.presenter.pushStatus(s)));

    // The sweep's `**` depth budget is a user setting; push it now and whenever
    // it changes so the explorer's sweep math stays in sync without a reload.
    this.presenter.pushConfig();
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("dcsStudio.explorerWildcardDepth")) this.presenter.pushConfig();
      }),
    );

    // Stream sim `print` output from BOTH bridges while connected.
    this.pollTimer = setInterval(() => void this.presenter.poll(), 1000);
  }

  /** Carry out one presenter-described effect. */
  private perform(effect: ConsoleEffect): void {
    switch (effect.kind) {
      case "launchBridge":
        void vscode.commands.executeCommand("dcs.bridge.launch");
        break;
    }
  }

  /**
   * Save the sim's export where the user chooses, then tidy up after it.
   *
   * The delete runs in a `finally` so it happens on EVERY path out: a copy the
   * user's disk refuses would otherwise leave a multi-megabyte
   * dcs-studio-export-*.json in the DCS write dir forever.
   */
  private async save(request: ConsoleExportSave): Promise<boolean> {
    const temp = vscode.Uri.file(request.path);
    try {
      return await saveExport(temp, request.baseName, request.bytes);
    } finally {
      try {
        await vscode.workspace.fs.delete(temp);
      } catch {
        /* best-effort tidy of the sim-side temp file */
      }
    }
  }

  private wildcardDepth(): number {
    return vscode.workspace.getConfiguration("dcsStudio").get<number>("explorerWildcardDepth", 1);
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
