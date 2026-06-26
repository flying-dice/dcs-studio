// Pure marketplace helpers (no Tauri, no runes) — unit-tested in market-util.test.ts.
import type { ProductDetail } from "./api";

/** A product's install run-key: `author/name`. Equal to `product.repo` by
 * construction — the backend builds all three from one GitHub RepoRef
 * (`market.rs`: `repo = "{owner}/{name}"`, `author = owner`, `name = name`).
 *
 * Seed an install — and gate its progress card / Cancel — on this, never on raw
 * route params. A deep link (`deeplink.rs` passes path segments verbatim), a
 * shared URL, or a stale post-rename cache entry can carry non-canonical casing;
 * that diverges from `product.repo`, so a route-cased key would fail the gate and
 * hide the card — and its Cancel — for the entire install. Derived from the
 * product, the key is casing- and rename-proof. */
export function productId(p: Pick<ProductDetail, "author" | "name">): string {
  return `${p.author}/${p.name}`;
}
