// OS file-manager / associated-app actions for the binary placeholder.
// Plumbing intentionally left out of the model (like the folder-picker dialog):
// reveal-in-explorer and open-with-app are OS plumbing, not modeled behaviour.
// Both no-op in a plain browser (the lab + e2e run without Tauri) so the
// placeholder's buttons are click-safe there.
import { isTauri } from "@tauri-apps/api/core";
import { revealItemInDir, openPath } from "@tauri-apps/plugin-opener";

/** Select the file in the OS file explorer (Explorer / Finder / Files). */
export function revealInExplorer(path: string): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  return revealItemInDir(path);
}

/** Open the file in its OS-associated application. */
export function openInAssociatedApp(path: string): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  return openPath(path);
}
