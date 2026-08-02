import * as vscode from "vscode";
import type { DocsInbound } from "../core/app/docsPresenter";
import { DocsPresenter } from "../core/app/docsPresenter";
import { openExternal } from "../external";
import { renderWebviewHtml } from "../webview/html";
import { activeColumn, createPanel, disposeWithPanel, webviewPoster } from "../webview/panel";

// The Documentation experience: a webview panel with a table-of-contents
// sidebar and per-feature guide pages (Mod Manager, manifest reference,
// publishing, console, debugger…). Content lives in media/docs-content.js;
// this class is only the host shell over `core/app/docsPresenter.ts`. Pages can
// deep-link each other and run extension commands ("Open Marketplace") via
// postMessage.
export class DocsPanel {
  public static current: DocsPanel | undefined;
  private static readonly viewType = "dcsStudio.docs";
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[];
  private readonly presenter: DocsPresenter;

  static show(context: vscode.ExtensionContext, page?: string): void {
    const column = activeColumn();
    if (DocsPanel.current) {
      DocsPanel.current.panel.reveal(column);
      // Whether a reveal also navigates is the presenter's rule, not the
      // panel's — see the note on `navigate`.
      DocsPanel.current.presenter.navigate(page);
      return;
    }
    const panel = createPanel(context, DocsPanel.viewType, "Documentation", column);
    DocsPanel.current = new DocsPanel(panel, context, page);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    initialPage?: string,
  ) {
    this.panel = panel;
    this.disposables = disposeWithPanel(panel, () => {
      DocsPanel.current = undefined;
    });
    this.presenter = new DocsPresenter({
      post: webviewPoster(panel),
      effect: (e) => {
        switch (e.kind) {
          case "runCommand":
            void vscode.commands.executeCommand(e.command);
            break;
          case "openExternal":
            openExternal(e.url);
            break;
        }
      },
    });
    this.panel.webview.html = this.html(this.presenter.bootstrap(initialPage).page);
    this.panel.webview.onDidReceiveMessage(
      (m: DocsInbound) => this.presenter.handle(m),
      null,
      this.disposables,
    );
  }

  private html(initialPage: string): string {
    return renderWebviewHtml({
      webview: this.panel.webview,
      extensionUri: this.context.extensionUri,
      title: "Documentation",
      styles: ["docs.css"],
      inlineScripts: [`window.__INITIAL_PAGE__ = ${JSON.stringify(initialPage)};`],
      scripts: ["docs-content.js", "docs.js"],
      csp: { img: "data:" },
    });
  }
}
