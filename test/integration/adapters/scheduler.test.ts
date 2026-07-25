import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeScheduler, nodeScheduler } from "../../../src/adapters/node/scheduler";

// The Node side of `SchedulerPort`. There is nothing to it but the four global
// timer functions — which is the point, so this only proves the wiring is not
// crossed (a `setTimeout` armed by `setInterval`'s branch would turn every poll
// loop into a single tick) and that a cancelled timer really stops.

describe("NodeScheduler", () => {
  const scheduler = new NodeScheduler();

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("repeats an interval until it is cleared", () => {
    const tick = vi.fn();
    const handle = scheduler.setInterval(tick, 100);
    vi.advanceTimersByTime(250);
    expect(tick).toHaveBeenCalledTimes(2);

    scheduler.clearInterval(handle);
    vi.advanceTimersByTime(500);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it("fires a timeout once", () => {
    const done = vi.fn();
    scheduler.setTimeout(done, 100);
    vi.advanceTimersByTime(500);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending timeout", () => {
    const done = vi.fn();
    scheduler.clearTimeout(scheduler.setTimeout(done, 100));
    vi.advanceTimersByTime(500);
    expect(done).not.toHaveBeenCalled();
  });

  it("treats an unarmed handle as nothing to cancel", () => {
    // Call sites clear timers they may never have armed (an aborted session
    // tears down before its poll loop starts), so this must not throw.
    expect(() => {
      scheduler.clearInterval(undefined);
      scheduler.clearTimeout(undefined);
    }).not.toThrow();
  });

  it("exposes a shared instance for call sites that inject nothing", () => {
    expect(nodeScheduler).toBeInstanceOf(NodeScheduler);
  });
});
