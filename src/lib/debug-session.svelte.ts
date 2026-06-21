// The IDE debug session (model/studio/debug.pds): drives the in-sim
// scoped-line-hook debugger over the bridge. Breakpoints update the sim-side
// registry; "Debug current file" runs the buffer under the debugger
// (`debug_run`), polls `debug_state` while it runs, and resume/step issue
// `debug_continue { mode }`. The gutter + current-line decoration and the
// Debug panel read this singleton.

import { dcsCall, readTextFile } from "$lib/api";
import { app } from "$lib/state.svelte";
import { sourceId, pathOf, baseName, luaStr, sessionAction } from "$lib/debug-util";

// Re-export the path helpers so components keep importing them from here.
export { pathOf, baseName } from "$lib/debug-util";

/** One variable in the lazy tree. `ref` 0 = a leaf; >0 = expandable via
 * `expand(ref)` (only valid for the current pause). */
export interface DebugVariable {
  name: string;
  type: string;
  value: string;
  ref: number;
}

/** A scope (Locals / Upvalues / Globals) of a frame — an expandable ref. */
export interface DebugScope {
  name: string;
  ref: number;
}

/** One call-stack frame. */
export interface DebugFrame {
  index: number;
  source: string;
  line: number;
  name: string;
  scopes: DebugScope[];
}

/** The result of evaluating an expression in a paused frame. */
export interface EvalResult {
  ok: boolean;
  type?: string;
  value?: string;
  ref?: number;
  err?: string;
}

export type DebugStatus = "idle" | "running" | "paused";

const POLL_MS = 250;

class DebugSession {
  /** path → sorted 1-based breakpoint lines. Reassigned on change for runes
   * reactivity (the gutter reads `linesFor`). */
  breakpoints = $state<Record<string, number[]>>({});
  /** path → (line → condition expression). A line with a condition pauses only
   * when the expression is truthy in the stopped frame. */
  conditions = $state<Record<string, Record<number, string>>>({});
  /** User watch expressions, re-evaluated each pause/frame change. */
  watches = $state<string[]>([]);
  status = $state<DebugStatus>("idle");
  /** The paused call stack (top frame first), or [] when running/idle. */
  frames = $state<DebugFrame[]>([]);
  /** The selected frame's index (drives the Variables pane). */
  selectedFrame = $state<number>(0);
  /** Bumped on each new pause so the variable tree resets its lazy cache
   * (refs are only valid for the pause that minted them). */
  pauseSeq = $state<number>(0);
  /** The top frame's locals, fetched on each pause — drives inline values at
   * the execution line. */
  topLocals = $state<DebugVariable[]>([]);
  error = $state<string | null>(null);
  /** The "=path" source currently being debugged, or null when idle. */
  activeSource = $state<string | null>(null);

  #poll: ReturnType<typeof setInterval> | null = null;
  #lastJump = "";
  /** The sim's pause counter at the last refresh — a new value means a distinct
   * stop (even re-pausing on the same line), so the variable view must refresh. */
  #lastPauseId = -1;
  /** Whether this session has been observed paused/running at least once — so a
   * transient "not running yet" at startup never ends it prematurely, and a
   * dropped `running` flag after activity reliably ends it. */
  #sawActive = false;

  linesFor(path: string): number[] {
    return this.breakpoints[path] ?? [];
  }

  hasBreakpoint(path: string, line: number): boolean {
    return (this.breakpoints[path] ?? []).includes(line);
  }

  /** The 1-based execution line for `path` while paused there (the top frame),
   * else null. */
  currentLineFor(path: string): number | null {
    const top = this.frames[0];
    if (this.status !== "paused" || !top) return null;
    return pathOf(top.source) === path ? top.line : null;
  }

  /** The currently selected frame, or the top frame. */
  get frame(): DebugFrame | null {
    return this.frames[this.selectedFrame] ?? this.frames[0] ?? null;
  }

