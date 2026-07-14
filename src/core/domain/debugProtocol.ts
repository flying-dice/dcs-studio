// Debug/REPL payload types for the in-DCS bridges: the Lua-env selectors and
// the console (repl_*) + debugger (debug_*) result shapes. Consumed by the
// pure DAP translation (core/domain/dapTranslation.ts) and the bridge client +
// debug adapters; kept in core (not the bridge adapter) because a core module
// depends on them. Type-only — no runtime, no I/O.

/** Lua state a console call targets. "gui" is the hooks env the GUI bridge
 * runs in; "mission" is the mission scripting env, served directly by the
 * mission bridge (needs a running mission); the rest are DCS's other net
 * states, reached via net.dostring_in from the GUI bridge. */
export type LuaEnv = "gui" | "mission" | "server" | "config" | "export";

/** Lua state a debug session runs in — each served by its own bridge: "gui"
 * by the GUI bridge (port 25569), "mission" by the mission bridge (port
 * 25570, alive only while a mission runs). */
export type DebugEnv = "gui" | "mission";

export interface ReplVariable {
  name: string;
  type: string;
  value: string;
  /** > 0 means the value has a live sim-side ref; branch on `type` to use it —
   * a `table` is expandable via replExpand, a `function` is signature-resolvable
   * via replSignature. 0 is a leaf. */
  ref: number;
}

export interface ReplInspectResult {
  ok: boolean;
  err?: string;
  type?: string;
  value?: string;
  ref?: number;
}

/** Result of replSignature: a function ref's resolved parameter names. `native`
 * marks a C function (no Lua parameter names); `params` is the comma-joined
 * name list ("" for a 0-arg or native function). */
export interface ReplSignatureResult {
  ok: boolean;
  err?: string;
  params?: string;
  native?: boolean;
}

/** One frame of a pause snapshot (bridge debug_state → snapshot JSON). */
export interface DebugFrame {
  /** 0-based; doubles as the `frame` argument to debugEval. */
  index: number;
  /** Chunkname as the sim saw it: "=<abs path>" (debug_run) or "@<path>" (dofile). */
  source: string;
  line: number;
  name: string;
  scopes: { name: string; ref: number }[];
}

export interface DebugSnapshot {
  frames: DebugFrame[];
  /** Monotonic per-session stop counter — a new value means a NEW stop, even on the same line. */
  pause_id: number;
  cond_error?: string | null;
  stop_reason?: string | null;
  error?: string | null;
}

export interface DebugState {
  paused: boolean;
  running: boolean;
  error?: string | null;
  /** JSON string of DebugSnapshot, present while paused. */
  snapshot?: string;
}

export interface DebugValue {
  ok: boolean;
  err?: string;
  type?: string;
  value?: string;
  /** > 0 means expandable via debugExpand; 0 is a leaf. */
  ref?: number;
  /** Set when the expression was a top-level `name = value` assignment. */
  assigned?: boolean;
}
