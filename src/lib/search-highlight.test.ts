import { describe, it, expect } from "vitest";

import { highlightSplit } from "./search-highlight";

describe("highlightSplit (search result highlight, issue #68)", () => {
  it("splits around a match in the middle of the line", () => {
    expect(highlightSplit("local gauge = 1", 7, 5)).toEqual({
      before: "local ",
      match: "gauge",
      after: " = 1",
    });
  });

  it("handles a match at the start of the line", () => {
    expect(highlightSplit("gauge end", 1, 5)).toEqual({
      before: "",
      match: "gauge",
      after: " end",
    });
  });

  it("handles a match running to the end of the line", () => {
    expect(highlightSplit("a gauge", 3, 5)).toEqual({
      before: "a ",
      match: "gauge",
      after: "",
    });
  });

  it("indexes by UTF-16 code units, so it lands past surrogate pairs", () => {
    // "💡" is two UTF-16 code units, so "foo" starts at 1-based column 3.
    expect(highlightSplit("💡foo", 3, 3)).toEqual({
      before: "💡",
      match: "foo",
      after: "",
    });
  });

  it("renders the line unhighlighted for a zero-length match", () => {
    expect(highlightSplit("text", 2, 0)).toEqual({
      before: "text",
      match: "",
      after: "",
    });
  });

  it("renders the line unhighlighted when the column is past a clipped preview", () => {
    // The backend clips long-line previews but keeps the true column; a match
    // beyond the preview must not throw — it just renders unhighlighted.
    expect(highlightSplit("short", 99, 4)).toEqual({
      before: "short",
      match: "",
      after: "",
    });
  });

  it("clamps a match length that overruns the preview", () => {
    expect(highlightSplit("abcd", 3, 99)).toEqual({
      before: "ab",
      match: "cd",
      after: "",
    });
  });
});
