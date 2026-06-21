import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import {
  snippetOf,
  normalizeBookmarkLines,
  remapBookmarkLines,
  toggleBookmark,
  removeBookmark,
  syncFileBookmarks,
  linesForPath,
  parsePersisted,
  type Bookmark,
} from "./bookmark-util";

/** Apply one change to `docText` and re-map `marks` through the real
 *  CodeMirror transaction — exercises remapBookmarkLines against the same
 *  ChangeSet/Text the editor produces, headless (no EditorView, no DOM). */
function remap(
  docText: string,
  marks: number[],
  change: { from: number; to?: number; insert?: string },
) {
  const tr = EditorState.create({ doc: docText }).update({ changes: change });
  const lines = remapBookmarkLines(
    marks,
    tr.changes,
    tr.startState.doc,
    tr.state.doc,
  );
  return { lines, lineText: (n: number) => tr.state.doc.line(n).text };
}

const DOC = "one\ntwo\nthree\nfour";

describe("remapBookmarkLines (edit-tolerant anchoring)", () => {
  it("rides down when lines are inserted above, keeping its code", () => {
    // mark L3 ("three"), insert two lines at the top, save → rides to L5.
    const r = remap(DOC, [3], { from: 0, insert: "a\nb\n" });
    expect(r.lines).toEqual([5]);
    expect(r.lineText(5)).toBe("three"); // snippet re-derives to the same code
  });

  it("is unchanged when an edit lands below the mark", () => {
    // mark L2, append a line after the last → L2 untouched.
    const r = remap(DOC, [2], { from: DOC.length, insert: "\nfive" });
    expect(r.lines).toEqual([2]);
    expect(r.lineText(2)).toBe("two");
  });

  it("shifts up when a line above is deleted", () => {
    // mark L3, delete L1 ("one\n") → rides to L2.
    const r = remap(DOC, [3], { from: 0, to: 4 });
    expect(r.lines).toEqual([2]);
    expect(r.lineText(2)).toBe("three");
  });

  it("rides to the following code when the marked line itself is deleted", () => {
    // mark L2 ("two"), delete L2 → mark lands on the code that followed it.
    const r = remap(DOC, [2], { from: 4, to: 8 });
    expect(r.lines).toEqual([2]);
    expect(r.lineText(2)).toBe("three");
  });

  it("clamps to the new last line when the marked last line is deleted", () => {
    // mark L4 ("four", last), delete "\nfour" → clamps to the new last line.
    const r = remap(DOC, [4], { from: 13, to: DOC.length });
    expect(r.lines).toEqual([3]);
    expect(r.lineText(3)).toBe("three");
  });

  it("shifts two marks together through one insert", () => {
    // mark L2 + L3, insert one line at the top → both ride down by one,
    // each still over its own code.
    const r = remap(DOC, [2, 3], { from: 0, insert: "x\n" });
    expect(r.lines).toEqual([3, 4]);
    expect(r.lineText(3)).toBe("two");
    expect(r.lineText(4)).toBe("three");
  });

  it("rides to its code when a newline is inserted at the marked line's start", () => {
    // mark L2 ("two"), press Enter at column 0 of "two" → the mark binds to the
    // code that FOLLOWS (mapPos assoc +1), riding to L3; assoc -1 would strand
    // it on the freshly-inserted blank line.
    const r = remap(DOC, [2], { from: 4, insert: "\n" });
    expect(r.lines).toEqual([3]);
    expect(r.lineText(3)).toBe("two");
  });

  it("dedupes when two adjacent marks collapse onto the same line", () => {
    // mark L2 + L3, delete "two\nthree\n" → both ride to the following code
    // ("four") and the re-map normalizes the [2, 2] collapse to a single entry,
    // so the panel paints one row, not a duplicate.
    const r = remap(DOC, [2, 3], { from: 4, to: 14 });
    expect(r.lines).toEqual([2]);
    expect(r.lineText(2)).toBe("four");
  });

  it("leaves marks untouched on a change-free transaction", () => {
    // an annotation-only transaction (docChanged false) must not move marks.
    const tr = EditorState.create({ doc: DOC }).update({});
    expect(
      remapBookmarkLines([3], tr.changes, tr.startState.doc, tr.state.doc),
    ).toEqual([3]);
  });
});

describe("normalizeBookmarkLines (field invariant)", () => {
  it("drops out-of-range lines, dedupes, and sorts", () => {
    expect(normalizeBookmarkLines([3, 1, 3, 5, 0, -2], 3)).toEqual([1, 3]);
  });

  it("returns empty for no marks", () => {
    expect(normalizeBookmarkLines([], 5)).toEqual([]);
  });
});

describe("toggleBookmark (add/remove idempotence)", () => {
  it("adds a mark to an empty set", () => {
    expect(toggleBookmark([], "a.lua", 3, "snip")).toEqual([
      { path: "a.lua", line: 3, snippet: "snip" },
    ]);
  });

  it("removes the mark when toggled again — toggle twice nets to nothing", () => {
    const once = toggleBookmark([], "a.lua", 3, "snip");
    expect(toggleBookmark(once, "a.lua", 3, "snip")).toEqual([]);
  });

  it("matches by path+line on removal, ignoring the snippet", () => {
    const existing: Bookmark[] = [{ path: "a.lua", line: 3, snippet: "old" }];
    expect(toggleBookmark(existing, "a.lua", 3, "new")).toEqual([]);
  });

  it("keeps the set in path-then-line order on add", () => {
    const e = toggleBookmark(
      toggleBookmark([], "b.lua", 1, "b1"),
      "a.lua",
      9,
      "a9",
    );
    expect(e.map((b) => b.path)).toEqual(["a.lua", "b.lua"]);
  });
});

