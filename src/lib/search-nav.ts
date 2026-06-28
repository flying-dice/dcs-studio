// Keyboard selection math for the search overlay's result list (model
// studio::search::FindInFiles — the Up/Down navigation over the flat,
// path-then-line-ordered match list). Pure and runes-free so vitest covers it
// directly (the store stays thin); the .svelte.ts store just holds the index.

/**
 * Move a selection index over a list of `count` items by `delta`, wrapping at
 * both ends. With no items there is nothing to select, so the result is `-1`.
 * From the no-selection state (`-1`), a forward step lands on the first item
 * and a backward step on the last — so the first Down/Up after a search picks a
 * sensible end.
 */
export function moveSelection(current: number, count: number, delta: number): number {
  if (count <= 0) return -1;
  if (current < 0) return delta >= 0 ? 0 : count - 1;
  return (((current + delta) % count) + count) % count;
}
