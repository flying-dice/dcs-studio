import * as vscode from "vscode";
import { render, TemplateAssets, TemplateFile } from "../core/domain/projectTemplates";
import {
  validateName,
  assertValidFolderName,
  assertLocationChosen,
  assertRenderedSafe,
  assertNewFolderTarget,
  targetRoot,
  planInPlace,
  NewFolderProbe,
  ProbedFile,
} from "../core/domain/scaffoldPlan";

// Materialises a template into a project root — the port of the real app's
// `scaffold::init`, plus an in-place variant for bootstrapping the folder
// that's already open. This is the adapter: all validation and planning lives
// in core/domain/scaffoldPlan; here we probe the filesystem and execute.

/** Load the assets templates embed (the lua import lib) from native/. */
export async function loadTemplateAssets(extensionUri: vscode.Uri): Promise<TemplateAssets> {
  const luaLib = await vscode.workspace.fs.readFile(
    vscode.Uri.joinPath(extensionUri, "native", "lua5.1", "lua.lib"),
  );
  return { luaLib };
}

export interface ScaffoldResult {
  /** Absolute project root the files were written under. */
  root: string;
  /** Template files NOT written because the folder already had them (in-place only). */
  skipped: string[];
}

/**
 * Scaffold `template` into a NEW folder `<parent>/<name>`. The target must
 * not exist yet, or must be an empty directory.
 */
export async function scaffoldNewFolder(
  extensionUri: vscode.Uri,
  template: string,
  name: string,
  parent: string,
): Promise<ScaffoldResult> {
  const trimmed = validateName(name);
  assertValidFolderName(trimmed);
  assertLocationChosen(parent);

  const files = await renderChecked(extensionUri, template, trimmed);
  const root = targetRoot(parent, trimmed);
  const rootUri = vscode.Uri.file(root);
  assertNewFolderTarget(root, await probeNewFolder(rootUri));

  for (const file of files) await write(rootUri, file);
  return { root, skipped: [] };
}

/**
 * Scaffold `template` directly into `root` (the folder that's already open).
 * Files the folder already has are kept, not overwritten — they're reported
 * back as `skipped`.
 */
export async function scaffoldInPlace(
  extensionUri: vscode.Uri,
  template: string,
  name: string,
  root: string,
): Promise<ScaffoldResult> {
  const trimmed = validateName(name);

  const files = await renderChecked(extensionUri, template, trimmed);
  const rootUri = vscode.Uri.file(root);
  const probed: ProbedFile[] = [];
  for (const file of files) {
    const target = vscode.Uri.joinPath(rootUri, ...file.path.split("/"));
    const exists = await vscode.workspace.fs.stat(target).then(
      () => true,
      () => false,
    );
    probed.push({ file, exists });
  }
  const plan = planInPlace(probed);
  for (const file of plan.toWrite) await write(rootUri, file);
  return { root, skipped: plan.skipped };
}

/** Observe a new-folder target: absent, a file, or an (empty/non-empty) directory. */
async function probeNewFolder(rootUri: vscode.Uri): Promise<NewFolderProbe> {
  const existing = await vscode.workspace.fs.stat(rootUri).then(
    (s) => s,
    () => undefined,
  );
  if (!existing) return { exists: false };
  if (existing.type !== vscode.FileType.Directory) return { exists: true, isDirectory: false };
  const entries = await vscode.workspace.fs.readDirectory(rootUri);
  return { exists: true, isDirectory: true, isEmpty: entries.length === 0 };
}

/** Render the template and vet every path before anything touches disk. */
async function renderChecked(
  extensionUri: vscode.Uri,
  template: string,
  name: string,
): Promise<TemplateFile[]> {
  const assets = await loadTemplateAssets(extensionUri);
  return assertRenderedSafe(render(template, name, assets), template);
}

async function write(rootUri: vscode.Uri, file: TemplateFile): Promise<void> {
  const target = vscode.Uri.joinPath(rootUri, ...file.path.split("/"));
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target, ".."));
  const bytes = typeof file.contents === "string" ? Buffer.from(file.contents, "utf8") : file.contents;
  await vscode.workspace.fs.writeFile(target, bytes);
}
