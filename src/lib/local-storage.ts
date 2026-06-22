// Shared localStorage helper: the one guarded setter every per-machine UI-state
// store reuses (panel sizes, recents, editor theme, format-on-save, bookmarks),
// rather than each re-implementing the quota / SSR-absence guard. A standalone
// module — not a method on `app` — so the bookmark store can reuse it without a
// circular import back into state.svelte.ts.

/** Persist one string to localStorage, swallowing quota / SSR-absence errors. */
export function writeLocalStorage(key: string, value: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore quota / serialization errors */
  }
}
