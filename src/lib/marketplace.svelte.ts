// Marketplace panel store (model studio::market Registry, issue #10): the
// discovered listings + the discover/refresh action, and the open product page.
// Discovery searches GitHub by the `dcs-studio` topic; results are cached
// backend-side — a still-fresh cache returns without a network call, and Refresh
// forces a live search. Mirrors packages.svelte.ts.

import {
  marketDiscover,
  marketProduct,
  type MarketListing,
  type ProductDetail,
} from "./api";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class MarketplaceStore {
  /** Discovered mods (every public repo carrying the `dcs-studio` topic). */
  listings = $state<MarketListing[]>([]);
  busy = $state(false);
  error = $state<string | null>(null);
  /** Whether a discovery has *completed* (success OR failure) at least once —
   * drives empty-state copy AND stops the panel's load effect from re-firing on
   * a persistent error (it is set in `finally`, not only on success). */
  loaded = $state(false);

  /** The currently-open product page, or null while loading / on the store. */
  product = $state<ProductDetail | null>(null);
  productBusy = $state(false);
  productError = $state<string | null>(null);

  // Monotonic token so a slow product load can't clobber a newer one (rapid
  // A→B→A navigation): only the latest call writes its result.
  #productGen = 0;

  /** Discover mods. `force` (the Refresh button) bypasses the backend's
   * fresh-cache shortcut and does a live search. */
  async discover(force = false): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = null;
    try {
      this.listings = await marketDiscover(force);
    } catch (error) {
      this.error = message(error);
    } finally {
      // Mark loaded on BOTH paths so a failed discovery doesn't retry-loop.
      this.loaded = true;
      this.busy = false;
    }
  }

  /** Load one mod's product page (README + install plan + size). */
  async loadProduct(owner: string, name: string): Promise<void> {
    const gen = ++this.#productGen;
    this.productBusy = true;
    this.productError = null;
    this.product = null;
    try {
      const detail = await marketProduct(owner, name);
      if (gen === this.#productGen) this.product = detail;
    } catch (error) {
      if (gen === this.#productGen) this.productError = message(error);
    } finally {
      if (gen === this.#productGen) this.productBusy = false;
    }
  }

  /** Drop all discovered/product state — called on sign-out so the next user
   * (or the next sign-in) never sees the previous account's listings. */
  reset(): void {
    this.listings = [];
    this.error = null;
    this.loaded = false;
    this.product = null;
    this.productError = null;
    this.#productGen += 1; // abandon any in-flight product load
  }
}

export const marketplace = new MarketplaceStore();
