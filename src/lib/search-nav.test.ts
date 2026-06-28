import { describe, it, expect } from "vitest";

import { moveSelection } from "./search-nav";

describe("moveSelection (search overlay Up/Down, issue #68)", () => {
  it("has nothing to select in an empty list", () => {
    expect(moveSelection(-1, 0, 1)).toBe(-1);
    expect(moveSelection(0, 0, -1)).toBe(-1);
  });

  it("steps onto a sensible end from the no-selection state", () => {
    expect(moveSelection(-1, 5, 1)).toBe(0); // first Down → first row
    expect(moveSelection(-1, 5, -1)).toBe(4); // first Up → last row
  });

  it("moves within range", () => {
    expect(moveSelection(0, 5, 1)).toBe(1);
    expect(moveSelection(3, 5, -1)).toBe(2);
  });

  it("wraps at both ends", () => {
    expect(moveSelection(4, 5, 1)).toBe(0); // Down off the bottom → top
    expect(moveSelection(0, 5, -1)).toBe(4); // Up off the top → bottom
  });

  it("stays put on a single-item list", () => {
    expect(moveSelection(0, 1, 1)).toBe(0);
    expect(moveSelection(0, 1, -1)).toBe(0);
  });
});
