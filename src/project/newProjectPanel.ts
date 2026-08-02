import * as os from "os";
import * as vscode from "vscode";
import { type NewProjectEffect, NewProjectPresenter } from "../core/app/newProjectPresenter";
import type { NewProjectWebviewMessage } from "../core/app/webviewContract";
import { renderWebviewHtml } from "../webview/html";
import { activeColumn, createPanel, disposeWithPanel, webviewPoster } from "../webview/panel";
import { scaffoldInPlace, scaffoldNewFolder } from "./scaffold";

// The guided New Project experience — the VS Code port of the real app's
// launcher card: template tiles, name, location with live path preview,
// Create. This is the shell: the panel, the workspace-folder read, the two
// `globalState` keys, the folder dialog, the scaffold adapters and the
// presenter's effects. Every decision is in
// `src/core/app/newProjectPresenter.ts`.

const LAST_LOCATION_KEY = "dcs.lastProjectLocation";
export const PENDING_OPEN_KEY = "dcs.pendingProjectOpen";

export class NewProjectPanel {
  public static current: NewProjectPanel | undefined;
  private static readonly viewType = "dcsStudio.newProject";
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[];
  private readonly presenter: NewProjectPresenter;

  static show(context: vscode.ExtensionContext): void {
    const column = activeColumn();
    if (NewProjectPanel.current) {
      NewProjectPanel.current.panel.reveal(column);
      return;
    }
    const panel = createPanel(context, NewProjectPanel.viewType, "New Project", column);
    NewProjectPanel.current = new NewProjectPanel(panel, context);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
  ) {
    this.panel = panel;
    this.disposables = disposeWithPanel(panel, () => {
      NewProjectPanel.current = undefined;
    });
    this.presenter = new NewProjectPresenter({
      folder: () => this.workspaceFolder(),
      homeDir: os.homedir(),
      lastLocation: () => this.context.globalState.get<string>(LAST_LOCATION_KEY),
      rememberLocation: (location) =>
        Promise.resolve(this.context.globalState.update(LAST_LOCATION_KEY, location)),
      setPendingOpen: (root) =>
        Promise.resolve(this.context.globalState.update(PENDING_OPEN_KEY, root)),
      pickFolder: (start) => this.pickFolder(start),
      scaffoldInPlace: (template, name, folder) =>
        scaffoldInPlace(this.context.extensionUri, template, name, folder),
      scaffoldNewFolder: (template, name, location) =>
        scaffoldNewFolder(this.context.extensionUri, template, name, location),
      post: webviewPoster(panel),
      effect: (effect) => this.run(effect),
    });
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage(
      (m: NewProjectWebviewMessage) => void this.presenter.handle(m),
      null,
      this.disposables,
    );
    this.presenter.pushInit();
  }

  /** The open workspace folder to bootstrap in place, if any. */
  private workspaceFolder(): string | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder?.uri.scheme === "file" ? folder.uri.fsPath : undefined;
  }

  private async pickFolder(start: string): Promise<string | undefined> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Use as location",
      defaultUri: vscode.Uri.file(start),
    });
    return picked?.[0]?.fsPath;
  }

  private run(effect: NewProjectEffect): void {
    switch (effect.kind) {
      case "close":
        this.panel.dispose();
        break;
      case "notice":
        void vscode.window.showInformationMessage(effect.message);
        break;
      case "authorManifest":
        void vscode.commands.executeCommand("dcs.manifest.author");
        break;
      case "openFolder":
        void vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(effect.root), {
          forceNewWindow: false,
        });
        break;
    }
  }

  private html(): string {
    return renderWebviewHtml({
      webview: this.panel.webview,
      extensionUri: this.context.extensionUri,
      title: "New Project",
      styles: ["newproject.css"],
      scripts: ["newproject.js"],
      csp: { font: true },
    });
  }
}
