import * as vscode from "vscode";
import { requiresOverwriteConfirm } from "../core/domain/skillsStatus";
import { renderWebviewHtml } from "../webview/html";
import { INSTALL_DIR, type SkillsLibrary } from "./library";

// The Agent Skills experience: a webview panel listing the skill files the
// extension ships (skills/<id>/SKILL.md) with their installed state in the
// workspace repo — install, update, open, view-bundled and remove actions.
// State lives in SkillsLibrary; this class is only the host shell.
export class SkillsPanel {
  public static current: SkillsPanel | undefined;
  private static readonly viewType = "dcsStudio.skills";
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static show(context: vscode.ExtensionContext, manager: SkillsLibrary): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (SkillsPanel.current) {
      SkillsPanel.current.panel.reveal(column);
      void SkillsPanel.current.postSkills();
      return;
    }
    const panel = vscode.window.createWebviewPanel(SkillsPanel.viewType, "Agent Skills", column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
    });
    SkillsPanel.current = new SkillsPanel(panel, context, manager);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly manager: SkillsLibrary,
  ) {
    this.panel = panel;
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.png");
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage((m) => void this.onMessage(m), null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.disposables.push(this.manager.onDidChange(() => void this.postSkills()));
    void this.postSkills();
  }

  private async onMessage(msg: { type: string; id?: string }): Promise<void> {
    switch (msg.type) {
      case "refresh":
        await this.postSkills();
        break;
      case "install":
        if (msg.id) await this.install(msg.id);
        break;
      case "open":
        if (msg.id) await this.openInstalled(msg.id);
        break;
      case "viewBundled":
        if (msg.id) {
          const doc = await vscode.workspace.openTextDocument(this.manager.bundledUri(msg.id));
          await vscode.window.showTextDocument(doc, { preview: true });
        }
        break;
      case "remove":
        if (msg.id) await this.remove(msg.id);
        break;
    }
  }

  private async install(id: string): Promise<void> {
    // Installing over a locally-edited copy loses the user's changes —
    // confirm before overwriting (fresh installs and version updates don't ask).
    const state = (await this.manager.list()).find((s) => s.id === id);
    if (state && requiresOverwriteConfirm(state.status)) {
      const choice = await vscode.window.showWarningMessage(
        `The installed "${id}" skill has local edits. Overwrite them with the bundled v${state.bundledVersion}?`,
        { modal: true },
        "Overwrite",
      );
      if (choice !== "Overwrite") return;
    }
    try {
      const uri = await this.manager.install(id);
      const rel = vscode.workspace.asRelativePath(uri);
      void vscode.window
        .showInformationMessage(
          `Skill installed to ${rel} — commit it with your repo.`,
          "Open File",
        )
        .then((choice) => {
          if (choice) void vscode.window.showTextDocument(uri);
        });
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Skill install failed: ${err instanceof Error ? err.message : err}`,
      );
    }
    await this.postSkills();
  }

  private async openInstalled(id: string): Promise<void> {
    const uri = this.manager.installedUri(id);
    if (!uri) return;
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
  }

  private async remove(id: string): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      `Remove the "${id}" skill from ${INSTALL_DIR}/${id} in your repo?`,
      { modal: true },
      "Remove",
    );
    if (choice !== "Remove") return;
    await this.manager.remove(id);
    await this.postSkills();
  }

  private async postSkills(): Promise<void> {
    const skills = await this.manager.list();
    void this.panel.webview.postMessage({
      type: "skills",
      skills,
      installDir: INSTALL_DIR,
      hasWorkspace: !!vscode.workspace.workspaceFolders?.length,
    });
  }

  private dispose(): void {
    SkillsPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
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
