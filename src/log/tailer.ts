// Node fs-polling tail of dcs.log. The file lives outside the workspace
// (Saved Games/DCS/Logs/dcs.log), so there's no VS Code FileSystemWatcher for
// it — this polls `stat` on an interval instead, same approach dcs-studio's
// desktop app uses.
//
// Responsibilities kept here (deliberately NOT in src/core/domain/dcsLog.ts,
// which stays pure): missing-file detection, truncation (DCS restarts truncate
// dcs.log) and rotation (a fresh file behind the same name, told apart by its
// inode rather than by a size comparison that a regrown file defeats),
// backfilling the tail of a huge file without ever reading it whole, and
// carrying incomplete UTF-8 byte sequences across per-tick read slices.
//
// Every one of those breaks the continuity of the tail, and every one of them
// therefore reports `onReset` before the lines that follow — the viewer appends
// what it is given, so a re-opened tail that arrives unannounced is duplicated
// on screen rather than replacing what it repeats.
import type { Stats } from "fs";
import * as fsp from "fs/promises";
import { StringDecoder } from "string_decoder";
import type { LogFileState } from "../core/app/webviewContract";
import { LineDecoder } from "../core/domain/dcsLog";

/** Alias of the declared contract's own name for it (`LogFileState`), so the
 * state the tailer reports and the state the webview is told cannot drift. */
export type FileState = LogFileState;

export interface LogTailerCallbacks {
  /** Complete, decoded lines read since the last callback (in order). */
  onLines(lines: string[]): void;
  /** Fires only on a missing<->ok transition (not every tick). */
  onState(state: FileState): void;
  /**
   * Our place in the file is gone and the next lines start a fresh tail: DCS
   * truncated dcs.log on restart, the file was rotated away, or it disappeared
   * for a while. Fires exactly once per such break, always BEFORE the lines
   * that follow it, so the viewer can divide (and drop what it had) instead of
   * appending a re-read tail underneath the same lines it already shows.
   */
  onReset(): void;
}

export interface LogTailerOptions extends LogTailerCallbacks {
  filePath: string;
  /** Poll interval, ms. Default 500. */
  pollMs?: number;
  /** How much of the tail to backfill on open. Default 256 KiB. */
  backfillBytes?: number;
  /** Max bytes read per tick, so one huge jump never blocks the loop. Default 1 MiB. */
  sliceBytes?: number;
}

const DEFAULT_POLL_MS = 500;
const DEFAULT_BACKFILL_BYTES = 256 * 1024;
const DEFAULT_SLICE_BYTES = 1024 * 1024;

export class LogTailer {
  private readonly filePath: string;
  private readonly pollMs: number;
  private readonly backfillBytes: number;
  private readonly sliceBytes: number;
  private readonly cb: LogTailerCallbacks;

  private timer: ReturnType<typeof setInterval> | undefined;
  private offset = 0;
  private state: FileState | undefined;
  /** False until the first successful backfill; a missing-file gap resets it. */
  private backfilled = false;
  /** The inode of the file we are holding an offset into — a different one
   * behind the same path is a rotation, not growth. */
  private inode = 0;
  private lineDecoder = new LineDecoder();
  private strDecoder = new StringDecoder("utf8");
  /** Reentrancy guard: a slow read must not overlap the next tick's stat. */
  private ticking = false;

