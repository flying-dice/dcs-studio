// Marketplace panel store (model studio::market Registry, issue #10): the
// discovered listings + the discover/refresh action. Discovery searches GitHub
// by the `dcs-studio` topic; results are cached backend-side — a still-fresh
// cache returns without a network call, and Refresh forces a live search.
// Mirrors packages.svelte.ts.

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
  /** Whether a discovery has completed at least once (drives empty-state copy). */
  loaded = $state(false);

  /** The currently-open product page, or null while loading / on the store. */
  product = $state<ProductDetail | null>(null);
  productBusy = $state(false);
  productError = $state<string | null>(null);

  /** Discover mods. `force` (the Refresh button) bypasses the backend's
   * fresh-cache shortcut and does a live search. */
  async discover(force = false): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = null;
    try {
      this.listings = await marketDiscover(force);
      this.loaded = true;
    } catch (error) {
      this.error = message(error);
    } finally {
      this.busy = false;
    }
  }

  /** Load one mod's product page (README + install plan + size). */
  async loadProduct(owner: string, name: string): Promise<void> {
    this.productBusy = true;
    this.productError = null;
    this.product = null;
    try {
      this.product = await marketProduct(owner, name);
    } catch (error) {
      this.productError = message(error);
    } finally {
      this.productBusy = false;
    }
  }
}

export const marketplace = new MarketplaceStore();
