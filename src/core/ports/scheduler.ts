// Port: repeating work — the timer half of the story `ClockPort` starts. A poll
// loop takes this instead of the global timer functions, so a test drives its
// cadence explicitly rather than sleeping on it.
//
// Scoped to what has a caller: `src/debug/adapter.ts`'s poll loop, and nothing
// else. The one-shot half (setTimeout/clearTimeout) was here first and served
// nobody — `src/bridge/client.ts` and `src/log/tailer.ts` still use the globals
// for their request timeout, reconnect backoff and poll tick. Reinstate it the
// day one of them takes the port, not before.
//
// Handles are opaque by design: `setInterval` yields a `Timeout` object on Node
// and a number in a browser, and neither shape belongs inside the hexagon. A
// handle is only ever passed back to the scheduler that issued it.

declare const timerHandleBrand: unique symbol;

/** A scheduled timer, as far as anything outside the adapter is concerned. */
export interface TimerHandle {
  readonly [timerHandleBrand]: never;
}

export interface SchedulerPort {
  /** Call `fn` every `ms` milliseconds until cancelled. */
  setInterval(fn: () => void, ms: number): TimerHandle;
  /** Stop a repeating timer. `undefined` is a no-op, as with the global. */
  clearInterval(handle: TimerHandle | undefined): void;
}