  constructor(opts: LogTailerOptions) {
    this.filePath = opts.filePath;
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    this.backfillBytes = opts.backfillBytes ?? DEFAULT_BACKFILL_BYTES;
    this.sliceBytes = opts.sliceBytes ?? DEFAULT_SLICE_BYTES;
    this.cb = opts;
  }

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.tickOnce();
    } finally {
      this.ticking = false;
    }
  }

  private async tickOnce(): Promise<void> {
    let stat: Stats;
    try {
      stat = await fsp.stat(this.filePath);
    } catch {
      this.markMissing();
      return;
    }
    try {
      await this.drain(stat);
    } catch {
      // The stat succeeded but the open/read did not: the file was deleted
      // between the two, or the path is not a readable file at all (a bad
      // savedGamesPath, a dropped network share). Report it as missing — the
      // poll loop keeps running and recovers on its own. Letting it escape
      // instead would only surface an unhandled rejection in the extension
      // host, which the user can neither see nor act on.
      //
      // Crucially our PLACE in the file is kept: a single failed tick on an
      // otherwise unchanged file must resume where it left off, not re-backfill
      // the last 256 KiB as a fresh tail. A file that really went away fails
      // its next stat, and that is what discards the offset.
      this.setState("missing");
      return;
    }
    // Only announced once a read actually worked, so a path that stats but
    // cannot be read reports "missing" steadily instead of flapping every tick.
    this.setState("ok");
  }

  private markMissing(): void {
    this.setState("missing");
    // The next appearance is a fresh open — re-backfill from its new tail, and
    // tell the viewer, or those lines land as new entries under the ones they
    // repeat. Guarded on `backfilled` so a file that stays missing for a
    // hundred ticks still breaks the tail exactly once.
    if (this.backfilled) {
      this.backfilled = false;
      this.offset = 0;
      this.cb.onReset();
    }
  }

  /** Reads whatever the fresh `stat` implies: first fill, restart, growth. */
  private async drain(stat: Stats): Promise<void> {
    const size = stat.size;
    if (!this.backfilled) {
      this.inode = stat.ino;
      await this.backfill(size);
      return;
    }
    // A different file behind the same name (dcs.log rotated away and
    // recreated), or one that shrank (DCS truncates it on restart) — either way
    // the offset we hold points into a file that is no longer there. The inode
    // check also catches a rotation that regrew past the old offset, which a
    // size comparison alone cannot see; where the filesystem reports no usable
    // inode (0 on some Windows shares) it simply never differs and the size
    // check remains the only signal.
    if (stat.ino !== this.inode || size < this.offset) {
      this.inode = stat.ino;
      this.resetDecoders();
      this.cb.onReset();
      await this.backfill(size);
      return;
    }
    if (size > this.offset) {
      await this.readFrom(size, false);
    }
  }

  private setState(s: FileState): void {
    if (this.state === s) return;
    this.state = s;
    this.cb.onState(s);
  }

  private resetDecoders(): void {
    this.lineDecoder = new LineDecoder();
    this.strDecoder = new StringDecoder("utf8");
  }

  private async backfill(size: number): Promise<void> {
    this.resetDecoders();
    const start = Math.max(0, size - this.backfillBytes);
    this.offset = start;
    this.backfilled = true;
    // Nothing to read, so nothing is opened. That is right for the common case
    // — DCS truncates dcs.log on restart, and a 0-byte log is healthy, not
    // missing — but it does mean a path that stats as 0 and could not be read
    // anyway is reported "ok". On Windows a DIRECTORY stats as size 0, so a
    // savedGamesPath pointing at one reads as fine rather than missing; on
    // POSIX the same directory stats non-zero, fails the open, and is correctly
    // reported missing. Opening every 0-byte file just to prove it is readable
    // would cost a syscall per poll to catch a misconfiguration the Setup panel
    // already refuses.
    if (size === 0) return;
    // Opening mid-file (start > 0) means the very first line read is a
    // fragment of whatever line straddles the backfill boundary — drop it.
    await this.readFrom(size, start > 0);
  }

  /** Reads from the current offset up to `end`, capped at `sliceBytes` for this call. */
  private async readFrom(end: number, dropFirstLine: boolean): Promise<void> {
    const readEnd = Math.min(end, this.offset + this.sliceBytes);
    const length = readEnd - this.offset;
    if (length <= 0) return;
    const buf = Buffer.alloc(length);
    const handle = await fsp.open(this.filePath, "r");
    try {
      await handle.read(buf, 0, length, this.offset);
    } finally {
      await handle.close();
    }
    this.offset = readEnd;
    const text = this.strDecoder.write(buf);
    let lines = this.lineDecoder.push(text);
    if (dropFirstLine && lines.length) lines = lines.slice(1);
    if (lines.length) this.cb.onLines(lines);
  }
}
