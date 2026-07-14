import { describe, it, expect } from "vitest";
import {
  parseDcsLogLine,
  isLogLevel,
  LineDecoder,
  modIdentity,
  matchesMod,
  LogBuffer,
} from "../../src/core/domain/dcsLog";

describe("parseDcsLogLine", () => {
  it("parses the common shape with a thread", () => {
    const r = parseDcsLogLine("2026-07-13 12:00:00.001 INFO    my-mod (Main): hello");
    expect(r).toEqual({
      kind: "entry",
      time: "2026-07-13 12:00:00.001",
      level: "INFO",
      subsystem: "my-mod",
      thread: "Main",
      message: "hello",
    });
  });

  it.each(["INFO", "WARNING", "ERROR", "DEBUG", "ALERT"] as const)("parses level %s", (level) => {
    const r = parseDcsLogLine(`2026-07-13 12:00:00.001 ${level} SCRIPTING (Main): [My Mod] hi`);
    expect(r.kind).toBe("entry");
    expect((r as any).level).toBe(level);
  });

  it("parses the thread-less fallback shape", () => {
    const r = parseDcsLogLine("2026-07-13 12:00:00.001 ERROR my-mod: boom");
    expect(r).toEqual({
      kind: "entry",
      time: "2026-07-13 12:00:00.001",
      level: "ERROR",
      subsystem: "my-mod",
      thread: null,
      message: "boom",
    });
  });

  it("treats a preamble line as a continuation", () => {
    const r = parseDcsLogLine("=== Log opened UTC 20260713_120000 ===");
    expect(r).toEqual({ kind: "continuation", text: "=== Log opened UTC 20260713_120000 ===" });
  });

  it("treats an indented stack-trace line as a continuation", () => {
    const r = parseDcsLogLine("    at some.lua:42: bad thing happened");
    expect(r.kind).toBe("continuation");
  });

  it("treats an empty line as a continuation", () => {
    expect(parseDcsLogLine("")).toEqual({ kind: "continuation", text: "" });
  });

  it("treats an unrecognised level word as a continuation (message text, not a real entry)", () => {
    const r = parseDcsLogLine("2026-07-13 12:00:00.001 TRACE my-mod (Main): hi");
    expect(r.kind).toBe("continuation");
  });
});

describe("isLogLevel", () => {
  it("recognises the five dcs.log levels", () => {
    for (const l of ["INFO", "WARNING", "ERROR", "DEBUG", "ALERT"]) expect(isLogLevel(l)).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isLogLevel("TRACE")).toBe(false);
    expect(isLogLevel("")).toBe(false);
  });
});

describe("LineDecoder", () => {
  it("splits a chunk containing several complete lines", () => {
    const d = new LineDecoder();
    expect(d.push("a\nb\nc\n")).toEqual(["a", "b", "c"]);
  });

  it("buffers a partial line across chunks", () => {
    const d = new LineDecoder();
    expect(d.push("hel")).toEqual([]);
    expect(d.push("lo\nworld")).toEqual(["hello"]);
    expect(d.flush()).toBe("world");
  });

  it("strips a trailing \\r (CRLF line endings)", () => {
    const d = new LineDecoder();
    expect(d.push("a\r\nb\r\n")).toEqual(["a", "b"]);
  });

  it("flush returns null when there is no pending partial line", () => {
    const d = new LineDecoder();
    expect(d.flush()).toBeNull();
    d.push("a\n");
    expect(d.flush()).toBeNull();
  });

  it("flush clears the buffer so it isn't re-emitted", () => {
    const d = new LineDecoder();
    d.push("partial");
    expect(d.flush()).toBe("partial");
    expect(d.flush()).toBeNull();
  });
});

describe("modIdentity", () => {
  it("derives slug + name from a project name", () => {
    expect(modIdentity("My Cool Mod")).toEqual({ slug: "my-cool-mod", name: "My Cool Mod" });
  });

  it("returns null for missing/blank/whitespace-only names", () => {
    expect(modIdentity(undefined)).toBeNull();
    expect(modIdentity(null)).toBeNull();
    expect(modIdentity("")).toBeNull();
    expect(modIdentity("   ")).toBeNull();
  });

  it("trims the name before storing it", () => {
    expect(modIdentity("  My Mod  ")).toEqual({ slug: "my-mod", name: "My Mod" });
  });
});

