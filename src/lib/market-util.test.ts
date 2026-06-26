import { describe, it, expect } from "vitest";
import { productId } from "./market-util";

describe("productId", () => {
  it("joins author/name and equals the canonical product.repo", () => {
    // The backend builds repo/author/name from one GitHub RepoRef, so the
    // run-key derived from a product always equals its canonical `repo`.
    const product = { author: "FlyingDice", name: "CoolMod", repo: "FlyingDice/CoolMod" };
    expect(productId(product)).toBe("FlyingDice/CoolMod");
    expect(productId(product)).toBe(product.repo);
  });

  it("stays canonical under route-casing drift — the Cancel-gate regression", () => {
    // given a deep link / shared URL arriving raw (deeplink.rs passes path
    // segments verbatim), the route casing differs from GitHub-canonical.
    const product = { author: "FlyingDice", name: "CoolMod", repo: "FlyingDice/CoolMod" };
    const routeCased = "flyingdice/coolmod"; // what install(owner, repo) used to seed

    // when the install is seeded from the product (the fix) the gate key matches
    // product.repo; the old route-cased seed does not — so the progress card and
    // its Cancel rendered for none of the install.
    expect(productId(product)).toBe(product.repo);
    expect(routeCased).not.toBe(productId(product));
  });
});
