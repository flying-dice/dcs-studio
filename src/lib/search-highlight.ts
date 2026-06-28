// Splitting a result line into its pre-match / match / post-match runs for the
// overlay's highlight (model studio::search::SearchMatch — `column`/`length`
// are UTF-16, and JS strings are UTF-16, so the indices slice directly). Pure
// and runes-free so vitest covers the boundary cases the .svelte component
// relies on.

/** A result line split around its matched run. */
export interface HighlightSplit {
  before: string;
  match: string;
  after: string;
}

/**
 * Split `text` around the match at 1-based UTF-16 `column` spanning `length`
 * UTF-16 code units. A zero/negative length, or a column past the end of
 * `text` (a preview clipped by the backend when the match fell beyond the
 * line-length cap), yields an empty `match` so the row still renders its text —
 * just unhighlighted — instead of throwing.
 */
export function highlightSplit(text: string, column: number, length: number): HighlightSplit {
  const start = Math.max(0, column - 1);
  if (length <= 0 || start >= text.length) {
    return { before: text, match: "", after: "" };
  }
  const end = Math.min(text.length, start + length);
  return {
    before: text.slice(0, start),
    match: text.slice(start, end),
    after: text.slice(end),
  };
}