describe("removeBookmark", () => {
  it("drops the matching mark", () => {
    const e: Bookmark[] = [
      { path: "a.lua", line: 2, snippet: "x" },
      { path: "a.lua", line: 5, snippet: "y" },
    ];
    expect(removeBookmark(e, "a.lua", 2)).toEqual([
      { path: "a.lua", line: 5, snippet: "y" },
    ]);
  });

  it("is a no-op when the mark is absent", () => {
    const e: Bookmark[] = [{ path: "a.lua", line: 2, snippet: "x" }];
    expect(removeBookmark(e, "a.lua", 99)).toEqual(e);
  });
});

describe("syncFileBookmarks (save splice — isolation)", () => {
  const entries: Bookmark[] = [
    { path: "a.lua", line: 2, snippet: "a2" },
    { path: "a.lua", line: 5, snippet: "a5" },
    { path: "b.lua", line: 3, snippet: "b3" },
  ];

  it("replaces only the saved file's marks, leaving other files untouched", () => {
    const out = syncFileBookmarks(entries, "a.lua", [{ line: 9, snippet: "a9" }]);
    expect(out).toEqual([
      { path: "a.lua", line: 9, snippet: "a9" },
      { path: "b.lua", line: 3, snippet: "b3" },
    ]);
  });

  it("clears just that file when re-anchored to no marks", () => {
    expect(syncFileBookmarks(entries, "a.lua", [])).toEqual([
      { path: "b.lua", line: 3, snippet: "b3" },
    ]);
  });

  it("adds a not-yet-tracked file's marks alongside the rest", () => {
    const out = syncFileBookmarks(entries, "c.lua", [{ line: 1, snippet: "c1" }]);
    expect(out).toContainEqual({ path: "c.lua", line: 1, snippet: "c1" });
    expect(out).toHaveLength(4);
  });
});

describe("linesForPath", () => {
  const entries: Bookmark[] = [
    { path: "a.lua", line: 2, snippet: "x" },
    { path: "a.lua", line: 5, snippet: "y" },
    { path: "b.lua", line: 3, snippet: "z" },
  ];

  it("returns only the given file's lines", () => {
    expect(linesForPath(entries, "a.lua")).toEqual([2, 5]);
  });

  it("returns empty for a file with no marks", () => {
    expect(linesForPath(entries, "z.lua")).toEqual([]);
  });
});

describe("parsePersisted (restore — never fails the panel)", () => {
  it("restores nothing for an absent bucket", () => {
    expect(parsePersisted(null)).toEqual([]);
    expect(parsePersisted("")).toEqual([]);
  });

  it("restores nothing for a corrupt or non-array bucket", () => {
    expect(parsePersisted("{not json")).toEqual([]);
    expect(parsePersisted('{"path":"a.lua","line":1,"snippet":"s"}')).toEqual([]);
  });

  it("parses a valid bucket into path-then-line order", () => {
    const raw = JSON.stringify([
      { path: "b.lua", line: 4, snippet: "b4" },
      { path: "a.lua", line: 2, snippet: "a2" },
    ]);
    expect(parsePersisted(raw)).toEqual([
      { path: "a.lua", line: 2, snippet: "a2" },
      { path: "b.lua", line: 4, snippet: "b4" },
    ]);
  });

  it("drops entries whose line is not a positive integer (no phantom row)", () => {
    // The regression guard: a corrupt line ≤ 0 (or fractional) clears the type
    // filter and the panel would paint a row at it — rejected at parse.
    const raw = JSON.stringify([
      { path: "a.lua", line: 0, snippet: "zero" },
      { path: "a.lua", line: -3, snippet: "neg" },
      { path: "a.lua", line: 2.5, snippet: "frac" },
      { path: "a.lua", line: 2, snippet: "ok" },
    ]);
    expect(parsePersisted(raw)).toEqual([
      { path: "a.lua", line: 2, snippet: "ok" },
    ]);
  });

  it("drops entries with a missing or mistyped field", () => {
    const raw = JSON.stringify([
      { path: "a.lua", line: 1, snippet: "ok" },
      { line: 2, snippet: "no-path" },
      { path: "b.lua", snippet: "no-line" },
      { path: "c.lua", line: "3", snippet: "string-line" },
      { path: "d.lua", line: 4, snippet: 5 },
      "nope",
      null,
      7,
    ]);
    expect(parsePersisted(raw)).toEqual([
      { path: "a.lua", line: 1, snippet: "ok" },
    ]);
  });
});

describe("snippetOf (trim + cap)", () => {
  it("trims surrounding whitespace", () => {
    expect(snippetOf("  hi  ")).toBe("hi");
    expect(snippetOf("   ")).toBe("");
  });

  it("leaves a snippet at or under the 200-char cap intact", () => {
    const at = "x".repeat(200);
    expect(snippetOf(at)).toBe(at);
    expect(snippetOf("x".repeat(199))).toHaveLength(199);
  });

  it("caps an over-long snippet at 200 chars, trimming first", () => {
    expect(snippetOf("x".repeat(250))).toHaveLength(200);
    expect(snippetOf(`  ${"x".repeat(250)}  `)).toHaveLength(200);
  });
});
