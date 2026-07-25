// Port: deferred and repeating work — the timer half of the story `ClockPort`
// starts. Anything that polls, backs off or times out takes this instead of the
// global timer functions, so a test advances time explicitly rather than
// sleeping, and a loop's cadence becomes something to assert on rather than
// something to wait for.
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
  /** Call `fn` once, `ms` milliseconds from now. */
  setTimeout(fn: () => void, ms: number): TimerHandle;
  /** Cancel a pending one-shot. `undefined` is a no-op, as with the global. */
  clearTimeout(handle: TimerHandle | undefined): void;
}
