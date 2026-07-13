import type { ClockPort } from "../../core/ports/clock";

// Node adapter for `ClockPort` — the real wall clock.
export class SystemClock implements ClockPort {
  now(): number {
    return Date.now();
  }
}
