// Pure publish helpers that need no I/O: the `.gitignore` content policy the
// share flow enforces. Kept adapter-free so the publish service can apply them
// and they are trivially testable. (Byte formatting lives in ./format.)

/** The ignore entry the publish flow guarantees is present in `.gitignore`. */
export const GITIGNORE_ENTRY = ".dcs-studio/";

/** Whether `.gitignore` text still lacks the DCS Studio release-dir ignore entry. */
export function gitignoreNeedsEntry(text: string): boolean {
  return !text.split(/\r?\n/).some((l) => l.trim() === GITIGNORE_ENTRY);
}

/** The `.gitignore` text with the DCS Studio ignore entry appended (newline-safe). */
export function gitignoreWithEntry(text: string): string {
  return `${(text && !text.endsWith("\n") ? `${text}\n` : text) + GITIGNORE_ENTRY}\n`;
}
