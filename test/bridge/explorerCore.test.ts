import { describe, it, expect } from "vitest";
// The webview's pure explorer logic runs unmodified in Node via its UMD export
// (the manifest-core precedent). Exercise every glob/filter/sweep branch here.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const core = require("../../media/explorer-core.js");

describe("globMatch — glob subset", () => {
  it("matches literal segment paths and rejects mismatches", () => {
    expect(core.globMatch("_G/db/Units", "_G/db/Units", {})).toBe(true);
    expect(core.globMatch("_G/db/Units", "_G/db/Weapons", {})).toBe(false);
  });

  it("`*` matches a whole single segment but not across `/`", () => {
    expect(core.globMatch("_G/db/Units", "_G/*/Units", {})).toBe(true);
    expect(core.globMatch("_G/db/Units", "_G/*", {})).toBe(false); // * is one segment
    expect(core.globMatch("_G/db", "_G/*", {})).toBe(true);
    expect(core.globMatch("_G/dbXY", "_G/db*", {})).toBe(true);
  });

  it("`?` matches exactly one character", () => {
    expect(core.globMatch("_G/ab", "_G/a?", {})).toBe(true);
    expect(core.globMatch("_G/abc", "_G/a?", {})).toBe(false);
  });

  it("`**` spans zero or more segments", () => {
    expect(core.globMatch("_G/db/Units/Cars", "_G/**/Cars", {})).toBe(true);
    expect(core.globMatch("_G/Cars", "_G/**/Cars", {})).toBe(true); // zero segments
    expect(core.globMatch("_G/db/Units/Cars", "**", {})).toBe(true); // trailing ** swallows rest
    expect(core.globMatch("_G/db/Units", "_G/**", {})).toBe(true);
    expect(core.globMatch("_G/db/x", "**/Cars", {})).toBe(false);
  });

  it("collapses consecutive `**`", () => {
    expect(core.globMatch("_G/db/Units", "_G/**/**/Units", {})).toBe(true);
  });

  it("is case-insensitive (deliberate deviation from minimatch)", () => {
    expect(core.globMatch("_G/DB/uNiTs", "_g/db/units", {})).toBe(true);
  });

  it("a path longer than a slash-terminated pattern does not match without `**`", () => {
    expect(core.globMatch("_G/db/Units", "_G/db", {})).toBe(false);
  });

  it("partial mode: a path that is a prefix of the pattern matches", () => {
    expect(core.globMatch("_G", "_G/db/Units", { partial: true })).toBe(true);
    expect(core.globMatch("_G/db", "_G/db/Units", { partial: true })).toBe(true);
    expect(core.globMatch("_G/net", "_G/db/Units", { partial: true })).toBe(false);
    expect(core.globMatch("_G", "_G/db/Units", {})).toBe(false); // non-partial: no
  });

  it("partial mode with `**` still matches a prefix on the way down", () => {
    expect(core.globMatch("_G/db", "_G/**/Cars", { partial: true })).toBe(true);
  });

  it("matchBase: a slash-free pattern matches the basename only", () => {
    expect(core.globMatch("_G/db/Units", "Uni*", { matchBase: true })).toBe(true);
    expect(core.globMatch("_G/db/Units", "db", { matchBase: true })).toBe(false);
    expect(core.globMatch("", "x", { matchBase: true })).toBe(false); // empty path basename
  });

  it("matchBase is ignored when the pattern has a slash", () => {
    expect(core.globMatch("_G/db/Units", "_G/db/Units", { matchBase: true })).toBe(true);
  });

  it("defaults opts to {} when omitted", () => {
    expect(core.globMatch("_G/db", "_G/db")).toBe(true);
  });
});

describe("escapeLiteral / segMatch", () => {
  it("escapes regex metacharacters so they match literally", () => {
    expect(core.segMatch("a.b", "a.b")).toBe(true);
    expect(core.segMatch("axb", "a.b")).toBe(false);
    expect(core.segMatch("a+b", "a+b")).toBe(true);
  });
});

describe("pathMatchesFilter — three modes", () => {
  it("empty filter matches everything", () => {
    expect(core.pathMatchesFilter("_G/db", "")).toBe(true);
  });

  it("a `/` filter globs over the full path", () => {
    expect(core.pathMatchesFilter("_G/db/Units", "_G/*/Units")).toBe(true);
    expect(core.pathMatchesFilter("_G/db/Weapons", "_G/*/Units")).toBe(false);
  });

  it("a glob filter without `/` globs the basename", () => {
    expect(core.pathMatchesFilter("_G/db/Units", "Uni*")).toBe(true);
    expect(core.pathMatchesFilter("_G/db/Units", "db*")).toBe(false);
  });

  it("a plain filter is a case-insensitive substring over the path", () => {
    expect(core.pathMatchesFilter("_G/db/Units", "UNIT")).toBe(true);
    expect(core.pathMatchesFilter("_G/db/Units", "zzz")).toBe(false);
  });
});

