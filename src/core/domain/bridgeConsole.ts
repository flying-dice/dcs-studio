// Pure Lua-console helpers: export file naming and the "small enough to open in
// an editor" rule. The webview panel (bridge/consolePanel.ts) stays an adapter
// and calls these. (Byte formatting lives in ./format.)

/** Exports at or above 5 MB are announced rather than opened in an editor tab. */
export const EXPORT_OPEN_LIMIT_BYTES = 5 * 1024 * 1024;

/** Whether an export of `bytes` is small enough to open for viewing. */
export function shouldOpenExport(bytes: number): boolean {
  return bytes < EXPORT_OPEN_LIMIT_BYTES;
}

/**
 * Sanitize an explorer node label into a save-dialog file base name: word
 * characters, dots and dashes survive; runs of anything else collapse to "_";
 * leading/trailing underscores are trimmed; capped at 60 chars; empty results
 * (and missing labels) fall back to "lua-export".
 */
export function exportFileBase(label?: string): string {
  return (
    (label || "lua-export")
      .replace(/[^\w.-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "lua-export"
  );
}

/**
 * Save-dialog file base for a `db_export` selection: `"dcs-db-"` + the `what`
 * spec with its `:` separators flattened to `-`, run through
 * [`exportFileBase`]. E.g. `"category:Planes"` → `"dcs-db-category-Planes"`.
 */
export function dbExportFileBase(what: string): string {
  return exportFileBase("dcs-db-" + what.replace(/:/g, "-"));
}
