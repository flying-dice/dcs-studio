import * as vscode from "vscode";
import type { SkillsConfirm, SkillsEffect, SkillsInbound } from "../core/app/skillsPresenter";
import { SkillsPresenter } from "../core/app/skillsPresenter";
import { renderWebviewHtml } from "../webview/html";
import { activeColumn, createPanel, disposeWithPanel } from "../webview/panel";
import type { SkillsLibrary } from "./library";

// The Agent Skills experience: a webview panel listing the skill files the
// extension ships (skills/<id>/SKILL.md) with their installed state in the
// workspace repo — install, update, open, view-bundled and remove actions.
//
// Everything the host decides — the one payload the screen renders from, the
// overwrite gate on a locally-edited skill, that a failure still refreshes the
// list while a refusal does not, and the two different ways a file is opened —
// lives in `SkillsPresenter`, which knows nothing about VS Code. This class is
// the shell around it: the panel, the `SkillsLibrary` adapter, the
// workspace-folder read, the modal, the document opens and the toast.
export class SkillsPanel {
  public static current: SkillsPanel | undefined;
  private static readonly viewType = "dcsStudio.skills";
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[];
  private readonly presenter: SkillsPresenter;

  static show(context: vscode.ExtensionContext, manager: SkillsLibrary): void {
    const column = activeColumn();
    if (SkillsPanel.current) {
      SkillsPanel.current.panel.reveal(column);
      void SkillsPanel.current.presenter.refresh();
      return;
    }
    const panel = createPanel(context, SkillsPanel.viewType, "Agent Skills", column);
    SkillsPanel.current = new SkillsPanel(panel, context, manager);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    manager: SkillsLibrary,
  ) {
    this.panel = panel;
    this.disposables = disposeWithPanel(panel, () => {
      SkillsPanel.current = undefined;
    });
    this.presenter = new SkillsPresenter({
      list: () => manager.list(),
      hasWorkspace: () => !!vscode.workspace.workspaceFolders?.length,
      install: async (id) => {
        const uri = await manager.install(id);
        // The ref is the uri's own round-trippable text, not `fsPath`: skills
        // install into the workspace repo, which may be remote or virtual.
        return { ref: uri.toString(), label: vscode.workspace.asRelativePath(uri) };
      },
      remove: (id) => manager.remove(id),
      installedRef: (id) => manager.installedUri(id)?.toString(),
      bundledRef: (id) => manager.bundledUri(id).toString(),
      confirm: (question) => this.confirm(question),
      post: (msg) => void this.panel.webview.postMessage(msg),
      effect: (effect) => this.perform(effect),
    });
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage(
      (m: SkillsInbound) => void this.presenter.handle(m),
      null,
      this.disposables,
    );
    this.disposables.push(manager.onDidChange(() => void this.presenter.refresh()));
    void this.presenter.refresh();
  }

  /** Ask the presenter's question as a modal, and report the button pressed. */
  private async confirm(question: SkillsConfirm): Promise<string | undefined> {
    return vscode.window.showWarningMessage(
      question.message,
      { modal: true },
      question.confirmLabel,
    );
  }

  /** Carry out one presenter-described effect. */
  private perform(effect: SkillsEffect): void {
    switch (effect.kind) {
      case "installed":
        void vscode.window.showInformationMessage(effect.message, "Open File").then((choice) => {
          if (choice) void vscode.window.showTextDocument(vscode.Uri.parse(effect.ref));
        });
        break;
      case "installFailed":
        showInstallFailed(effect.error);
        break;
      case "openInstalled":
        void this.openDocument(effect.ref, false);
        break;
      case "viewBundled":
        // A preview tab: the bundled copy is the extension's, not the user's, so
        // peeking at it must not consume a tab the way opening theirs does.
        void this.openDocument(effect.ref, true);
        break;
    }
  }

  private async openDocument(ref: string, preview: boolean): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(ref));
    await vscode.window.showTextDocument(doc, preview ? { preview: true } : undefined);
  }

  private html(): string {
    return renderWebviewHtml({
      webview: this.panel.webview,
      extensionUri: this.context.extensionUri,
      title: "Agent Skills",
      styles: ["skills.css"],
      scripts: ["skills.js"],
      csp: { img: "data:" },
    });
  }
}

/**
 * The one place a failed skill install is reported. Both entry points — the
 * panel's `installFailed` effect and the activation nudge's "Update" — land
 * here, so a repo that cannot be written to says the same thing either way.
 */
export function showInstallFailed(err: unknown): void {
  void vscode.window.showErrorMessage(
    `Skill install failed: ${err instanceof Error ? err.message : err}`,
  );
}
