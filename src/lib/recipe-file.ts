// "New file from recipe" (issue #60): the Recipes panel's third card action
// seeds a new, real file at the workspace root with a recipe's snippet and opens
// it. The app has no untitled-buffer concept (see new-file.ts) — #59 chose a
// disk-backed New File, and this matches that pattern: a uniquely-named file on
// disk, opened already-saved (its on-disk text === the buffer, so not dirty).
//
// Pure orchestration over injected seams (RecipeFileOps) so vitest can drive the
// whole action — name choice, seeding, open, the no-project + fs-failure edges —
// without the runes store or Tauri (the seam convention of state.svelte's
// projectOps / writeFile and intel's IntelFs). The store binds the real app/api.

import { uniqueLuaName } from "./new-file";
import type { Recipe } from "./recipes";

/**
 * The fs + workbench seams the recipe action needs, injected so the action is
 * testable without Tauri or the runes store. The store wires these to the real
 * `app` / `api`; a fake in-memory fs drives them in vitest.
 */
export interface RecipeFileOps {
  /** The open workspace root, or null when no project is open. */
  rootPath(): string | null;
  /** Sibling entries at a directory — only `name` is read (collision check). */
  readDir(dir: string): Promise<{ name: string }[]>;
  /** Create an empty file `name` under `parentDir`; returns the created path.
   *  Refuses an existing target (Rust `create_file`). */
  createFile(parentDir: string, name: string): Promise<string>;
  /** Write `contents` to `path` — seeds the snippet into the new file. */
  writeFile(path: string, contents: string): Promise<void>;
  /** Open `path` as an editor tab labelled `name`. */
  openFile(path: string, name: string): void;
  /** Refresh the file tree after the create. */
  refreshTree(): void;
}

/**
 * A filesystem-safe base name from a recipe title: lower-cased, every run of
 * non-alphanumeric characters collapsed to a single `-`, leading/trailing dashes
 * trimmed. Empty when the title has no alphanumerics (e.g. only punctuation) —
 * the caller falls back to `untitled` (issue #60).
 */
export function recipeBaseName(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Create a new file at the workspace root seeded with `recipe.code` and open it
 * (issue #60). The name is the recipe title slugified (→ `untitled` when the
 * title yields nothing), uniquified against the root's siblings. Seeds the file
 * BEFORE opening so the tab loads its content from disk already-saved, not dirty.
 *
 * Mirrors `newRootFile`'s posture: a no-op with no project open, and any fs
 * failure (a name race, an IO error) is logged, never thrown — the panel has no
 * toast surface, the app's fire-and-forget fs convention.
 */
export async function createFileFromRecipe(
  recipe: Recipe,
  ops: RecipeFileOps,
): Promise<void> {
  const root = ops.rootPath();
  if (!root) return;
  try {
    const siblings = await ops.readDir(root);
    const base = recipeBaseName(recipe.title) || "untitled";
    const name = uniqueLuaName(base, new Set(siblings.map((e) => e.name)));
    const created = await ops.createFile(root, name);
    await ops.writeFile(created, recipe.code);
    ops.refreshTree();
    ops.openFile(created, created.split(/[\\/]/).pop() || name);
  } catch (e) {
    console.error("New file from recipe failed:", e);
  }
}
