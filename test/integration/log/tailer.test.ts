import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { LogTailer, type LogTailerOptions } from "../../../src/log/tailer";

// Short poll interval + real timers: the tailer is a thin fs-polling loop,
// so exercising it end-to-end against a real temp file is more honest than
// mocking fs. `waitFor` polls a predicate instead of racing a fixed sleep.

let tmpDir: string;
const tailers: LogTailer[] = [];

afterEach(() => {
  for (const t of tailers.splice(0)) t.stop();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeTailer(opts: LogTailerOptions): LogTailer {
  const t = new LogTailer(opts);
  tailers.push(t);
  return t;
}

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function tmpFile(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dcslog-"));
  return path.join(tmpDir, "dcs.log");
}

describe("LogTailer", () => {
  it("backfills existing content on start", async () => {
    const file = tmpFile();
    fs.writeFileSync(file, "line one\nline two\n");
    const lines: string[] = [];
    const tailer = makeTailer({
      filePath: file,
      pollMs: 20,
      onLines: (l: string[]) => lines.push(...l),
      onState: () => {},
      onReset: () => {},
    });
    tailer.start();
    await waitFor(() => lines.length >= 2);
    expect(lines).toEqual(["line one", "line two"]);
  });

  it("detects appended growth", async () => {
    const file = tmpFile();
    fs.writeFileSync(file, "first\n");
    const lines: string[] = [];
    const tailer = makeTailer({
      filePath: file,
      pollMs: 20,
      onLines: (l: string[]) => lines.push(...l),
      onState: () => {},
      onReset: () => {},
    });
    tailer.start();
    await waitFor(() => lines.length >= 1);
    fs.appendFileSync(file, "second\nthird\n");
    await waitFor(() => lines.length >= 3);
    expect(lines).toEqual(["first", "second", "third"]);
  });

  it("detects truncation, calls onReset, then re-backfills the new content", async () => {
    const file = tmpFile();
    fs.writeFileSync(file, "before-restart\n");
    const lines: string[] = [];
    let resets = 0;
    const tailer = makeTailer({
      filePath: file,
      pollMs: 20,
      onLines: (l: string[]) => lines.push(...l),
      onState: () => {},
      onReset: () => resets++,
    });
    tailer.start();
    await waitFor(() => lines.length >= 1);
    // DCS truncates the file on restart rather than deleting it.
    fs.writeFileSync(file, "after-restart\n");
    await waitFor(() => resets === 1);
    await waitFor(() => lines.includes("after-restart"));
    expect(lines).toEqual(["before-restart", "after-restart"]);
  });

  it("reports a missing file, then transitions to ok once it appears (with backfill)", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dcslog-"));
    const file = path.join(tmpDir, "dcs.log");
    const states: string[] = [];
    const lines: string[] = [];
    const tailer = makeTailer({
      filePath: file,
      pollMs: 20,
      onLines: (l: string[]) => lines.push(...l),
      onState: (s: string) => states.push(s),
      onReset: () => {},
    });
    tailer.start();
    await waitFor(() => states.includes("missing"));
    fs.writeFileSync(file, "now it exists\n");
    await waitFor(() => states.includes("ok"));
    await waitFor(() => lines.length >= 1);
    expect(states).toEqual(["missing", "ok"]);
    expect(lines).toEqual(["now it exists"]);
  });

  it("only fires onState on a missing<->ok transition, not every tick", async () => {
    const file = tmpFile();
    fs.writeFileSync(file, "steady\n");
    const states: string[] = [];
    const tailer = makeTailer({
      filePath: file,
      pollMs: 15,
      onLines: () => {},
      onState: (s: string) => states.push(s),
      onReset: () => {},
    });
    tailer.start();
    await new Promise((r) => setTimeout(r, 150)); // several ticks with no state change
    expect(states).toEqual(["ok"]);
  });

  it("caps bytes read per tick so growth is drained gradually, not all at once", async () => {
    const file = tmpFile();
    fs.writeFileSync(file, "");
    const lines: string[] = [];
    const tailer = makeTailer({
      filePath: file,
      pollMs: 15,
      sliceBytes: 40, // small cap: forces several ticks to drain the appended batch
      onLines: (l: string[]) => lines.push(...l),
      onState: () => {},
      onReset: () => {},
    });
    tailer.start();
    await waitFor(() => true); // let the initial (empty) backfill tick happen
    const batch = `${Array.from({ length: 20 }, (_, i) => `line-${i}`).join("\n")}\n`; // ~180 bytes
    fs.appendFileSync(file, batch);
    // Immediately after the first tick to observe growth, not everything can
    // be in yet — the read is capped at sliceBytes per tick.
    await waitFor(() => lines.length > 0);
    const afterFirstTick = lines.length;
    expect(afterFirstTick).toBeLessThan(20);
    await waitFor(() => lines.length >= 20, 5000);
    expect(lines).toEqual(Array.from({ length: 20 }, (_, i) => `line-${i}`));
  });

  it("backfill only reads the tail (bounded by backfillBytes) of a large existing file, dropping the split first line", async () => {
    const file = tmpFile();
    // 50 short fixed-width lines so we can compute exactly how many survive a small backfill window.
    const allLines = Array.from({ length: 50 }, (_, i) => `L${String(i).padStart(3, "0")}`); // 4 bytes each + \n = 5
    fs.writeFileSync(file, `${allLines.join("\n")}\n`);
    const lines: string[] = [];
    const tailer = makeTailer({
      filePath: file,
      pollMs: 20,
      backfillBytes: 22, // ~4 lines' worth; the first is a fragment and gets dropped
      onLines: (l: string[]) => lines.push(...l),
      onState: () => {},
      onReset: () => {},
    });
    tailer.start();
    await waitFor(() => lines.length > 0);
    await new Promise((r) => setTimeout(r, 100));
    // Only the last few lines came through, and none of the earliest ones.
    expect(lines.length).toBeLessThan(allLines.length);
    expect(lines[lines.length - 1]).toBe("L049");
    expect(lines).not.toContain("L000");
  });

  it("stop() halts polling — no further callbacks after stop", async () => {
    const file = tmpFile();
    fs.writeFileSync(file, "one\n");
    const lines: string[] = [];
    const tailer = new LogTailer({
      filePath: file,
      pollMs: 15,
      onLines: (l: string[]) => lines.push(...l),
      onState: () => {},
      onReset: () => {},
    });
    tailer.start();
    await waitFor(() => lines.length >= 1);
    tailer.stop();
    const countAtStop = lines.length;
    fs.appendFileSync(file, "two\n");
    await new Promise((r) => setTimeout(r, 100));
    expect(lines.length).toBe(countAtStop);
  });

  it("reports a path that stats but cannot be read as missing, and recovers when it becomes a real file", async () => {
    // Everything after the stat is a separate set of syscalls that can fail on
    // their own: dcs.log deleted between the stat and the open, a savedGamesPath
    // pointing at something that is not a file, a network share dropping. A
    // directory reproduces that class deterministically. The loop has to survive
    // it — an escaping rejection would land as an unhandled error in the
    // extension host, invisible to the user and fatal to the tail.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dcslog-"));
    const file = path.join(tmpDir, "dcs.log");
    fs.mkdirSync(file);
    const states: string[] = [];
    const lines: string[] = [];
    const tailer = makeTailer({
      filePath: file,
      pollMs: 20,
      onLines: (l: string[]) => lines.push(...l),
      onState: (s: string) => states.push(s),
      onReset: () => {},
    });
    tailer.start();
    await waitFor(() => states.includes("missing"));
    fs.rmdirSync(file);
    fs.writeFileSync(file, "readable at last\n");
    await waitFor(() => lines.length >= 1);
    expect(lines).toEqual(["readable at last"]);
    // Back to "ok" as well, so the viewer's banner clears itself rather than
    // leaving the log looking permanently gone.
    expect(states[states.length - 1]).toBe("ok");
  });

  it("stop() is safe before start and on a second call", async () => {
    // The log panel calls stop() from its dispose path unconditionally, so a
    // panel closed before the tailer ever started — or disposed twice — must
    // not throw on a timer that is not there.
    const file = tmpFile();
    fs.writeFileSync(file, "one\n");
    const tailer = makeTailer({
      filePath: file,
      pollMs: 15,
      onLines: () => {},
      onState: () => {},
      onReset: () => {},
    });
    expect(() => tailer.stop()).not.toThrow();
    tailer.start();
    tailer.stop();
    expect(() => tailer.stop()).not.toThrow();
  });

  it("with backfillBytes 0 reads nothing on open and reports only what is appended after", async () => {
    const file = tmpFile();
    fs.writeFileSync(file, "history nobody asked for\n");
    const lines: string[] = [];
    const tailer = makeTailer({
      filePath: file,
      pollMs: 20,
      backfillBytes: 0, // "start from now": open at EOF, replay none of the file
      onLines: (l: string[]) => lines.push(...l),
      onState: () => {},
      onReset: () => {},
    });
    tailer.start();
    // Nothing to read means the open/read of a zero-length slice is skipped
    // entirely — a viewer opened mid-session shows an empty log, not the tail.
    await new Promise((r) => setTimeout(r, 100));
    expect(lines).toEqual([]);
    fs.appendFileSync(file, "live line\n");
    await waitFor(() => lines.length >= 1);
    expect(lines).toEqual(["live line"]);
  });

  it("never re-enters a tick that is still reading, so a slow drain cannot duplicate lines", async () => {
    // dcs.log grows in megabyte bursts during a mission load, and each tick's
    // read is real async I/O. With the poll interval far shorter than a read,
    // the next tick fires while the previous one is still in flight — without
    // the reentrancy guard it would stat, see `backfilled` or `offset` from
    // before the in-flight read landed, and replay the same bytes twice.
    const file = tmpFile();
    const count = 60_000;
    const all = Array.from(
      { length: count },
      (_, i) => `${String(i).padStart(6, "0")} ${"x".repeat(70)}`,
    );
    fs.writeFileSync(file, `${all.join("\n")}\n`); // ~4.6 MiB, several 1 MiB slices
    const lines: string[] = [];
    const tailer = makeTailer({
      filePath: file,
      pollMs: 1, // far shorter than a multi-megabyte read takes
      backfillBytes: 32 * 1024 * 1024, // no truncation: the whole file backfills
      onLines: (l: string[]) => lines.push(...l),
      onState: () => {},
      onReset: () => {},
    });
    tailer.start();
    await waitFor(() => lines.length >= count, 15000);
    expect(lines.length).toBe(count);
    expect(lines[0]).toBe(all[0]);
    expect(lines[count - 1]).toBe(all[count - 1]);
  });

  it("handles a UTF-8 multi-byte character split across a read boundary", async () => {
    const file = tmpFile();
    // "café" — the é is a 2-byte UTF-8 sequence; pick a slice size that lands
    // mid-character on the first read to prove the StringDecoder carries it.
    const text = "café résumé naïve\n";
    fs.writeFileSync(file, text, "utf8");
    const byteLen = Buffer.byteLength(text, "utf8");
    const lines: string[] = [];
    const tailer = makeTailer({
      filePath: file,
      pollMs: 20,
      sliceBytes: Math.max(1, Math.floor(byteLen / 2)), // forces at least 2 slices
      onLines: (l: string[]) => lines.push(...l),
      onState: () => {},
      onReset: () => {},
    });
    tailer.start();
    await waitFor(() => lines.length >= 1, 5000);
    expect(lines).toEqual(["café résumé naïve"]);
  });
});
