// Pure validation and planning for the project scaffolder — the decisions that
// surround `vscode.workspace.fs` but need no I/O: name validation, the
// path-traversal guard on rendered template paths, the new-folder empty-dir
// rules, and the in-place skip-existing partition. The adapter at
// src/project/scaffold.ts probes the filesystem and executes the plan these
// functions produce, so all the branching logic is trivially testable here.

import * as path from "node:path";
import type { TemplateFile } from "./projectTemplates";

/** Windows-invalid folder name characters (also fine to reject everywhere). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control chars is the point
export const BAD_NAME = /[<>:"/\\|?*\x00-\x1f]/;

/** Trim the requested project name; reject an empty one. */
export function validateName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Enter a project name.");
  return trimmed;
}

/** Reject a trimmed name that can't be a folder (bad chars or a trailing dot/space). */
export function assertValidFolderName(trimmed: string): void {
  if (BAD_NAME.test(trimmed) || /[. ]$/.test(trimmed)) {
    throw new Error(`"${trimmed}" isn't a valid folder name.`);
  }
}

/** Reject a missing parent location for a new-folder scaffold. */
export function assertLocationChosen(parent: string): void {
  if (!parent.trim()) throw new Error("Choose a location for the project.");
}

/** The absolute root a new-folder scaffold writes under. */
export function targetRoot(parent: string, name: string): string {
  return path.join(parent, name);
}

/** Every component of a rendered path must be a plain name — no `..`, no absolute segments. */
export function assertSafeRelative(rel: string): void {
  if (path.isAbsolute(rel)) throw new Error(`Template path escapes the project root: ${rel}`);
  for (const part of rel.split("/")) {
    if (!part || part === "." || part === ".." || BAD_NAME.test(part)) {
      throw new Error(`Template path escapes the project root: ${rel}`);
    }
  }
}

/**
 * Vet a template's rendered files before anything touches disk: an unknown
 * template renders `undefined`; every path must stay inside the project root.
 */
export function assertRenderedSafe(
  files: TemplateFile[] | undefined,
  template: string,
): TemplateFile[] {
  if (!files) throw new Error(`Unknown template "${template}".`);
  for (const file of files) assertSafeRelative(file.path);
  return files;
}

/** What the adapter observed about a new-folder scaffold's target path. */
export type NewFolderProbe =
  | { exists: false }
  | { exists: true; isDirectory: false }
  | { exists: true; isDirectory: true; isEmpty: boolean };

/**
 * Enforce the new-folder target rules: the folder must not exist, or must be an
 * empty directory. A file at the path, or a non-empty directory, is rejected.
 */
export function assertNewFolderTarget(root: string, probe: NewFolderProbe): void {
  if (!probe.exists) return;
  if (!probe.isDirectory) throw new Error(`"${root}" already exists.`);
  if (!probe.isEmpty) throw new Error(`"${root}" already exists and isn't empty.`);
}

/** A rendered file paired with whether it already exists at the in-place root. */
export interface ProbedFile {
  file: TemplateFile;
  exists: boolean;
}

/**
 * Partition an in-place scaffold: files the folder already has are kept (their
 * paths reported as `skipped`), the rest are written. Order is preserved.
 */
export function planInPlace(probed: ProbedFile[]): { toWrite: TemplateFile[]; skipped: string[] } {
  const toWrite: TemplateFile[] = [];
  const skipped: string[] = [];
  for (const { file, exists } of probed) {
    if (exists) skipped.push(file.path);
    else toWrite.push(file);
  }
  return { toWrite, skipped };
}
