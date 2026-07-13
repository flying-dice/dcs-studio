import { describe, it, expect } from "vitest";
import { MockMarketplace, LISTINGS, PRODUCTS } from "../../src/adapters/mock/marketplace";
import type { MarketplacePort } from "../../src/core/ports/marketplace";
import { productInvariants } from "./contract";

// The mock backend implements the same `MarketplacePort` as the GitHub adapter
// and its products satisfy the same behavioral contract — proving the
// marketplace backend swaps behind the port with one composition-root line.

const port: MarketplacePort = new MockMarketplace();

describe("MockMarketplace.discover", () => {
  it("returns the full static catalog as core MarketListing values", async () => {
    const listings = await port.discover("dcs-studio");
    expect(listings).toHaveLength(LISTINGS.length);
    for (const l of listings) {
      expect(l.repo).toMatch(/^[^/]+\/[^/]+$/);
      expect(typeof l.name).toBe("string");
      expect(typeof l.stars).toBe("number");
      expect(Array.isArray(l.labels)).toBe(true);
      expect(typeof l.is_library).toBe("boolean");
    }
  });

  it("includes dependency-only libraries flagged as such", async () => {
    const listings = await port.discover("anything");
    const libs = listings.filter((l) => l.is_library);
    expect(libs.map((l) => l.repo)).toEqual(["dcs-scripting/moose-lite", "utils/dcs-lua-common"]);
  });
});

describe("MockMarketplace.loadProduct", () => {
  it("returns the authored product page for a known listing", async () => {
    const listing = LISTINGS.find((l) => l.repo === "viper-drivers/f16-weapons-expansion")!;
    const p = await port.loadProduct(listing.repo);
    expect(p.repo).toBe(listing.repo);
    expect(p.release_tag).toBe("v2.3.1");
    expect(p.installable).toBe(true);
    expect(p.readme).toContain("F-16C Weapons Expansion");
  });

  it("synthesizes a browsable page for a listing without an authored product", async () => {
    const listing = LISTINGS.find((l) => l.repo === "hoggit-liveries/usaf-aggressors")!;
    expect(PRODUCTS[listing.repo]).toBeUndefined();
    const p = await port.loadProduct(listing.repo);
    expect(p.repo).toBe(listing.repo);
    expect(p.name).toBe(listing.name);
    expect(p.author).toBe(listing.author);
    expect(p.stars).toBe(listing.stars);
    expect(p.is_library).toBe(listing.is_library);
    expect(p.release_tag).toBeNull();
    expect(p.assets).toEqual([]);
    expect(p.installable).toBe(false);
    expect(p.readme).toContain(listing.name);
  });

  it("every listing resolves to a product satisfying the shared marketplace contract", async () => {
    for (const listing of await port.discover("dcs-studio")) {
      const p = await port.loadProduct(listing.repo);
      expect(p.repo).toBe(listing.repo);
      productInvariants(p);
    }
  });

  it("libraries are never installable (same rule as the GitHub mapping)", async () => {
    const moose = await port.loadProduct("dcs-scripting/moose-lite");
    expect(moose.is_library).toBe(true);
    expect(moose.installable).toBe(false);
  });

  it("throws the adapter's not-found message shape for an unknown repo", async () => {
    await expect(port.loadProduct("nobody/does-not-exist")).rejects.toThrow(
      "Repository nobody/does-not-exist was not found.",
    );
  });

  it("release assets carry download URLs (core ProductAsset shape)", async () => {
    const p = await port.loadProduct("viper-drivers/f16-weapons-expansion");
    for (const a of p.assets) {
      expect(a.url).toMatch(/^https:\/\/github\.com\/.+\/releases\/download\//);
      expect(a.size).toBeGreaterThan(0);
    }
  });
});
