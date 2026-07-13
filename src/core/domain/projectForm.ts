// Pure defaults for the New Project panel: the initial form state (which folder
// to bootstrap in place, the prefilled name and location) and the folder-picker
// start directory. The panel adapter supplies the open folder, the remembered
// last location and the home directory; the branching lives here so it's
// testable without a webview.

import * as path from "node:path";

/** The default project location when nothing is remembered. */
export function defaultLocation(homeDir: string): string {
  return path.join(homeDir, "DCSStudio");
}

/** The initial name/location the New Project form opens with. */
export interface InitialForm {
  /** The open workspace folder to bootstrap in place, or null when none is open. */
  folder: string | null;
  /** Prefilled project name (the folder's basename, or empty). */
  name: string;
  /** Prefilled location (remembered last, else the default; empty when no folder). */
  location: string;
}

/**
 * A folder open: bootstrap it in place by default, name prefilled from the
 * folder, location from the remembered last (else the default). No folder: ask
 * for one — name and location start empty.
 */
export function initialForm(
  folder: string | undefined,
  lastLocation: string | undefined,
  homeDir: string,
): InitialForm {
  const last = lastLocation?.trim();
  return {
    folder: folder ?? null,
    name: folder ? path.basename(folder) : "",
    location: folder ? last || defaultLocation(homeDir) : "",
  };
}

/**
 * Where the folder picker should open: the location typed into the form, else
 * the remembered last, else the default.
 */
export function browseStart(
  requested: string | undefined,
  lastLocation: string | undefined,
  homeDir: string,
): string {
  return requested?.trim() || lastLocation?.trim() || defaultLocation(homeDir);
}
