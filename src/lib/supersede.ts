/**
 * "Latest call wins" coordinator for overlapping async work whose results can
 * resolve out of order. Each `run` takes a monotonic ticket; its result is
 * tagged `current` only if that ticket is still the latest issued, so a slow
 * earlier call can never clobber a newer one. A thrown task resolves to
 * `fallback` (fail-safe).
 *
 * Used by the Build-affordance probe (issue #69): FileTree's 5s poll plus
 * window focus / visibilitychange fire `Cargo.toml` existence probes that can
 * overlap a tree mutation; without an ordering guard a stale `exists=true`
 * could re-show Build after the root `Cargo.toml` was removed. Tauri `invoke`
 * gives no cross-call response ordering, so a root-identity guard alone is not
 * enough — recency must be tracked too.
 */
export class Superseder {
  private seq = 0;

  /** Run `task`, returning its result tagged `current` (true iff this is still
   * the most recent run issued). A thrown task yields `fallback`. */
  async run<T>(
    task: () => Promise<T>,
    fallback: T,
  ): Promise<{ value: T; current: boolean }> {
    const ticket = ++this.seq;
    let value: T;
    try {
      value = await task();
    } catch {
      value = fallback;
    }
    return { value, current: ticket === this.seq };
  }
}
