import { describe, it, expect } from "vitest";
import {
  allTabPaths,
  otherTabPaths,
  rightwardTabPaths,
  cleanTabPaths,
  type ClosableTab,
} from "./tab-close";

// A clean tab's buffer matches its baseline; a dirty tab's diverges.
const clean = (path: string): ClosableTab => ({ path, docText: "x", savedText: "x" });
const dirty = (path: string): ClosableTab => ({ path, docText: "edited", savedText: "x" });

describe("allTabPaths", () => {
  it("returns every tab's path in tab-strip order", () => {
    expect(allTabPaths([clean("a"), dirty("b"), clean("c")])).toEqual(["a", "b", "c"]);
  });

  it("is empty for no open tabs", () => {
    expect(allTabPaths([])).toEqual([]);
  });
});

describe("otherTabPaths", () => {
  it("returns every tab but the target, in tab-strip order", () => {
    const tabs = [clean("a"), clean("b"), clean("c")];
    expect(otherTabPaths(tabs, "b")).toEqual(["a", "c"]);
  });

  it("is empty when the target is the only open tab", () => {
    expect(otherTabPaths([clean("a")], "a")).toEqual([]);
  });

  it("returns all tabs when the target is not open", () => {
    expect(otherTabPaths([clean("a"), clean("b")], "z")).toEqual(["a", "b"]);
  });
});

describe("rightwardTabPaths", () => {
  it("returns only the tabs after the target, in order", () => {
    const tabs = [clean("a"), clean("b"), clean("c"), clean("d")];
    expect(rightwardTabPaths(tabs, "b")).toEqual(["c", "d"]);
  });

  it("returns every later tab from the first position", () => {
    const tabs = [clean("a"), clean("b"), clean("c")];
    expect(rightwardTabPaths(tabs, "a")).toEqual(["b", "c"]);
  });

  it("is empty for the last tab", () => {
    expect(rightwardTabPaths([clean("a"), clean("b")], "b")).toEqual([]);
  });

  it("is empty when the target is not open", () => {
    expect(rightwardTabPaths([clean("a")], "z")).toEqual([]);
  });
});

describe("cleanTabPaths", () => {
  it("returns only clean tabs, skipping dirty ones", () => {
    const tabs = [clean("a"), dirty("b"), clean("c")];
    expect(cleanTabPaths(tabs)).toEqual(["a", "c"]);
  });

  it("is empty when every open tab is dirty", () => {
    expect(cleanTabPaths([dirty("a"), dirty("b")])).toEqual([]);
  });

  it("returns all tabs when none are dirty", () => {
    expect(cleanTabPaths([clean("a"), clean("b")])).toEqual(["a", "b"]);
  });

  it("treats a still-loading tab (blank buffer and baseline) as clean", () => {
    const loading: ClosableTab = { path: "x", docText: "", savedText: "" };
    expect(cleanTabPaths([loading])).toEqual(["x"]);
  });
});
