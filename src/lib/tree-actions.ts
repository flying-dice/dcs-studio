// File-tree context-menu actions (issue #17): thin orchestration over the
// guarded workspace fs commands plus the open-tab coordination on `app`
// (model studio::files WorkspaceFs + studio::core Workbench). Rename and
// delete route through `app` (they follow/close open tabs); create and
// duplicate are pure fs + a tree refresh.

import {
  createFile,
  createDir,
  duplicatePath,
  readDir,
  type DirEntry,
} from "./api";
import { app } from "./state.svelte";
import { nextUntitledName } from "./new-file";
import { revealInExplorer } from "./reveal";

/** The open workspace root every mutation is scoped to. */
function root(): string {
  const r = app.rootPath;
  if (!r) throw new Error("No workspace is open.");
  return r;
}

function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return i >= 0 ? path.slice(0, i) : path;
}

function joinPath(parent: string, name: string): string {
  const sep = parent.includes("\\") ? "\\" : "/";
  return `${parent.replace(/[\\/]+$/, "")}${sep}${name}`;
}

/** The directory a "new file/folder" on `entry` targets: the folder itself,
 * or the parent of a file. */
export function targetDir(entry: DirEntry): string {
  return entry.is_dir ? entry.path : dirname(entry.path);
}

/** Rename `entry` to `newName` (same parent); follows an open tab. No-op when
 * the name is unchanged or blank. */
export async function renameEntry(entry: DirEntry, newName: string): Promise<void> {
  const trimmed = newName.trim();
  if (!trimmed || trimmed === entry.name) return;
  const dst = joinPath(dirname(entry.path), trimmed);
  await app.renameWorkspacePath(root(), entry.path, dst);
}

/** Duplicate `entry` beside itself under a derived name. */
export async function duplicateEntry(entry: DirEntry): Promise<void> {
  await duplicatePath(root(), entry.path);
  app.refreshTree();
}

/** Delete `entry` to the Recycle Bin after a confirmation; closes its tab. */
export async function deleteEntry(entry: DirEntry): Promise<void> {
  const kind = entry.is_dir ? "folder" : "file";
  const ok = await app.confirm(
    `Delete the ${kind} "${entry.name}"? It goes to the Recycle Bin.`,
  );
  if (!ok) return;
  await app.deleteWorkspacePath(root(), entry.path);
}

/** Create an empty file or folder named `name` inside `parentDir`; a new file
 * is opened in the editor. */
export async function createEntry(
  parentDir: string,
  kind: "file" | "folder",
  name: string,
): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  if (kind === "file") {
    const created = await createFile(root(), parentDir, trimmed);
    app.refreshTree();
    // Label the tab from the path the backend actually created, not the raw
    // typed name, so the two can never desync.
    app.openFile(created, created.split(/[\\/]/).pop() || trimmed);
  } else {
    await createDir(root(), parentDir, trimmed);
    app.refreshTree();
  }
}

/**
 * File → New File (⌘N, issue #59): create a uniquely-named file at the workspace
 * root and open it, reusing the tree's own create-and-open path (`createEntry`).
 * `create_file` (Rust) refuses an existing target, so the name is chosen against
 * the current root entries. A no-op outside a project; an fs failure (a race on
 * the name, an IO error) is logged, never thrown — the menu has no toast surface,
 * the same posture as the app's other fire-and-forget fs failures.
 */
export async function newRootFile(): Promise<void> {
  const r = app.rootPath;
  if (!r) return;
  try {
    const siblings = await readDir(r);
    const name = nextUntitledName(new Set(siblings.map((e) => e.name)));
    await createEntry(r, "file", name);
  } catch (e) {
    console.error("New File failed:", e);
  }
}

/** Copy a path to the clipboard. */
export async function copyPath(path: string): Promise<void> {
  await navigator.clipboard?.writeText(path);
}

/** Copy a path relative to the workspace root to the clipboard. */
export async function copyRelativePath(path: string): Promise<void> {
  const r = app.rootPath ?? "";
  const rel = path.startsWith(r) ? path.slice(r.length).replace(/^[\\/]+/, "") : path;
  await navigator.clipboard?.writeText(rel);
}

/** Reveal a path in the OS file explorer. */
export function reveal(path: string): void {
  void revealInExplorer(path);
}
