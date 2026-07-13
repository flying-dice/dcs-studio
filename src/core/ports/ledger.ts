import type { Subscription } from "../domain/types";

// Port: persistence for the subscription ledger. The current adapter stores
// `<dataDir>/subscriptions.json` (keyed by lowercased repo) and regenerates the
// derived `uninstall-all.bat`; a future sidecar/DB backend implements the same
// port. The persisted shape (`Record<lowercased repo, Subscription>`) is frozen.

export interface SubscriptionLedgerStore {
  /** All subscriptions, keyed by lowercased `repo`. Empty when none/absent. */
  load(): Promise<Record<string, Subscription>>;
  /**
   * Persist the full ledger, replacing prior contents, and regenerate any derived
   * artifacts (e.g. `uninstall-all.bat`).
   */
  save(subs: Record<string, Subscription>): Promise<void>;
}
