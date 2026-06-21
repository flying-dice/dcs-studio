import { describe, it, expect } from "vitest";

import {
  RECIPES,
  RECIPE_CATEGORIES,
  categoryLabel,
  filterRecipes,
  type Recipe,
} from "./recipes";

const KNOWN_CATEGORIES = new Set(RECIPE_CATEGORIES.map((c) => c.id));

describe("catalog integrity", () => {
  it("has recipes", () => {
    expect(RECIPES.length).toBeGreaterThan(0);
  });

  it("gives every recipe a unique id", () => {
    const ids = RECIPES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never ships a blank id, title, blurb, or code", () => {
    for (const r of RECIPES) {
      expect(r.id.trim(), `id of ${r.id}`).not.toBe("");
      expect(r.title.trim(), `title of ${r.id}`).not.toBe("");
      expect(r.blurb.trim(), `blurb of ${r.id}`).not.toBe("");
      expect(r.code.trim(), `code of ${r.id}`).not.toBe("");
    }
  });

  it("only uses known categories", () => {
    for (const r of RECIPES) {
      expect(KNOWN_CATEGORIES.has(r.category), `category of ${r.id}`).toBe(true);
    }
  });

  it("every snippet returns a value so the console shows output", () => {
    // The console runs loadstring(code)() and serialises the return value;
    // a snippet with no `return` would run blank. log-only snippets still
    // return a confirmation string.
    for (const r of RECIPES) {
      expect(r.code.includes("return "), `code of ${r.id} returns`).toBe(true);
    }
  });

  it("keeps optional fields well-typed when present", () => {
    for (const r of RECIPES) {
      if (r.tags !== undefined) {
        expect(Array.isArray(r.tags), `tags of ${r.id}`).toBe(true);
        for (const tag of r.tags) expect(tag.trim(), `tag of ${r.id}`).not.toBe("");
      }
      if (r.needsMission !== undefined) {
        expect(typeof r.needsMission, `needsMission of ${r.id}`).toBe("boolean");
      }
    }
  });

  it("populates every advertised category with at least one recipe", () => {
    for (const c of RECIPE_CATEGORIES) {
      expect(RECIPES.some((r) => r.category === c.id), `category ${c.id}`).toBe(true);
    }
  });
});

describe("categoryLabel", () => {
  it("resolves a known category to its label", () => {
    expect(categoryLabel("sqlite")).toBe("SQLite");
  });
});

describe("filterRecipes", () => {
  const sample: Recipe[] = [
    { id: "a", category: "sqlite", title: "Export to CSV", blurb: "dump rows", code: "return 1", tags: ["write_csv", "export"] },
    { id: "b", category: "sqlite", title: "In-memory DB", blurb: "scratch", code: "return 2", tags: [":memory:"] },
    { id: "c", category: "dcs", title: "Model time", blurb: "sim clock", code: "return 3", tags: ["time"] },
  ];

  it("returns everything when query is empty and category is all", () => {
    expect(filterRecipes(sample, "", "all")).toHaveLength(3);
  });

  it("treats a whitespace-only query as empty", () => {
    expect(filterRecipes(sample, "   ", "all")).toHaveLength(3);
  });

  it("filters by category", () => {
    const out = filterRecipes(sample, "", "sqlite");
    expect(out.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("matches the query against the title, case-insensitively", () => {
    expect(filterRecipes(sample, "model", "all").map((r) => r.id)).toEqual(["c"]);
  });

  it("lower-cases the query too (upper-case input still matches)", () => {
    expect(filterRecipes(sample, "EXPORT", "all").map((r) => r.id)).toEqual(["a"]);
  });

  it("matches against tags", () => {
    expect(filterRecipes(sample, "write_csv", "all").map((r) => r.id)).toEqual(["a"]);
  });

  it("matches against the blurb", () => {
    expect(filterRecipes(sample, "scratch", "all").map((r) => r.id)).toEqual(["b"]);
  });

  it("requires every term to match (AND, not OR)", () => {
    // "csv" hits a only; "memory" hits b only — together nothing.
    expect(filterRecipes(sample, "csv memory", "all")).toHaveLength(0);
    // both terms on the same recipe -> kept.
    expect(filterRecipes(sample, "export csv", "all").map((r) => r.id)).toEqual(["a"]);
  });

  it("intersects the category and the query", () => {
    expect(filterRecipes(sample, "time", "sqlite")).toHaveLength(0);
    expect(filterRecipes(sample, "memory", "sqlite").map((r) => r.id)).toEqual(["b"]);
  });

  it("lets the category name itself be a search term", () => {
    expect(filterRecipes(sample, "dcs", "all").map((r) => r.id)).toEqual(["c"]);
  });
});
