import type { SchedulerPort, TimerHandle } from "../../core/ports/scheduler";

// Node adapter for `SchedulerPort` — the global timer functions, nothing more.
// The casts are the whole point of the port: a Node `Timeout` never escapes
// this file, so callers cannot accidentally depend on `unref()` or on a handle
// being a number.
export class NodeScheduler implements SchedulerPort {
  setInterval(fn: () => void, ms: number): TimerHandle {
    return setInterval(fn, ms) as unknown as TimerHandle;
  }

  clearInterval(handle: TimerHandle | undefined): void {
    clearInterval(handle as unknown as NodeJS.Timeout | undefined);
  }
}

/** The process-wide scheduler call sites default to when nothing is injected. */
export const nodeScheduler: SchedulerPort = new NodeScheduler();
