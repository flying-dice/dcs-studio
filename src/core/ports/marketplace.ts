import type { MarketListing, ProductDetail } from "../domain/types";

// Port: the marketplace backend. The current adapter is GitHub REST discovery; a
// Rust sidecar over JSON-RPC would implement the same port. Auth is the adapter's
// concern — no tokens in these signatures.

export interface MarketplacePort {
  /** Public products carrying `topic`, most-relevant first. */
  discover(topic: string): Promise<MarketListing[]>;
  /** The full product page (header, README, latest-release facts) for an
   *  `owner/name` repo id. */
  loadProduct(repo: string): Promise<ProductDetail>;
}
