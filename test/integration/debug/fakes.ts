import { vi } from "vitest";
import type { BridgeStatus } from "../../../src/core/domain/bridgeProtocol";
import type { DebugState } from "../../../src/core/domain/debugProtocol";
import type { SchedulerPort, TimerHandle } from "../../../src/core/ports/scheduler";

// Doubles shared by the debug specs: a scheduler whose clock only moves when a
// test says so, and a bridge whose every RPC is a spy the test scripts.

/** Let queued microtasks and `.finally` chains run to completion. */
export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Let everything in flight settle, including the real `fs.promises.readFile`
 * the adapter uses to load the program. That one completes on the threadpool
 * and is only picked up in a loop iteration that actually waits, so draining
 * immediates alone never sees it — hence the short real-timer rounds.
 */
export async function settle(): Promise<void> {
  for (let i = 0; i < 25; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flush();
  }
}

interface FakeTimer {
  id: number;
  fn: () => void;
  ms: number;
  repeat: boolean;
  dueAt: number;
}

/**
 * A `SchedulerPort` with a hand-cranked clock.
 *
 * `advance` fires timers in due order and drains the microtask queue after each
 * one, so an async tick (`() => void this.poll()`) has finished its awaits
 * before the next tick starts — which is exactly the interleaving the real
 * event loop produces, and the only way the poll loop's overlap guard can be
 * observed.
 */
export class FakeScheduler implements SchedulerPort {
  private clock = 0;
  private nextId = 1;
  private readonly timers = new Map<number, FakeTimer>();

  setInterval(fn: () => void, ms: number): TimerHandle {
    return this.arm(fn, ms, true);
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    return this.arm(fn, ms, false);
  }

  clearInterval(handle: TimerHandle | undefined): void {
    this.cancel(handle);
  }

  clearTimeout(handle: TimerHandle | undefined): void {
    this.cancel(handle);
  }

  /** Cadences of every live timer, ms — empty means nothing is scheduled. */
  get liveIntervals(): number[] {
    return [...this.timers.values()].filter((t) => t.repeat).map((t) => t.ms);
  }

  get liveCount(): number {
    return this.timers.size;
  }

  /** Move the clock forward, running everything that comes due on the way. */
  async advance(ms: number): Promise<void> {
    const until = this.clock + ms;
    for (;;) {
      const due = [...this.timers.values()]
        .filter((t) => t.dueAt <= until)
        .sort((a, b) => a.dueAt - b.dueAt)[0];
      if (!due) break;
      this.clock = due.dueAt;
      if (due.repeat) due.dueAt += due.ms;
      else this.timers.delete(due.id);
      due.fn();
      await flush();
    }
    this.clock = until;
  }

  private arm(fn: () => void, ms: number, repeat: boolean): TimerHandle {
    const id = this.nextId++;
    this.timers.set(id, { id, fn, ms, repeat, dueAt: this.clock + ms });
    return { id } as unknown as TimerHandle;
  }

  private cancel(handle: TimerHandle | undefined): void {
    if (handle) this.timers.delete((handle as unknown as { id: number }).id);
  }
}

/**
 * One in-DCS bridge, as the debug adapter uses it. Every method is a spy with a
 * benign default, so a spec overrides only the RPC its scenario is about.
 */
export class FakeBridge {
  status: BridgeStatus = { connected: true, dcsTime: 1 };

  get current(): BridgeStatus {
    return this.status;
  }

  consoleRead = vi.fn(
    async (
      _after: number,
    ): Promise<{ lines: { seq: number; text: string }[]; latest: number }> => ({
      lines: [],
      latest: 0,
    }),
  );
  replEval = vi.fn(
    async (
      _env: string,
      _code: string,
    ): Promise<{ ok: boolean; result?: unknown; err?: string }> => ({ ok: true }),
  );
  debugRun = vi.fn(
    async (
      _env: string,
      _source: string,
      _code: string,
      _pauseOnError: boolean,
    ): Promise<{ ran?: boolean; error?: string | null; dispatched?: boolean }> => ({ ran: true }),
  );
  debugState = vi.fn(async (): Promise<DebugState> => ({ paused: false, running: true }));
  debugContinue = vi.fn(async (_mode: string): Promise<unknown> => undefined);
  debugPause = vi.fn(async (): Promise<unknown> => undefined);
  debugStop = vi.fn(async (): Promise<unknown> => undefined);
  debugExpand = vi.fn(async (_ref: number) => ({ variables: [] }));
  debugEval = vi.fn(async (_frame: number, _expr: string) => ({ ok: true, value: "nil" }));
  debugSetBreakpoints = vi.fn(async (_source: string, _bps: unknown[]) => ({ count: 0 }));
  debugClearBreakpoints = vi.fn(async (): Promise<unknown> => undefined);
}
