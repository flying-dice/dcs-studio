// Pure JSON-RPC protocol logic for the in-DCS bridge: envelope build/parse,
// string-id correlation rules (the bridge's serde rejects numeric ids, so every
// request id is a decimal string), reconnect backoff, ping/status derivation.
// The stateful shell (bridge/client.ts) owns the socket, timers and the pending
// map; everything here is deterministic and exhaustively testable.

/** Live bridge status surfaced to the UI. `dcsTime` is the last ping's sim model
 *  time (> 0 ⇒ a mission is running); null when offline or between pings. */
export interface BridgeStatus {
  connected: boolean;
  dcsTime: number | null;
}

/** The status before the first successful connect. */
export const INITIAL_BRIDGE_STATUS: BridgeStatus = { connected: false, dcsTime: null };

// Reconnect backoff: 1000ms, then ×1.6 each attempt, capped at 10000ms.
export const BRIDGE_INITIAL_BACKOFF_MS = 1000;
export const BRIDGE_MAX_BACKOFF_MS = 10000;
export const BRIDGE_BACKOFF_FACTOR = 1.6;

// Ping cadence and its own (short) call timeout; a lone ping timeout is ignored,
// a real drop is caught by the socket close.
export const PING_INTERVAL_MS = 2000;
export const PING_TIMEOUT_MS = 4000;

/** The next backoff delay after `current` (rounded, capped at the max). */
export function nextBackoff(current: number): number {
  return Math.min(Math.round(current * BRIDGE_BACKOFF_FACTOR), BRIDGE_MAX_BACKOFF_MS);
}

/** The request id for counter value `n` — a decimal string (never a number). */
export function formatRequestId(n: number): string {
  return String(n);
}

export interface JsonRpcRequest {
  jsonrpc: string;
  method: string;
  id: string;
  params?: unknown;
}

/** Build a JSON-RPC request envelope; `params` is omitted entirely when undefined. */
export function buildRequest(method: string, id: string, params?: unknown): JsonRpcRequest {
  const msg: JsonRpcRequest = { jsonrpc: "2.0", method, id };
  if (params !== undefined) msg.params = params;
  return msg;
}

/** The outcome of correlating an inbound frame against the pending map. */
export type ParsedResponse =
  | { kind: "ignore" }
  | { kind: "result"; id: string; result: unknown }
  | { kind: "error"; id: string; message: string };

/**
 * Parse an inbound JSON-RPC message. Non-JSON and id-less messages are ignored.
 * The id is coerced to a string so a numeric id (should the server ever send one)
 * still correlates. The bridge carries the human-readable Lua error in `data`;
 * `message` is a generic "LuaError", so `data` (when a string) wins.
 */
export function parseResponse(text: string): ParsedResponse {
  let msg: { id?: string | number; result?: unknown; error?: { message?: string; data?: unknown } };
  try {
    msg = JSON.parse(text);
  } catch {
    return { kind: "ignore" };
  }
  if (msg.id === undefined || msg.id === null) return { kind: "ignore" };
  const id = String(msg.id);
  if (msg.error) {
    const detail = typeof msg.error.data === "string" ? msg.error.data : undefined;
    return { kind: "error", id, message: detail || msg.error.message || JSON.stringify(msg.error) };
  }
  return { kind: "result", id, result: msg.result };
}

/** Derive `dcsTime` from a ping result: the numeric sim time, else null. */
export function dcsTimeFromPing(r: { dcs_time?: number } | undefined): number | null {
  return typeof r?.dcs_time === "number" ? r.dcs_time : null;
}

// ── Bridge payload types (shared by the client shell and the DAP translation) ──

/** Lua state a console call targets. "gui" is the hooks env the bridge runs in;
 * "mission" is the mission scripting env (needs a running mission); the rest
 * are DCS's other net states, reached via net.dostring_in. */
export type LuaEnv = "gui" | "mission" | "server" | "config" | "export";

/** Lua state a debug session runs in. The engine supports the hooks env it
 * lives in ("gui") and the mission scripting sandbox ("mission", dispatched
 * via a_do_script; needs a running mission + desanitized MissionScripting.lua). */
export type DebugEnv = "gui" | "mission";

export interface ReplVariable {
  name: string;
  type: string;
  value: string;
  /** > 0 means expandable via replExpand; 0 is a leaf. */
  ref: number;
}

export interface ReplInspectResult {
  ok: boolean;
  err?: string;
  type?: string;
  value?: string;
  ref?: number;
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
