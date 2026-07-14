// Node fs-polling tail of dcs.log. The file lives outside the workspace
// (Saved Games/DCS/Logs/dcs.log), so there's no VS Code FileSystemWatcher for
// it — this polls `stat` on an interval instead, same approach dcs-studio's
// desktop app uses.
//
// Responsibilities kept here (deliberately NOT in src/core/domain/dcsLog.ts,
// which stays pure): missing-file detection, truncation (DCS restarts
// truncate dcs.log — a rename/rotate would look identical from a size check
// alone; unrecoverable without an OS-level rotation signal, which Windows
// doesn't give us — noted as an accepted limitation), backfilling the tail of
// a huge file without ever reading it whole, and carrying incomplete UTF-8
// byte sequences across per-tick read slices.
import * as fsp from "fs/promises";
import { StringDecoder } from "string_decoder";
import { LineDecoder } from "../core/domain/dcsLog";

export type FileState = "ok" | "missing";

export interface LogTailerCallbacks {
  /** Complete, decoded lines read since the last callback (in order). */
  onLines(lines: string[]): void;
  /** Fires only on a missing<->ok transition (not every tick). */
  onState(state: FileState): void;
  /** The file shrank since we last read it — DCS restarted and truncated it. */
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
    let size: number;
    try {
      size = (await fsp.stat(this.filePath)).size;
    } catch {
      this.setState("missing");
      // The next appearance is a fresh open — re-backfill from its new tail.
      this.backfilled = false;
      this.offset = 0;
      return;
    }
    this.setState("ok");
    if (!this.backfilled) {
      await this.backfill(size);
      return;
    }
    if (size < this.offset) {
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
