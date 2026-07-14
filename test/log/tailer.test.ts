import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { LogTailer, LogTailerOptions } from "../../src/log/tailer";

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
    const tailer = makeTailer({ filePath: file, pollMs: 20, onLines: (l: string[]) => lines.push(...l), onState: () => {}, onReset: () => {} });
    tailer.start();
    await waitFor(() => lines.length >= 2);
    expect(lines).toEqual(["line one", "line two"]);
  });

  it("detects appended growth", async () => {
    const file = tmpFile();
    fs.writeFileSync(file, "first\n");
    const lines: string[] = [];
    const tailer = makeTailer({ filePath: file, pollMs: 20, onLines: (l: string[]) => lines.push(...l), onState: () => {}, onReset: () => {} });
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
    const tailer = makeTailer({ filePath: file, pollMs: 15, onLines: () => {}, onState: (s: string) => states.push(s), onReset: () => {} });
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
    const batch = Array.from({ length: 20 }, (_, i) => `line-${i}`).join("\n") + "\n"; // ~180 bytes
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
    fs.writeFileSync(file, allLines.join("\n") + "\n");
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
    const tailer = new LogTailer({ filePath: file, pollMs: 15, onLines: (l: string[]) => lines.push(...l), onState: () => {}, onReset: () => {} });
    tailer.start();
    await waitFor(() => lines.length >= 1);
    tailer.stop();
    const countAtStop = lines.length;
    fs.appendFileSync(file, "two\n");
    await new Promise((r) => setTimeout(r, 100));
    expect(lines.length).toBe(countAtStop);
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
