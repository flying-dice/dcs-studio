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

/** Status-bar rendering for the dual status (pure, testable). */
export function statusBarView(s: DualBridgeStatus): { text: string; tooltip: string } {
  if (!s.gui.connected && !s.mission.connected) {
    return {
      text: "$(debug-disconnect) DCS: offline",
      tooltip: "Neither bridge is reachable. Click for options: Launch DCS (with bridge), Open Lua Console, or Inject Bridge.",
    };
  }
  const t = displayTime(s);
  if (s.mission.connected) {
    return {
      text: `$(rocket) DCS: mission ${t && t > 0 ? t.toFixed(0) + "s" : ""}`.trimEnd(),
      tooltip: "GUI and mission bridges connected — mission running. Click for the Lua console.",
    };
  }
  if ((s.gui.dcsTime ?? 0) > 0) {
    return {
      text: "$(warning) DCS: mission (no mission bridge)",
      tooltip:
        "A mission is running but the mission bridge (port 25570) isn't reachable. " +
        "MissionScripting.lua may be sanitized — run “DCS Studio: Desanitize MissionScripting.lua” and restart the mission.",
    };
  }
  return {
    text: "$(plug) DCS: at menu",
    tooltip: "GUI bridge connected — at the menu. The mission bridge starts with a mission. Click for the Lua console.",
  };
}

// ── Status bar click dispatcher ──
// The status bar item is the most prominent "DCS: offline" signal in the IDE.
// Clicking it while online keeps opening the console directly; clicking it
// while offline instead offers a quick-pick that surfaces the launch command
// (previously reachable only via the Command Palette) alongside the console
// and inject actions. "Offline" here is deliberately just the GUI bridge —
// the mission bridge only exists while a mission is loaded, so a mission
// bridge that's down while the GUI bridge is up (at menu, or sanitized
// MissionScripting.lua) must NOT be treated as "DCS offline".

export type StatusBarClickAction = "openConsole" | "offlineDispatch";

/** What clicking the bridge status bar item should do. */
export function statusBarClickAction(s: DualBridgeStatus): StatusBarClickAction {
  return s.gui.connected ? "openConsole" : "offlineDispatch";
}

export interface DispatchOption {
  label: string;
  description: string;
  command: string;
}

/** Offered by the status bar dispatcher when the GUI bridge is offline. Every
 * option reuses an existing command — this is purely a discoverability
 * affordance, not a new implementation. */
export const OFFLINE_DISPATCH_OPTIONS: readonly DispatchOption[] = [
  {
    label: "$(rocket) Launch DCS (with bridge)",
    description: "Inject the bridge and start DCS.exe",
    command: "dcs.bridge.launch",
  },
  {
    label: "$(terminal) Open Lua Console",
    description: "Open the console now (Run/Inspect stay disabled until connected)",
    command: "dcs.bridge.console",
  },
  {
    label: "$(plug) Inject Bridge",
    description: "Install the bridge DLLs without launching DCS",
    command: "dcs.bridge.inject",
  },
];

/**
 * Why a mission-env action can't proceed right now, or null when the mission
 * bridge is up. `sanitized` is the on-disk MissionScripting.lua scan (true =
 * lockdown active → the mission bridge cannot boot); pass undefined when the
 * file can't be read.
 */
export function missionStartFailure(s: DualBridgeStatus, sanitized?: boolean): string | null {
  if (s.mission.connected) return null;
  if (!s.gui.connected) {
    return "The DCS bridge is not connected. Launch DCS with the bridge (command: “DCS Studio: Launch DCS (with bridge)”) and wait for the status bar to show DCS online.";
  }
  if (sanitized) {
    return "The mission bridge is not connected: MissionScripting.lua is sanitized, so it cannot load. Run “DCS Studio: Desanitize MissionScripting.lua”, restart DCS, then start a mission.";
  }
  return "The mission bridge is not connected — start a mission in DCS (it boots automatically a moment after mission start and only runs while a mission is loaded).";
}

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

// ── rpc.discover → OpenRPC document (https://spec.open-rpc.org/) ──
// Per the OpenRPC standard, rpc.discover returns the service's OpenRPC document,
// generated by the DLL from the exact methods it registered (never handcrafted;
// pinned by a golden test on the bridge side). Every field is tolerant — treat
// this as a read-only description, not a strict contract on the editor side.

/** An OpenRPC content descriptor (a param or result): a named value with a
 * JSON-Schema `schema`. The bridge maps its Lua `type` hints to schema types;
 * an untyped value gets a permissive `{}` schema. */
export interface OpenRpcContentDescriptor {
  name: string;
  required?: boolean;
  description?: string;
  schema?: { type?: string } & Record<string, unknown>;
}

/** One OpenRPC method object. */
export interface OpenRpcMethod {
  name: string;
  summary?: string;
  description?: string;
  params?: OpenRpcContentDescriptor[];
  result?: OpenRpcContentDescriptor;
}

/** The OpenRPC document `rpc.discover` returns from either bridge. The bridge
 * identity lives in `info` (`title` = service name, `x-dcs-env` = "gui" |
 * "mission", `version` = bridge build). */
export interface DiscoverResult {
  openrpc?: string;
  info?: {
    title?: string;
    version?: string;
    description?: string;
    "x-dcs-env"?: string;
  };
  servers?: { name?: string; url?: string }[];
  methods?: OpenRpcMethod[];
}
