// Frontend side of the workspace fs watcher (issue #40): listen for the
// backend's debounced `fs://changed` events and hand the affected paths to a
// callback (the app store reconciles the tree + open buffers). Mirrors the
// dcs-link listener singleton; takes a callback so it never imports the store
// (no cycle). A no-op outside Tauri.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauri } from "@tauri-apps/api/core";

class FileWatcher {
  #unlisten: UnlistenFn | null = null;

  /** Subscribe once; `onChange` gets the changed paths for each debounced batch. */
  async init(onChange: (paths: string[]) => void): Promise<void> {
    if (!isTauri() || this.#unlisten) return;
    this.#unlisten = await listen<string[]>("fs://changed", (e) => onChange(e.payload));
  }
}

export const fileWatcher = new FileWatcher();
