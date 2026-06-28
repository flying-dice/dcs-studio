// Which tabs each bulk close targets — the pure selection logic behind the
// editor tab context menu's close-family (model/studio/core.pds CloseOtherTabs
// / CloseTabsToRight / CloseAllTabs / CloseSavedTabs). Kept out of the reactive
// AppState so the order- and edge-sensitive choices (a path not open, the last
// tab, an all-dirty strip) are unit-tested without Tauri or Svelte runes;
// AppState routes each returned path through `closeFile`, which keeps the
// per-tab dirty prompt so unsaved work is never silently lost.

/** The minimum a bulk close needs to pick its targets: a tab's path and the
 * two texts whose divergence makes it dirty (a structural subset of OpenDoc). */
export interface ClosableTab {
  path: string;
  docText: string;
  savedText: string;
}

/** Every tab's path, in tab-strip order (Close All). */
export function allTabPaths(tabs: ClosableTab[]): string[] {
  return tabs.map((t) => t.path);
}

/** Paths of every tab except `path`, in tab-strip order (Close Others). When
 * `path` is not open, every tab is returned. */
export function otherTabPaths(tabs: ClosableTab[], path: string): string[] {
  return tabs.filter((t) => t.path !== path).map((t) => t.path);
}

/** Paths of every tab positioned after `path`, in tab-strip order (Close to
 * the Right). Empty when `path` is the last tab or is not open. */
export function rightwardTabPaths(tabs: ClosableTab[], path: string): string[] {
  const i = tabs.findIndex((t) => t.path === path);
  return i < 0 ? [] : tabs.slice(i + 1).map((t) => t.path);
}

/** Paths of every clean (unmodified) tab, in tab-strip order — the tabs the
 * "Close Saved" command targets. A tab is clean when its buffer matches its
 * on-disk baseline, so a still-loading tab (blank buffer and baseline) counts
 * as clean. */
export function cleanTabPaths(tabs: ClosableTab[]): string[] {
  return tabs.filter((t) => t.docText === t.savedText).map((t) => t.path);
}
