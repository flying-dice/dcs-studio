import type { Subscription } from "../domain/types";

// Port: persistence for the subscription ledger. The current adapter stores
// `<dataDir>/subscriptions.json` (keyed by lowercased repo) and regenerates the
// derived `uninstall-all.bat`; a future sidecar/DB backend implements the same
// port. The persisted shape (`Record<lowercased repo, Subscription>`) is frozen.

/**
 * What a load found, and what it had to recover from on the way.
 *
 * `recovered` used to be a one-shot flag on the adapter, drained through a
 * `takeCorruptNotice()` the port did not declare (#64). That was a side channel
 * in every sense that matters: it had to be consumed exactly once, in the right
 * order, by an unspecified caller; nothing in `load()`'s type said a notice
 * might be waiting; it could only be tested through the adapter; and with two
 * panels open, whichever asked second saw nothing — so the user never learned
 * their ledger had been quarantined.
 *
 * Attaching it to the read that produced it removes the class rather than
 * relocating it: the notice cannot be drained by the wrong caller, needs no
 * mutable state on the adapter, and a backend with no concept of a quarantined
 * file simply never sets it.
 */
export interface LedgerRead {
  /** All subscriptions, keyed by lowercased `repo`. Empty when none/absent. */
  subs: Record<string, Subscription>;
  /**
   * Set when the stored ledger could not be read and was preserved rather than
   * discarded. `subs` is then empty and does NOT mean "nothing is installed":
   * links may still be in the user's DCS folders, with the preserved file the
   * only record of them.
   */
  recovered?: { quarantinedTo: string };
}

export interface SubscriptionLedgerStore {
  /** Tolerant read: empty `subs` when the ledger is missing or unreadable. */
  load(): Promise<LedgerRead>;
  /**
   * Persist the full ledger, replacing prior contents, and regenerate any derived
   * artifacts (e.g. `uninstall-all.bat`).
   */
  save(subs: Record<string, Subscription>): Promise<void>;
}
