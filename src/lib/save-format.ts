// The one save-with-format path (model studio::edit FormatBeforeSave). Kept
// free of CodeMirror so the app singleton (state.svelte.ts) can own the save
// and every save entry point — editor ⌘S, the global window ⌘S, the File menu
// — routes through it; the editor and the format-on-save lab inject the
// concrete `format` (reformat the active buffer in place) and `persist` (write).

/**
 * Persist the active buffer, reformatting it first when format-on-save is on.
 * The format runs to completion BEFORE the write, so disk matches the
 * reformatted buffer (model FormatOnSaveReformatsBuffer). A format failure —
 * unparseable buffer, semantic-guard trip, backend error — must NEVER block the
 * save: the buffer is persisted unchanged (model SaveNeverBlockedByBrokenLua).
 * Exactly one `persist` per call.
 */
export async function saveWithFormat(opts: {
  formatOnSave: boolean;
  format: () => Promise<void>;
  persist: () => Promise<void>;
}): Promise<void> {
  if (opts.formatOnSave) {
    try {
      await opts.format();
    } catch (error) {
      // A broken buffer (or engine error) degrades to "save unformatted" — it
      // never aborts the write. runFormat already swallows its own failures;
      // this guards the contract regardless of what `format` does.
      console.error("format-on-save failed; saving unformatted:", error);
    }
  }
  await opts.persist();
}
