// Port: the clock. Inject wherever time feeds logic so tests can control it.

export interface ClockPort {
  /** Milliseconds since the Unix epoch (like `Date.now()`). */
  now(): number;
}