describe("matchesMod", () => {
  const mod = modIdentity("My Mod")!;

  it("returns false when there is no mod identity", () => {
    expect(matchesMod({ subsystem: "my-mod", message: "hi" }, null)).toBe(false);
  });

  it("matches by subsystem == slug, case-insensitively", () => {
    expect(matchesMod({ subsystem: "my-mod", message: "hi" }, mod)).toBe(true);
    expect(matchesMod({ subsystem: "MY-MOD", message: "hi" }, mod)).toBe(true);
  });

  it("matches by [name] tag in the message (SCRIPTING subsystem)", () => {
    expect(matchesMod({ subsystem: "SCRIPTING", message: "[My Mod] loaded" }, mod)).toBe(true);
  });

  it("does not match an unrelated subsystem/message", () => {
    expect(matchesMod({ subsystem: "other-mod", message: "hi" }, mod)).toBe(false);
    expect(matchesMod({ subsystem: "SCRIPTING", message: "[Other Mod] loaded" }, mod)).toBe(false);
    expect(matchesMod({ subsystem: null, message: "no tag here" }, mod)).toBe(false);
  });
});

describe("LogBuffer", () => {
  it("assigns a monotonically increasing seq to each new entry", () => {
    const buf = new LogBuffer();
    const a = buf.push("2026-07-13 12:00:00.001 INFO my-mod (Main): one", null);
    const b = buf.push("2026-07-13 12:00:00.002 INFO my-mod (Main): two", null);
    expect(a.entry.seq).toBe(1);
    expect(b.entry.seq).toBe(2);
    expect(a.kind).toBe("added");
    expect(b.kind).toBe("added");
  });

  it("stamps mine using the given mod identity", () => {
    const buf = new LogBuffer();
    const mod = modIdentity("my-mod")!;
    const mine = buf.push("2026-07-13 12:00:00.001 INFO my-mod (Main): hi", mod);
    const notMine = buf.push("2026-07-13 12:00:00.001 INFO other (Main): hi", mod);
    expect(mine.entry.mine).toBe(true);
    expect(notMine.entry.mine).toBe(false);
  });

  it("attaches a continuation line to the most recent entry's cont[]", () => {
    const buf = new LogBuffer();
    buf.push("2026-07-13 12:00:00.001 ERROR my-mod (Main): boom", null);
    const ev = buf.push("    stack trace line 1", null);
    expect(ev.kind).toBe("continued");
    expect(ev.entry.cont).toEqual(["    stack trace line 1"]);
    const ev2 = buf.push("    stack trace line 2", null);
    expect(ev2.entry.cont).toEqual(["    stack trace line 1", "    stack trace line 2"]);
    expect(buf.size).toBe(1);
  });

  it("promotes a continuation line to a standalone entry when the buffer is empty", () => {
    const buf = new LogBuffer();
    const ev = buf.push("=== Log opened UTC ===", null);
    expect(ev.kind).toBe("added");
    expect(ev.entry.level).toBeNull();
    expect(ev.entry.message).toBe("=== Log opened UTC ===");
    expect(buf.size).toBe(1);
  });

  it("evicts the oldest entry and reports drops once the cap is exceeded", () => {
    const buf = new LogBuffer(2);
    buf.push("2026-07-13 12:00:00.001 INFO my-mod (Main): one", null);
    buf.push("2026-07-13 12:00:00.002 INFO my-mod (Main): two", null);
    expect(buf.droppedCount).toBe(0);
    buf.push("2026-07-13 12:00:00.003 INFO my-mod (Main): three", null);
    expect(buf.size).toBe(2);
    expect(buf.droppedCount).toBe(1);
    expect(buf.list().map((e) => e.message)).toEqual(["two", "three"]);
  });

  it("clear() empties entries and resets the dropped counter", () => {
    const buf = new LogBuffer(1);
    buf.push("2026-07-13 12:00:00.001 INFO my-mod (Main): one", null);
    buf.push("2026-07-13 12:00:00.002 INFO my-mod (Main): two", null);
    expect(buf.droppedCount).toBe(1);
    buf.clear();
    expect(buf.size).toBe(0);
    expect(buf.droppedCount).toBe(0);
    expect(buf.list()).toEqual([]);
  });

  it("keeps seq monotonic across a clear() (never reused)", () => {
    const buf = new LogBuffer();
    buf.push("2026-07-13 12:00:00.001 INFO my-mod (Main): one", null);
    buf.clear();
    const ev = buf.push("2026-07-13 12:00:00.002 INFO my-mod (Main): two", null);
    expect(ev.entry.seq).toBe(2);
  });
});
