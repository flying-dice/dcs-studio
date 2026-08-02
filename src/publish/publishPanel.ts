import * as vscode from "vscode";
import type { PublishEffect, PublishInbound } from "../core/app/publishPresenter";
import { PublishPresenter } from "../core/app/publishPresenter";
import type { PublishService } from "../core/app/publishService";
import type { ManifestPort } from "../core/ports/manifest";
import { openExternal } from "../external";
import { renderWebviewHtml } from "../webview/html";
import { activeColumn, createPanel, disposeWithPanel, webviewPoster } from "../webview/panel";
import { preflight, readManifest } from "./preflight";

// The Publish panel: preflight checks, "Share to GitHub" (create repo + push),
// and "Create a release" (7z-packaged, volume-split payload + standalone manifest).
//
// Everything the host decides — the no-folder view, what seeds the form and what
// each field falls back to, whether the checks are re-run before an action is
// allowed to start, and the busy bracket that must clear even on a failure —
// lives in `PublishPresenter`, which knows nothing about VS Code. This class is
// the shell around it: the panel, the workspace root, the fs-and-spawn preflight
// gathering, and the one effect the presenter describes.
export class PublishPanel {
  public static current: PublishPanel | undefined;
  private static readonly viewType = "dcsStudio.publish";
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[];
  private readonly presenter: PublishPresenter;

  static show(
    context: vscode.ExtensionContext,
    publish: PublishService,
    manifest: ManifestPort,
  ): void {
    const column = activeColumn();
    if (PublishPanel.current) {
      PublishPanel.current.panel.reveal(column);
      return;
    }
    const panel = createPanel(context, PublishPanel.viewType, "Publish Mod", column);
    PublishPanel.current = new PublishPanel(panel, context, publish, manifest);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    publish: PublishService,
    // Threaded to `preflight`, which needs one `parseToml` and used to build the
    // concrete manifest core from the extension context itself (#61).
    manifest: ManifestPort,
  ) {
    this.panel = panel;
    this.disposables = disposeWithPanel(panel, () => {
      PublishPanel.current = undefined;
    });
    this.presenter = new PublishPresenter({
      root: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null,
      preflight: (root) => preflight(manifest, root, publish),
      readManifest: (root) => readManifest(manifest, root),
      remoteUrl: (root) => publish.remoteUrl(root, "origin"),
      share: (root, opts, log) => publish.share(root, opts, log),
      cutRelease: (root, opts, log) => publish.cutRelease(root, opts, log),
      post: webviewPoster(panel),
      effect: (effect) => this.perform(effect),
    });
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage(
      (m: PublishInbound) => void this.presenter.handle(m),
      null,
      this.disposables,
    );
    void this.presenter.refresh();
  }

  /** Carry out one presenter-described effect. */
  private perform(effect: PublishEffect): void {
    switch (effect.kind) {
      case "openExternal":
        openExternal(effect.url);
        break;
    }
  }

  private html(): string {
    return renderWebviewHtml({
      webview: this.panel.webview,
      extensionUri: this.context.extensionUri,
      title: "Publish Mod",
      styles: ["publish.css"],
      scripts: ["publish.js"],
    });
  }
}