describe("annotateMatches — ancestor visibility propagation", () => {
  function tree() {
    return {
      path: "_G",
      children: [
        { path: "_G/db", children: [{ path: "_G/db/Units", children: [] }] },
        { path: "_G/net", children: [] },
      ],
    };
  }

  it("marks a deep match and every ancestor, hiding unrelated branches", () => {
    const root = tree();
    core.annotateMatches(root, "Units");
    expect(root.matched).toBe(true); // ancestor of the match
    expect(root.children[0].matched).toBe(true); // db, on the path
    expect(root.children[0].children[0].matched).toBe(true); // the match itself
    expect(root.children[1].matched).toBe(false); // net, unrelated
  });

  it("an empty filter marks the whole tree matched", () => {
    const root = tree();
    core.annotateMatches(root, "");
    expect(root.matched).toBe(true);
    expect(root.children[1].matched).toBe(true);
  });

  it("handles nodes with no children array", () => {
    const leaf = { path: "_G/x" };
    expect(core.annotateMatches(leaf, "x")).toBe(true);
    expect(core.annotateMatches(leaf, "y")).toBe(false);
  });
});

describe("canSweep", () => {
  it("only path patterns (with `/`) can sweep", () => {
    expect(core.canSweep("_G/db/*")).toBe(true);
    expect(core.canSweep("Units")).toBe(false);
    expect(core.canSweep("")).toBe(false);
  });
});

describe("sweepMaxDepth", () => {
  it("counts one level per literal segment", () => {
    expect(core.sweepMaxDepth("_G/db/Units", 1)).toBe(3);
    expect(core.sweepMaxDepth("*/db/Units/*", 1)).toBe(4);
  });

  it("`**` costs the wildcard depth", () => {
    expect(core.sweepMaxDepth("**/Units", 1)).toBe(2);
    expect(core.sweepMaxDepth("**/Units", 3)).toBe(4);
    expect(core.sweepMaxDepth("_G/**", 0)).toBe(1);
  });

  it("defaults the wildcard depth to 1 when unspecified", () => {
    expect(core.sweepMaxDepth("**/x")).toBe(2);
  });
});

describe("shouldSweepFetch — budget + prefix gating", () => {
  it("fetches shallow nodes on the path toward a match", () => {
    const p = "_G/db/Units";
    const max = core.sweepMaxDepth(p, 1); // 3
    expect(core.shouldSweepFetch("_G", 0, p, max)).toBe(true);
    expect(core.shouldSweepFetch("_G/db", 1, p, max)).toBe(true);
    expect(core.shouldSweepFetch("_G/db/Units", 2, p, max)).toBe(true);
    expect(core.shouldSweepFetch("_G/net", 1, p, max)).toBe(false); // off the path
  });

  it("stops at the depth budget", () => {
    const p = "_G/db/Units";
    expect(core.shouldSweepFetch("_G/db/Units", 3, p, 3)).toBe(false); // depth == max
  });
});

describe("childPath", () => {
  it("joins with `/`, keeping the root bare", () => {
    expect(core.childPath("_G", "db")).toBe("_G/db");
    expect(core.childPath("", "_G")).toBe("_G");
  });
});

describe("valueToJson / childrenToJson — copy serialization", () => {
  it("coerces scalar previews to JS values", () => {
    expect(core.valueToJson({ type: "number", value: "42" })).toBe(42);
    expect(core.valueToJson({ type: "number", value: "notanum" })).toBe("notanum");
    expect(core.valueToJson({ type: "boolean", value: "true" })).toBe(true);
    expect(core.valueToJson({ type: "boolean", value: "false" })).toBe(false);
    expect(core.valueToJson({ type: "nil", value: "nil" })).toBe(null);
    expect(core.valueToJson({ type: "string", value: '"hi"' })).toBe("hi");
    expect(core.valueToJson({ type: "string", value: "noquotes" })).toBe("noquotes");
  });

  it("keeps an unexpanded table as its preview, nests a loaded one", () => {
    expect(core.valueToJson({ type: "table", value: "table (3)", loaded: false })).toBe("table (3)");
    const loaded = {
      type: "table",
      loaded: true,
      children: [
        { key: "n", type: "number", value: "1" },
        { key: "s", type: "string", value: '"x"' },
      ],
    };
    expect(core.valueToJson(loaded)).toEqual({ n: 1, s: "x" });
  });

  it("uses the resolved signature for a function, else its preview", () => {
    expect(core.valueToJson({ type: "function", value: "function (2 args)", signature: "f(a, b)" })).toBe("f(a, b)");
    expect(core.valueToJson({ type: "function", value: "function (2 args)" })).toBe("function (2 args)");
  });

  it("falls back to the raw value for unknown types (userdata/thread)", () => {
    expect(core.valueToJson({ type: "userdata", value: "userdata" })).toBe("userdata");
  });

  it("childrenToJson maps child keys to their values", () => {
    const node = {
      type: "table",
      loaded: true,
      children: [
        { key: "a", type: "number", value: "1" },
        {
          key: "b",
          type: "table",
          loaded: true,
          children: [{ key: "c", type: "boolean", value: "true" }],
        },
      ],
    };
    expect(core.childrenToJson(node)).toEqual({ a: 1, b: { c: true } });
    expect(core.childrenToJson({})).toEqual({});
  });
});

describe("signatureDisplay", () => {
  it("formats name + params, empty params → `name()`", () => {
    expect(core.signatureDisplay("outText", "text, displayTime, clearView")).toBe(
      "outText(text, displayTime, clearView)",
    );
    expect(core.signatureDisplay("now", "")).toBe("now()");
    expect(core.signatureDisplay("now")).toBe("now()");
  });
});

describe("SWEEP_BUDGET", () => {
  it("is 200 fetches", () => {
    expect(core.SWEEP_BUDGET).toBe(200);
  });
});
