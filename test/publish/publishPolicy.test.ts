import { describe, expect, it } from "vitest";
import {
  GITIGNORE_ENTRY,
  gitignoreNeedsEntry,
  gitignoreWithEntry,
} from "../../src/core/domain/publishPolicy";

describe("gitignoreNeedsEntry", () => {
  it("is true for empty or missing content", () => {
    expect(gitignoreNeedsEntry("")).toBe(true);
  });

  it("is false when the entry is present on its own line", () => {
    expect(gitignoreNeedsEntry("node_modules/\n.dcs-studio/\n")).toBe(false);
  });

  it("tolerates surrounding whitespace and CRLF line endings", () => {
    expect(gitignoreNeedsEntry("node_modules/\r\n  .dcs-studio/  \r\n")).toBe(false);
  });

  it("is true when only a similar (not exact) entry exists", () => {
    expect(gitignoreNeedsEntry(".dcs-studio\n")).toBe(true);
    expect(gitignoreNeedsEntry("foo/.dcs-studio/\n")).toBe(true);
  });
});

describe("gitignoreWithEntry", () => {
  it("creates the entry line for empty content", () => {
    expect(gitignoreWithEntry("")).toBe(`${GITIGNORE_ENTRY}\n`);
  });

  it("appends after a missing trailing newline", () => {
    expect(gitignoreWithEntry("node_modules/")).toBe(`node_modules/\n${GITIGNORE_ENTRY}\n`);
  });

  it("appends directly after an existing trailing newline", () => {
    expect(gitignoreWithEntry("node_modules/\n")).toBe(`node_modules/\n${GITIGNORE_ENTRY}\n`);
  });
});
