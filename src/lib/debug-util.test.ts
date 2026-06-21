import { describe, it, expect } from "vitest";
import { sourceId, pathOf, baseName, luaStr, sessionAction } from "./debug-util";

describe("sessionAction (the session-end machine)", () => {
  it("pauses when paused, regardless of the rest", () => {
    expect(sessionAction(true, false, false)).toBe("pause");
    expect(sessionAction(true, true, true)).toBe("pause");
  });

  it("runs when running and not paused", () => {
    expect(sessionAction(false, true, false)).toBe("run");
    expect(sessionAction(false, true, true)).toBe("run");
  });

  it("finishes when neither paused nor running — but only after activity", () => {
    expect(sessionAction(false, false, true)).toBe("finish");
  });

  it("waits (does NOT finish) before the run has started", () => {
    // The guard: a transient not-running poll right after start() must not end
    // the session before debug_run reaches the sim and sets running=true.
    expect(sessionAction(false, false, false)).toBe("wait");
  });
});

describe("luaStr (injection-safe Lua string literal)", () => {
  it("quotes plain strings", () => {
    expect(luaStr("hi")).toBe('"hi"');
  });

  it("escapes quotes, backslashes, and newlines", () => {
    expect(luaStr('a"b')).toBe('"a\\"b"');
    expect(luaStr("a\\b")).toBe('"a\\\\b"');
    expect(luaStr("a\nb")).toBe('"a\\nb"');
    expect(luaStr("a\rb")).toBe('"a\\rb"');
  });

  it("contains a string trying to break out and inject code", () => {
    // Without escaping this would close the literal and run os.exit().
    expect(luaStr('x") os.exit(("')).toBe('"x\\") os.exit((\\""');
  });
});

describe("path helpers", () => {
  it("sourceId / pathOf round-trip", () => {
    expect(sourceId("C:\\a\\b.lua")).toBe("=C:\\a\\b.lua");
    expect(pathOf(sourceId("C:\\a\\b.lua"))).toBe("C:\\a\\b.lua");
    expect(pathOf("plain")).toBe("plain"); // no '=' prefix passes through
  });

  it("baseName takes the last segment of either separator", () => {
    expect(baseName("C:\\a\\b.lua")).toBe("b.lua");
    expect(baseName("/x/y/z.lua")).toBe("z.lua");
    expect(baseName("solo.lua")).toBe("solo.lua");
  });
});
