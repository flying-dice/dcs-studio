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

// ── Two bridges: GUI (GameGUI hook state) and mission (mission scripting state) ──
// Each is its own DLL with its own JSON-RPC server; the mission bridge is only
// reachable while a mission is running (its DLL is booted into the mission
// state by the GUI hook at mission start, and needs a desanitized
// MissionScripting.lua).

export const GUI_BRIDGE_PORT = 25569;
export const MISSION_BRIDGE_PORT = 25570;

/** Which bridge serves a given Lua environment. */
export type BridgeId = "gui" | "mission";

/** Routing rule: the mission env is served by the mission bridge; everything
 * else (gui, and the server/config/export net states reached via
 * net.dostring_in from the GUI state) by the GUI bridge. */
export function bridgeForEnv(env: string): BridgeId {
  return env === "mission" ? "mission" : "gui";
}

/** Both bridges' live statuses, as one value for the UI. */
export interface DualBridgeStatus {
  gui: BridgeStatus;
  mission: BridgeStatus;
}

export const INITIAL_DUAL_STATUS: DualBridgeStatus = {
  gui: INITIAL_BRIDGE_STATUS,
  mission: INITIAL_BRIDGE_STATUS,
};

/** Coarse combined state for footers/badges: mission-bridge connectivity (or a
 * gui-reported mission time) means a mission is running. */
export type CombinedState = "offline" | "menu" | "mission";

export function combinedState(s: DualBridgeStatus): CombinedState {
  if (s.mission.connected || (s.gui.connected && (s.gui.dcsTime ?? 0) > 0)) return "mission";
  if (s.gui.connected) return "menu";
  return "offline";
}

/** The sim time to display: the mission bridge's own clock when connected,
 * else the GUI bridge's mirror of it. */
export function displayTime(s: DualBridgeStatus): number | null {
  if (s.mission.connected && s.mission.dcsTime !== null) return s.mission.dcsTime;
  return s.gui.dcsTime;
}

// The status-bar view-model, offline quick-pick menu and mission-start failure
// copy live in bridgeStatusView.ts (presentation, built on displayTime above).

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

// The debug/REPL payload types (LuaEnv, DebugEnv, Repl*/Debug* results) live in
// debugProtocol.ts — a core module (dapTranslation) consumes them. The DCS
// unit-database (db_*) payload types live in bridge/dbTypes.ts, consumed only
// by the bridge adapter tier.
