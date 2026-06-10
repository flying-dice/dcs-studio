// Thin wrappers over the Rust filesystem commands + the folder-picker dialog.
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export function readDir(path: string): Promise<DirEntry[]> {
  return invoke<DirEntry[]>("read_dir", { path });
}

export function readTextFile(path: string): Promise<string> {
  return invoke<string>("read_text_file", { path });
}

export function writeTextFile(path: string, contents: string): Promise<void> {
  return invoke<void>("write_text_file", { path, contents });
}

export function basename(path: string): Promise<string> {
  return invoke<string>("basename", { path });
}

/** Whether a path still exists on disk (used to flag stale recent projects). */
export function pathExists(path: string): Promise<boolean> {
  return invoke<boolean>("path_exists", { path });
}

/** A file to materialise inside a new project; `path` is relative to the root. */
export interface NewFile {
  path: string;
  contents: string;
}

/**
 * Scaffold a new project at `<parent>/<name>` and write the given template
 * files. Returns the absolute path of the new project root.
 */
export function createProject(
  parent: string,
  name: string,
  files: NewFile[],
): Promise<string> {
  return invoke<string>("create_project", { parent, name, files });
}

/** Open the native folder picker; returns the chosen path or null if cancelled. */
export async function pickFolder(): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false });
  return typeof selected === "string" ? selected : null;
}
