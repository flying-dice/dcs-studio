import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeScheduler, nodeScheduler } from "../../../src/adapters/node/scheduler";

// The Node side of `SchedulerPort`. There is nothing to it but the two global
// interval functions — which is the point, so this only proves that a timer
// really repeats and that a cancelled one really stops.

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

  it("treats an unarmed handle as nothing to cancel", () => {
    // Call sites clear timers they may never have armed (an aborted session
    // tears down before its poll loop starts), so this must not throw.
    expect(() => scheduler.clearInterval(undefined)).not.toThrow();
  });

  it("exposes a shared instance for call sites that inject nothing", () => {
    expect(nodeScheduler).toBeInstanceOf(NodeScheduler);
  });
});