  async #fetchTopLocals(): Promise<void> {
    const top = this.frames[0];
    const localsScope = top?.scopes.find((s) => s.name === "Locals");
    this.topLocals = localsScope ? await this.expand(localsScope.ref) : [];
  }

  /** Eval `require("dcs_studio").debug.<method>(<args>)` over the bridge — the one
   * place the module-path prefix lives, so it can't drift across call sites. */
  #debugEval(method: string, args: string): Promise<unknown> {
    return dcsCall("eval", {
      code: `return require("dcs_studio").debug.${method}(${args})`,
    });
  }

  /** Drop the paused-frame state on a paused→running transition (one place, so a
   * field added here is cleared on both resume and the running poll). */
  #clearPausedState(): void {
    this.frames = [];
    this.topLocals = [];
  }

  /** Lazily expand a scope/variable ref at the current pause → its children. */
  async expand(ref: number): Promise<DebugVariable[]> {
    if (ref <= 0) return [];
    try {
      const res = (await dcsCall("debug_expand", { ref })) as {
        variables?: DebugVariable[];
      };
      return res?.variables ?? [];
    } catch {
      return [];
    }
  }

  /** Toggle a breakpoint and, if the bridge is reachable, update the registry. */
  async toggleBreakpoint(path: string, line: number): Promise<void> {
    const set = new Set(this.breakpoints[path] ?? []);
    if (set.has(line)) set.delete(line);
    else set.add(line);
    const lines = [...set].sort((a, b) => a - b);
    this.breakpoints = { ...this.breakpoints, [path]: lines };
    await this.#pushBreakpoints(path).catch(() => {});
  }

  clearBreakpoints(path: string): void {
    this.breakpoints = { ...this.breakpoints, [path]: [] };
    void this.#pushBreakpoints(path).catch(() => {});
  }

  async #pushBreakpoints(path: string): Promise<void> {
    const lines = this.breakpoints[path] ?? [];
    await this.#debugEval("set_breakpoints", `${luaStr(sourceId(path))}, {${lines.join(", ")}}`);
  }

  /** The condition on `path:line`, or "" if none. */
  conditionFor(path: string, line: number): string {
    return this.conditions[path]?.[line] ?? "";
  }

  /** Set (empty clears) a breakpoint's condition and push it to the sim. */
  async setCondition(path: string, line: number, cond: string): Promise<void> {
    const forPath = { ...(this.conditions[path] ?? {}) };
    if (cond.trim()) forPath[line] = cond.trim();
    else delete forPath[line];
    this.conditions = { ...this.conditions, [path]: forPath };
    // Ensure the line is a breakpoint, then push the condition.
    if (!(this.breakpoints[path] ?? []).includes(line)) {
      await this.toggleBreakpoint(path, line);
    }
    await this.#pushCondition(path, line, cond.trim());
  }

  async #pushCondition(path: string, line: number, cond: string): Promise<void> {
    const arg = cond ? `, ${luaStr(cond)}` : "";
    await this.#debugEval("set_condition", `${luaStr(sourceId(path))}, ${line}${arg}`).catch(
      () => {},
    );
  }

  /** Evaluate `expr` in the selected frame (watches + the debug console). */
  async evaluate(expr: string): Promise<EvalResult> {
    try {
      return (await dcsCall("debug_eval", {
        frame: this.selectedFrame,
        expr,
      })) as EvalResult;
    } catch (e) {
      return { ok: false, err: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Evaluate `expr` against the live sim (global env) for ad-hoc exploration —
   * no breakpoint needed. The result's ref expands lazily via `expand` against
   * the persistent inspection registry. */
  async inspect(expr: string): Promise<EvalResult> {
    try {
      return (await dcsCall("debug_inspect", { expr })) as EvalResult;
    } catch (e) {
      return { ok: false, err: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Release every inspection ref held in the sim (the explorer's registry). */
  clearInspection(): void {
    void dcsCall("debug_inspect_clear").catch(() => {});
  }

  /** Request a manual break-all (stops at the next line of debugged code). */
  pause(): void {
    if (this.status === "running") void dcsCall("debug_pause").catch(() => {});
  }

  addWatch(expr: string): void {
    const e = expr.trim();
    if (e && !this.watches.includes(e)) this.watches = [...this.watches, e];
  }

  removeWatch(expr: string): void {
    this.watches = this.watches.filter((w) => w !== expr);
  }

  /** Run `path`'s source under the debugger and start polling its state. Uses
   * the open buffer (so unsaved edits are debugged) when the file is open, else
   * reads it from disk — so right-click "Debug" works on any file. */
  async start(path: string): Promise<void> {
    if (this.status !== "idle") return;
    const open = app.openFiles.find((f) => f.path === path);
    let code = open && open.kind === "text" ? open.docText : null;
    if (code == null) {
      try {
        code = await readTextFile(path);
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
        return;
      }
    }
    this.error = null;
    this.status = "running";
    this.activeSource = sourceId(path);
    this.#lastJump = "";
    this.#lastPauseId = -1;
    this.#sawActive = false;
    app.bottomTool = "debug";
    await this.#pushBreakpoints(path).catch(() => {});
    this.#startPolling();
    // debug_run blocks for the WHOLE session (it pumps RPC while paused), so the
    // client's per-call timeout would reject it on a long run/pause. Don't gate
    // session-end on this promise — polling (the `running` flag) drives it. A
    // clean resolve ends the session; a mid-session reject is ignored (polling
    // continues); a reject before anything ran is a real startup failure.
    void dcsCall("debug_run", { source: sourceId(path), code })
      .then((r) => {
        const e = (r as { error?: string })?.error;
        if (e) this.error = e;
        this.#finish();
      })
      .catch((e) => {
        if (!this.#sawActive) {
          this.error = e instanceof Error ? e.message : String(e);
          this.#finish();
        }
      });
  }

  #startPolling(): void {
    this.#stopPolling();
    this.#poll = setInterval(() => void this.#tick(), POLL_MS);
  }

  #stopPolling(): void {
    if (this.#poll) {
      clearInterval(this.#poll);
      this.#poll = null;
    }
  }

  async #tick(): Promise<void> {
    let state: unknown;
    try {
      state = await dcsCall("debug_state");
    } catch {
      return; // a dropped poll is harmless; the next tick retries
    }
    const paused = (state as { paused?: boolean })?.paused === true;
    const running = (state as { running?: boolean })?.running === true;
    const action = sessionAction(paused, running, this.#sawActive);
    if (action === "pause") {
      let frames: DebugFrame[] = [];
      let pauseId = 0;
      let condError: string | undefined;
      try {
        const snap = JSON.parse((state as { snapshot: string }).snapshot) as {
          frames?: DebugFrame[];
          pause_id?: number;
          cond_error?: string;
        };
        frames = snap.frames ?? [];
        pauseId = snap.pause_id ?? 0;
        condError = snap.cond_error;
      } catch {
        frames = [];
      }
      const top = frames[0];
      this.frames = frames;
      this.status = "paused";
      this.#sawActive = true;
      this.error = condError ?? null; // surface a fail-open conditional error
      // A new stop (distinct pause_id) refreshes the variables/inline values —
      // even when re-pausing on the SAME line in a loop, whose handle-refs are
      // freshly minted and whose values changed.
      if (pauseId !== this.#lastPauseId) {
        this.#lastPauseId = pauseId;
        this.selectedFrame = 0;
        this.pauseSeq += 1;
        void this.#fetchTopLocals();
      }
      // Reveal the stopped line only when it MOVES, so the caret isn't yanked
      // back every poll while we sit on one breakpoint.
      const jump = top ? `${top.source}:${top.line}` : "";
      if (jump !== this.#lastJump) {
        this.#lastJump = jump;
        if (top) {
          const p = pathOf(top.source);
          app.openFile(p, baseName(p), { line: top.line, col: 1 });
        }
      }
    } else if (action === "run") {
      // Running between breakpoints. The `running` flag (not the blocking
      // debug_run promise, which times out on a long run/pause) is the truth.
      this.#sawActive = true;
      if (this.status === "paused") this.#clearPausedState();
      this.status = "running";
    } else if (action === "finish") {
      // The run flag dropped after activity — the session has ended.
      const err = (state as { error?: string }).error;
      if (err) this.error = String(err);
      this.#finish();
    }
    // action === "wait": not started yet — don't end the session prematurely.
  }

  #resume(mode: string): void {
    if (this.status !== "paused") return;
    this.#clearPausedState();
    this.status = "running";
    this.#lastJump = "";
    void dcsCall("debug_continue", { mode }).catch(() => {});
  }

  resume(): void {
    this.#resume("continue");
  }
  stepOver(): void {
    this.#resume("step_over");
  }
  stepInto(): void {
    this.#resume("step_into");
  }
  stepOut(): void {
    this.#resume("step_out");
  }

  /** Terminate the session: clear breakpoints and ask the sim to unwind the
   * running chunk (debug_stop), so even a runaway/infinite-loop run ends. The
   * session then finishes via polling (running flag drops). */
  stop(): void {
    if (this.activeSource) {
      void this.#debugEval("clear_breakpoints", "").catch(() => {});
      void dcsCall("debug_stop").catch(() => {});
    }
  }

  #finish(): void {
    this.#stopPolling();
    this.status = "idle";
    this.frames = [];
    this.topLocals = [];
    this.selectedFrame = 0;
    this.activeSource = null;
    this.#lastJump = "";
    this.#lastPauseId = -1;
    this.#sawActive = false;
  }

  /** Select a stack frame (drives the Variables pane). */
  selectFrame(index: number): void {
    if (index >= 0 && index < this.frames.length) this.selectedFrame = index;
  }
}

export const debug = new DebugSession();
