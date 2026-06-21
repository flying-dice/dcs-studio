import { describe, it, expect } from "vitest";

import { Generation } from "./database-gen";

describe("Generation", () => {
  it("treats a freshly begun token as current", () => {
    const gen = new Generation();
    const token = gen.begin();
    expect(gen.isCurrent(token)).toBe(true);
  });

  it("supersedes an in-flight token when a newer operation begins", () => {
    const gen = new Generation();
    const stale = gen.begin();
    const fresh = gen.begin();
    // The slow earlier call drops; only the latest commits. This is the guard
    // the store relies on so a refresh-mid-query / re-select can't clobber.
    expect(gen.isCurrent(stale)).toBe(false);
    expect(gen.isCurrent(fresh)).toBe(true);
  });

  it("supersedes the in-flight token without starting new work", () => {
    const gen = new Generation();
    const inFlight = gen.begin();
    gen.supersede(); // clearSelection / reset path
    expect(gen.isCurrent(inFlight)).toBe(false);
  });

  it("keeps two guards independent — one's churn never strands the other", () => {
    // Models the store's two counters: discovery vs the opened-database
    // lifecycle. A burst of selections must not invalidate an in-flight refresh.
    const discover = new Generation();
    const selection = new Generation();
    const discoverToken = discover.begin();
    selection.begin();
    selection.begin();
    selection.supersede();
    expect(discover.isCurrent(discoverToken)).toBe(true);
  });
});
