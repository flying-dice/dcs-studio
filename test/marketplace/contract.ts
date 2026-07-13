import { expect } from "vitest";
import type { ProductDetail } from "../../src/core/domain/types";

// Behavioral contract every MarketplacePort backend's products must satisfy —
// shared by the GitHub mapping tests and the mock adapter tests, proving the
// backends are interchangeable behind the port.

export function productInvariants(p: ProductDetail): void {
  // The download size is exactly the sum of the advertised assets.
  expect(p.download_size).toBe(p.assets.reduce((s, a) => s + a.size, 0));
  // Installability requires a manifest asset in the release and a non-library repo.
  const hasManifest = p.assets.some((a) => a.name === "dcs-studio.toml");
  expect(p.installable).toBe(hasManifest && !p.is_library);
  // A product without a release cannot be installable.
  if (p.release_tag === null) expect(p.installable).toBe(false);
}
