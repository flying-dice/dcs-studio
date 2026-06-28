import { describe, it, expect } from "vitest";
import { Superseder } from "./supersede";

describe("Superseder", () => {
  it("a single run is current and returns its value", async () => {
    const s = new Superseder();
    expect(await s.run(() => Promise.resolve(true), false)).toEqual({
      value: true,
      current: true,
    });
  });

  it("tags only the latest-issued run current when an earlier run resolves last", async () => {
    const s = new Superseder();
    // Run A is issued first but resolves LAST — the slow, stale probe.
    let resolveA!: (v: boolean) => void;
    const aPending = s.run<boolean>(
      () => new Promise((r) => (resolveA = r)),
      false,
    );
    // Run B is issued second and resolves FIRST.
    const b = await s.run(() => Promise.resolve(false), false);
    resolveA(true);
    const a = await aPending;

    // Newest issued wins; the stale earlier probe is flagged not-current so the
    // caller discards it (this is the #69 same-root re-show-Build race).
    expect(b).toEqual({ value: false, current: true });
    expect(a.value).toBe(true);
    expect(a.current).toBe(false);
  });

  it("falls back when the task throws, and stays current if latest (fail-safe)", async () => {
    const s = new Superseder();
    expect(
      await s.run<boolean>(() => Promise.reject(new Error("io")), false),
    ).toEqual({ value: false, current: true });
  });

  it("a stale throwing run does not report current", async () => {
    const s = new Superseder();
    const aPending = s.run<boolean>(
      () => Promise.reject(new Error("io")),
      false,
    );
    await s.run(() => Promise.resolve(true), false); // supersedes A
    expect((await aPending).current).toBe(false);
  });
});
