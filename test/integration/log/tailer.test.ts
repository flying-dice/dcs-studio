import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tmpRoot } from "../../support/tmpDir";

// One failure mode here cannot be arranged against a real file: an open/read
// that fails on a file whose stat just succeeded (the deletion race, a share
// dropping for one tick). `openFailures` makes the next N opens fail and is
// zero for every other spec, so the rest of the suite still runs on real I/O.
const hooks = vi.hoisted(() => ({ openFailures: 0 }));

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return {
    ...actual,
    default: actual,
    open: (...args: Parameters<typeof actual.open>) => {
      if (hooks.openFailures <= 0) return actual.open(...args);
      hooks.openFailures--;
      const e = new Error("EBUSY: resource busy or locked") as NodeJS.ErrnoException;
      e.code = "EBUSY";
      return Promise.reject(e);
    },
  };
});

import { LogTailer, type LogTailerOptions } from "../../../src/log/tailer";

// Short poll interval + real timers: the tailer is a thin fs-polling loop,
// so exercising it end-to-end against a real temp file is more honest than
// mocking fs. `waitFor` polls a predicate instead of racing a fixed sleep.

const tmp = tmpRoot("dcslog-");
const tailers: LogTailer[] = [];

afterEach(() => {
  for (const t of tailers.splice(0)) t.stop();
  hooks.openFailures = 0;
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

/** A log path in a scratch directory of its own — the file need not exist. */
function tmpFile(): string {
  return path.join(tmp.make(), "dcs.log");
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

  it("keeps its place in the file when a single read fails, rather than replaying it", async () => {
    // THE duplication bug: one failed tick on an otherwise unchanged file used
    // to discard the read offset, so the next tick re-backfilled the last
    // 256 KiB — which the panel appends as new entries, with no divider and no
    // dedupe. The stat/open race and a share that drops for one tick both land
    // here.
    const file = tmpFile();
    fs.writeFileSync(file, "first\n");
    const lines: string[] = [];
    const states: string[] = [];
    let resets = 0;
    const tailer = makeTailer({
      filePath: file,
      pollMs: 20,
      onLines: (l: string[]) => lines.push(...l),
      onState: (s: string) => states.push(s),
      onReset: () => resets++,
    });
    tailer.start();
    await waitFor(() => lines.length >= 1);

    hooks.openFailures = 1;
    fs.appendFileSync(file, "second\n");
    await waitFor(() => lines.length >= 2);

    expect(lines).toEqual(["first", "second"]);
    // Nothing was re-opened, so the viewer is told of no break in the tail.
    expect(resets).toBe(0);
    // The tick that could not read reports the file as missing and the next one
    // takes it back, rather than claiming "ok" and then failing every time.
    expect(states).toEqual(["ok", "missing", "ok"]);
  });

  it("announces the break when the file disappears, so the re-backfill is not a duplicate", async () => {
    // A gap really does mean a fresh open of whatever comes back, and the
    // viewer appends what it is given — without the reset the re-read tail
    // lands underneath the very lines it repeats.
    const file = tmpFile();
    fs.writeFileSync(file, "before the gap\n");
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

    fs.rmSync(file);
    await waitFor(() => resets === 1);
    // Several ticks with the file still gone must not break the tail again.
    await new Promise((r) => setTimeout(r, 100));
    fs.writeFileSync(file, "after the gap\n");
    await waitFor(() => lines.length >= 2);

    expect(resets).toBe(1);
    expect(lines).toEqual(["before the gap", "after the gap"]);
  });

  it("treats a fresh file behind the same name as a restart, however big it is", async () => {
    // A rotate that regrows past the old offset defeats a size comparison
    // entirely: the next read would start mid-file, in the middle of a line of
    // a file it has never seen. The identity of the file is what settles it.
    const file = tmpFile();
    fs.writeFileSync(file, "old log\n");
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

    // Rotation as it really happens: the old file is renamed away and a new one
    // — bigger than the old — takes its place.
    const replacement = `${file}.new`;
    fs.writeFileSync(replacement, "brand new log with much more in it\n");
    fs.renameSync(file, `${file}.1`);
    fs.renameSync(replacement, file);

    await waitFor(() => resets === 1);
    await waitFor(() => lines.length >= 2);
    expect(lines).toEqual(["old log", "brand new log with much more in it"]);
  });

  it("reports a missing file, then transitions to ok once it appears (with backfill)", async () => {
    const file = tmpFile();
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
    const states: string[] = [];
    const tailer = makeTailer({
      filePath: file,
      pollMs: 15,
      sliceBytes: 40, // small cap: forces several ticks to drain the appended batch
      onLines: (l: string[]) => lines.push(...l),
      onState: (s: string) => states.push(s),
      onReset: () => {},
    });
    tailer.start();
    // "ok" lands only once a tick has read successfully, so this is the initial
    // (empty) backfill having happened — the batch below must not race it, or
    // the first read is a growth read rather than a first fill.
    await waitFor(() => states.length > 0);
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

  it.skipIf(process.platform === "win32")(
    "reports a path that stats but cannot be read as missing, and recovers when it becomes a real file",
    async () => {
      // Everything after the stat is a separate set of syscalls that can fail on
      // their own: dcs.log deleted between the stat and the open, a savedGamesPath
      // pointing at something that is not a file, a network share dropping. A
      // directory reproduces that class deterministically. The loop has to survive
      // it — an escaping rejection would land as an unhandled error in the
      // extension host, invisible to the user and fatal to the tail.
      //
      // POSIX only, and not for want of trying: a directory stats non-zero here
      // and so reaches the open that fails, but on Windows it stats as size 0 and
      // the tailer never opens it (see backfill's note) — so the same setup
      // exercises a different path there rather than a weaker one. Nothing
      // portable produces "stats fine, will not open": the alternatives need an
      // ACL, a foreign process holding an exclusive handle, or a real race
      // between the stat and the open.
      const file = tmpFile();
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
    },
  );

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
