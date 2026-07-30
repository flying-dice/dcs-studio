import { win32 as path } from "node:path";
import * as vscode from "vscode";
import { ManifestPresenter } from "../core/app/manifestPresenter";
import type { InstallRootsPort } from "../core/ports/installRoots";
import { renderWebviewHtml } from "../webview/html";
import { createPanel, disposeWithPanel } from "../webview/panel";

// The manifest authoring FORM as a companion webview opened beside the normal
// text editor — a split view: raw dcs-studio.toml (real editor: TOML syntax +
// LSP) on one side, the form on the other, two-way bound to the same document.
// Type in the TOML and the form updates; edit the form and the TOML updates.
// One panel per document; closing the document's text editor closes its form.
//
// The shell over `core/app/manifestPresenter.ts`: the panel, the map it lives
// in, the three workspace listeners with their per-document filters, and the
// `WorkspaceEdit`. The echo rule, the bootstrap payload and the edit guards are
// the presenter's — and, because this panel is keyed per document rather than a
// singleton, so is ONE PRESENTER PER PANEL, constructed below and dying with it.
export class ManifestFormPanel {
  private static readonly panels = new Map<string, ManifestFormPanel>();

  private readonly disposables: vscode.Disposable[];
  private readonly presenter: ManifestPresenter;

  /** Open (or reveal) the form beside the editor showing `document`. */
  static openBeside(
    context: vscode.ExtensionContext,
    document: vscode.TextDocument,
    roots: InstallRootsPort,
  ): void {
    const key = document.uri.toString();
    const existing = ManifestFormPanel.panels.get(key);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Beside, true);
      return;
    }
    const panel = createPanel(
      context,
      "dcsStudio.manifestForm",
      `Form: ${path.basename(document.uri.fsPath)}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    );
    ManifestFormPanel.panels.set(key, new ManifestFormPanel(panel, context, document, roots));
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly document: vscode.TextDocument,
    installRoots: InstallRootsPort,
  ) {
    // Keyed by document rather than a single `current`: one form per manifest,
    // so the slot this releases is its entry in the map.
    this.disposables = disposeWithPanel(panel, () => {
      ManifestFormPanel.panels.delete(this.document.uri.toString());
    });
    this.presenter = new ManifestPresenter({
      text: () => this.document.getText(),
      targetPath: this.document.uri.fsPath,
      installRoots,
      write: async (text) => {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(this.document.uri, new vscode.Range(0, 0, this.document.lineCount, 0), text);
        await vscode.workspace.applyEdit(edit);
      },
      post: (msg) => void this.panel.webview.postMessage(msg),
    });
    this.panel.webview.html = this.html();

    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() !== this.document.uri.toString()) return;
        this.presenter.onDocumentChanged();
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        // The code editor for this manifest went away — close its form too.
        if (doc.uri.toString() === this.document.uri.toString()) this.panel.dispose();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("dcsStudio")) this.presenter.pushRoots();
      }),
    );

    this.panel.webview.onDidReceiveMessage(
      (m) => void this.presenter.handle(m),
      null,
      this.disposables,
    );
  }

  private html(): string {
    return renderWebviewHtml({
      webview: this.panel.webview,
      extensionUri: this.context.extensionUri,
      title: "dcs-studio.toml form",
      styles: ["manifest.css"],
      // The form's opening state crosses in the document, not as a message —
      // `media/manifest.js` reads it synchronously at load.
      inlineScripts: [`window.__BOOTSTRAP__ = ${JSON.stringify(this.presenter.bootstrap())};`],
      scripts: ["manifest-core.js", "manifest.js"],
      csp: { font: true },
    });
  }
}
