// The IDE debug session (model/studio/debug.pds): drives the in-sim
// scoped-line-hook debugger over the bridge. Breakpoints update the sim-side
// registry; "Debug current file" runs the buffer under the debugger
// (`debug_run`), polls `debug_state` while it runs, and resume/step issue
// `debug_continue { mode }`. The gutter + current-line decoration and the
// Debug panel read this singleton.

import { dcsCall, readTextFile } from "$lib/api";
import { app } from "$lib/state.svelte";

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

/** The sim-side source id for a file: a "=name" chunkname so the debugged
 * chunk's `debug.getinfo(...).source` reads back verbatim and lines up with the
 * breakpoints we register. */
function sourceId(path: string): string {
  return `=${path}`;
}

function pathOf(source: string): string {
  return source.startsWith("=") ? source.slice(1) : source;
}

/** Render a Lua string literal, escaping the embedding hazards. */
function luaStr(s: string): string {
  const esc = s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
  return `"${esc}"`;
}

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
    const code = `return require("dcs_studio").debug.set_breakpoints(${luaStr(
      sourceId(path),
    )}, {${lines.join(", ")}})`;
    await dcsCall("eval", { code });
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
    const code = `return require("dcs_studio").debug.set_condition(${luaStr(
      sourceId(path),
    )}, ${line}${arg})`;
    await dcsCall("eval", { code }).catch(() => {});
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
    if (paused) {
      let frames: DebugFrame[] = [];
      try {
        const snap = JSON.parse((state as { snapshot: string }).snapshot) as {
          frames?: DebugFrame[];
        };
        frames = snap.frames ?? [];
      } catch {
        frames = [];
      }
      const top = frames[0];
      // Reveal the stopped line — but only when it MOVES, so the caret isn't
      // yanked back every poll while we sit on one breakpoint. A new stop also
      // resets frame selection + the variable-tree cache (refs are stale).
      const key = top ? `${top.source}:${top.line}` : "";
      this.frames = frames;
      this.status = "paused";
      this.#sawActive = true;
      if (key !== this.#lastJump) {
        this.#lastJump = key;
        this.selectedFrame = 0;
        this.pauseSeq += 1;
        if (top) {
          const p = pathOf(top.source);
          app.openFile(p, p.split(/[\\/]/).pop() ?? p, { line: top.line, col: 1 });
        }
        // Fetch the top frame's locals for inline values at the execution line.
        void this.#fetchTopLocals();
      }
    } else {
      // Not paused: either running between breakpoints, or the session ended.
      // The `running` flag (not the blocking debug_run promise) is the truth —
      // so a long pause/run doesn't end the session when the client call times
      // out.
      const st = state as { running?: boolean; error?: string };
      if (st.running === true) {
        this.#sawActive = true;
        if (this.status === "paused") {
          this.frames = [];
          this.topLocals = [];
        }
        this.status = "running";
      } else if (this.#sawActive) {
        if (st.error) this.error = String(st.error);
        this.#finish();
      }
    }
  }

  #resume(mode: string): void {
    if (this.status !== "paused") return;
    this.frames = [];
    this.topLocals = [];
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

  /** No terminate over the bridge — clear breakpoints and let the chunk run to
   * completion (which ends the session). */
  stop(): void {
    if (this.activeSource) {
      void dcsCall("eval", {
        code: `return require("dcs_studio").debug.clear_breakpoints()`,
      }).catch(() => {});
    }
    if (this.status === "paused") this.#resume("continue");
  }

  #finish(): void {
    this.#stopPolling();
    this.status = "idle";
    this.frames = [];
    this.topLocals = [];
    this.selectedFrame = 0;
    this.activeSource = null;
    this.#lastJump = "";
    this.#sawActive = false;
  }

  /** Select a stack frame (drives the Variables pane). */
  selectFrame(index: number): void {
    if (index >= 0 && index < this.frames.length) this.selectedFrame = index;
  }
}

export const debug = new DebugSession();
