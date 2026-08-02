import { EventEmitter } from "node:events";

// A scriptable stand-in for `child_process`, shared by the adapter specs that
// drive an external CLI (gh, git, 7-Zip, mod entrypoints).
//
// Those adapters are almost entirely process choreography: accumulate stdout and
// stderr as they stream, distinguish "the binary is missing" (an `error` event,
// no exit code) from "the binary ran and failed" (a non-zero exit), and turn
// either into a message a user can act on. None of that is reachable by running
// the real tools — a developer machine with gh installed and signed in exercises
// exactly one branch, and the interesting ones (7-Zip absent, git killed by a
// signal, a spawn that never starts) cannot be provoked on demand at all.
//
// So the seam is the module: each spec does
//
//   vi.mock("child_process", () => ({ spawn: ... }))
//
// wiring it to a harness from here. What the adapter sees is a real
// EventEmitter emitting real events in real event-loop order; only the OS is
// fake. Vitest routes `node:child_process` imports through the same mock, so
// adapters using either specifier are covered.

/** One recorded spawn: what the adapter asked the OS to run, and how. */
export interface SpawnCall {
  cmd: string;
  args: string[];
  opts: Record<string, unknown>;
}

/**
 * A scripted process run. `error` models a spawn that never started (ENOENT);
 * otherwise the streams emit and the process exits with `code` — which is
 * `null` when a real process is killed by a signal, the case the adapters
 * normalise to -1.
 */
export interface FakeRun {
  /** stdout chunks, in order. A single string is one chunk. */
  stdout?: string | string[];
  /** stderr chunks, in order. */
  stderr?: string | string[];
  /** Exit code; `null` models death by signal. Defaults to 0. */
  code?: number | null;
  /** When set, the process emits `error` instead of exiting. */
  error?: Error;
  /** Side effect run before any event fires — lets a fake archiver write files. */
  effect?: (call: SpawnCall) => void;
}

function chunks(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/** An async child process that behaves like `ChildProcess` for adapter purposes. */
export class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  /** Undefined models a child whose pid is unavailable, which blocks a kill. */
  pid: number | undefined = 4242;
  unrefCount = 0;

  unref(): this {
    this.unrefCount++;
    return this;
  }

  /**
   * Stream the scripted output and finish, one macrotask later so the adapter
   * has attached its listeners first — the same ordering a real spawn gives.
   */
  play(run: FakeRun, call: SpawnCall): void {
    setImmediate(() => {
      run.effect?.(call);
      for (const c of chunks(run.stdout)) this.stdout.emit("data", Buffer.from(c));
      for (const c of chunks(run.stderr)) this.stderr.emit("data", Buffer.from(c));
      if (run.error) this.emit("error", run.error);
      else this.emit("exit", run.code === undefined ? 0 : run.code);
    });
  }
}

/** Decides what a given spawn does; returning undefined leaves the child live.
 *  Throwing models `spawn` itself throwing, which exercises the catch paths. */
export type SpawnPlanner = (call: SpawnCall) => FakeRun | undefined;

export interface SpawnHarness {
  /** Every spawn, in order. */
  readonly calls: SpawnCall[];
  /** The children handed back, in order — for driving lifecycle by hand. */
  readonly children: FakeChild[];
  /** Script the spawns. Default: an immediate clean exit. */
  plan(fn: SpawnPlanner): void;
  spawn(cmd: string, args?: string[], opts?: Record<string, unknown>): FakeChild;
}

/** A fresh harness; make one per test so recorded calls never leak between them. */
export function createSpawnHarness(): SpawnHarness {
  const calls: SpawnCall[] = [];
  const children: FakeChild[] = [];
  let planner: SpawnPlanner = () => ({ code: 0 });

  return {
    calls,
    children,
    plan(fn) {
      planner = fn;
    },
    spawn(cmd, args = [], opts = {}) {
      const call: SpawnCall = { cmd, args, opts };
      calls.push(call);
      const child = new FakeChild();
      children.push(child);
      const run = planner(call);
      if (run) child.play(run, call);
      return child;
    },
  };
}
