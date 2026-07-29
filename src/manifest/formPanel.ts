import { win32 as path } from "node:path";
import * as vscode from "vscode";
import type { InstallRootsPort } from "../core/ports/installRoots";
import { renderWebviewHtml } from "../webview/html";
import { createPanel, disposeWithPanel } from "../webview/panel";

// The manifest authoring FORM as a companion webview opened beside the normal
// text editor — a split view: raw dcs-studio.toml (real editor: TOML syntax +
// LSP) on one side, the form on the other, two-way bound to the same document.
// Type in the TOML and the form updates; edit the form and the TOML updates.
// One panel per document; closing the document's text editor closes its form.
export class ManifestFormPanel {
  private static readonly panels = new Map<string, ManifestFormPanel>();

  private readonly disposables: vscode.Disposable[];
  // The last text WE wrote into the document, so a form-originated edit echoing
  // back through onDidChangeTextDocument doesn't clobber the form (and its focus).
  private lastWritten: string | null = null;

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
    private readonly installRoots: InstallRootsPort,
  ) {
    // Keyed by document rather than a single `current`: one form per manifest,
    // so the slot this releases is its entry in the map.
    this.disposables = disposeWithPanel(panel, () => {
      ManifestFormPanel.panels.delete(this.document.uri.toString());
    });
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
  }

  // The same resolution the installer uses, not a second copy of it: the form's
  // resolved-destination preview is a promise about where a link will land, and
  // a preview that disagrees with the installer is worse than none. The copy
  // this replaced skipped the Saved Games\DCS.openbeta fallback, so on an
  // OpenBeta-only machine it showed the author a folder nothing would use.
  private roots(): { savedGames: string; gameInstall: string } {
    return {
      savedGames: this.installRoots.savedGames(),
      gameInstall: this.installRoots.gameInstall() ?? "",
    };
  }

  private async onMessage(msg: { type: string; text?: string }): Promise<void> {
    switch (msg.type) {
      case "edit": {
        if (typeof msg.text !== "string" || msg.text === this.document.getText()) return;
        this.lastWritten = msg.text;
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
          this.document.uri,
          new vscode.Range(0, 0, this.document.lineCount, 0),
          msg.text,
        );
        await vscode.workspace.applyEdit(edit);
        break;
      }
    }
  }

  private html(): string {
    const bootstrap = {
      rawText: this.document.getText(),
      targetPath: this.document.uri.fsPath,
      roots: this.roots(),
    };
    return renderWebviewHtml({
      webview: this.panel.webview,
      extensionUri: this.context.extensionUri,
      title: "dcs-studio.toml form",
      styles: ["manifest.css"],
      inlineScripts: [`window.__BOOTSTRAP__ = ${JSON.stringify(bootstrap)};`],
      scripts: ["manifest-core.js", "manifest.js"],
      csp: { font: true },
    });
  }
}
