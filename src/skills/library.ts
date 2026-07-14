import * as vscode from "vscode";
import {
  compareVersions,
  INSTALL_DIR,
  parseFrontmatter,
  type SkillInfo,
  skillInfoFor,
} from "../core/domain/skillsStatus";

// Agent skill files the extension ships (skills/<id>/SKILL.md in the VSIX)
// and their installed copies in the workspace repo (.claude/skills/<id>/).
// The SKILL.md frontmatter carries a `version:`; comparing bundled vs
// installed drives the "update available" state surfaced in the nav badge,
// the Skills panel, and the activation toast.
//
// This class is the adapter: it does the vscode.workspace.fs reads/copies and
// owns the file watchers. The status state machine, frontmatter parsing and
// version compare are pure and live in core/domain/skillsStatus.

export type { SkillInfo, SkillStatus } from "../core/domain/skillsStatus";
// Re-exported from core for stable import paths (nav, skillsPanel, extension).
export { compareVersions, INSTALL_DIR, parseFrontmatter };

export class SkillsLibrary implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  private readonly subs: vscode.Disposable[] = [];

  constructor(private readonly extensionUri: vscode.Uri) {
    this.watchWorkspace();
    this.subs.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.watchWorkspace();
        this.changeEmitter.fire();
      }),
    );
  }

  private workspaceWatcher: vscode.FileSystemWatcher | undefined;

  private watchWorkspace(): void {
    this.workspaceWatcher?.dispose();
    this.workspaceWatcher = undefined;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, `${INSTALL_DIR}/**`),
    );
    watcher.onDidCreate(() => this.changeEmitter.fire());
    watcher.onDidChange(() => this.changeEmitter.fire());
    watcher.onDidDelete(() => this.changeEmitter.fire());
    this.workspaceWatcher = watcher;
  }

  /** The bundled skills/ dir inside the extension. */
  private get bundledRoot(): vscode.Uri {
    return vscode.Uri.joinPath(this.extensionUri, "skills");
  }

  bundledUri(id: string): vscode.Uri {
    return vscode.Uri.joinPath(this.bundledRoot, id, "SKILL.md");
  }

  installedUri(id: string): vscode.Uri | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return undefined;
    return vscode.Uri.joinPath(folder.uri, INSTALL_DIR, id, "SKILL.md");
  }

  /** Every bundled skill, with its installed state in the current workspace. */
  async list(): Promise<SkillInfo[]> {
    const entries = await vscode.workspace.fs.readDirectory(this.bundledRoot).then(
      (e) => e,
      () => [] as [string, vscode.FileType][],
    );
    const skills: SkillInfo[] = [];
    for (const [id, type] of entries) {
      if (type !== vscode.FileType.Directory) continue;
      const info = await this.inspect(id);
      if (info) skills.push(info);
    }
    return skills;
  }

  /** Count of installed skills with a newer bundled version (nav badge / toast). */
  async updatesAvailable(): Promise<SkillInfo[]> {
    return (await this.list()).filter((s) => s.status === "outdated");
  }

  private async inspect(id: string): Promise<SkillInfo | undefined> {
    const bundledText = await readText(this.bundledUri(id));
    if (bundledText === undefined) return undefined;
    const installedUri = this.installedUri(id);
    const installedText = installedUri ? await readText(installedUri) : undefined;
    return skillInfoFor(id, bundledText, installedUri !== undefined, installedText);
  }

  /** Copy the bundled skill folder into the workspace repo (install or update). */
  async install(id: string): Promise<vscode.Uri> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) throw new Error("Open a folder first — skills install into the workspace repo.");
    const dest = vscode.Uri.joinPath(folder.uri, INSTALL_DIR, id);
    await copyDir(vscode.Uri.joinPath(this.bundledRoot, id), dest);
    this.changeEmitter.fire();
    return vscode.Uri.joinPath(dest, "SKILL.md");
  }

  /** Delete the installed copy from the workspace repo. */
  async remove(id: string): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;
    const dest = vscode.Uri.joinPath(folder.uri, INSTALL_DIR, id);
    await vscode.workspace.fs.delete(dest, { recursive: true, useTrash: true });
    this.changeEmitter.fire();
  }

  dispose(): void {
    this.workspaceWatcher?.dispose();
    while (this.subs.length) this.subs.pop()?.dispose();
    this.changeEmitter.dispose();
  }
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString("utf8");
  } catch {
    return undefined;
  }
}

async function copyDir(src: vscode.Uri, dest: vscode.Uri): Promise<void> {
  await vscode.workspace.fs.createDirectory(dest);
  for (const [name, type] of await vscode.workspace.fs.readDirectory(src)) {
    const from = vscode.Uri.joinPath(src, name);
    const to = vscode.Uri.joinPath(dest, name);
    if (type === vscode.FileType.Directory) {
      await copyDir(from, to);
    } else {
      await vscode.workspace.fs.copy(from, to, { overwrite: true });
    }
  }
}
