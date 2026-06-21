// Generation guard for the Database panel's store (model/studio/database.pds).
// The store runs overlapping async backend calls (discovery, table loads,
// queries); a slow earlier call must not clobber a newer one's result, nor
// strand its loading flag. Each lifecycle carries a `Generation`: `begin`
// captures a token and supersedes any in flight; only the latest token is
// `current`, so a stale call commits nothing. Kept runes-free and out of the
// `.svelte.ts` store so the node vitest config can cover this load-bearing
// supersession logic directly (issue #49 A3 — the injectable seam for vitest).
//
// The store composes two independent guards (file discovery vs the opened-
// database lifecycle) so neither strands the other. Same shape the sibling
// stores inline (todos/marketplace/terminal); hoist to a shared util if a
// third caller wants it.

/** A monotonic supersession guard: hand each async operation a token from
 *  [`begin`], then gate its commit on [`isCurrent`]. */
export class Generation {
  private latest = 0;

  /** Start an operation, superseding any in flight, and return its token. */
  begin(): number {
    this.latest += 1;
    return this.latest;
  }

  /** Whether `token` is still the latest — i.e. not yet superseded by a later
   *  [`begin`] or [`supersede`]. A stale token gates its caller out. */
  isCurrent(token: number): boolean {
    return token === this.latest;
  }

  /** Supersede whatever is in flight without starting new work — e.g. clearing
   *  the selection or resetting on project switch, so a pending call drops. */
  supersede(): void {
    this.latest += 1;
  }
}
