// Pure JSON-RPC protocol logic for the in-DCS bridge: envelope build/parse,
// string-id correlation rules (the bridge's serde rejects numeric ids, so every
// request id is a decimal string), reconnect backoff, ping/status derivation.
// The stateful shell (bridge/client.ts) owns the socket, timers and the pending
// map; everything here is deterministic and exhaustively testable.

/** Live bridge status surfaced to the UI. `dcsTime` is the last ping's sim model
 *  time (> 0 ⇒ a mission is running); null when offline or between pings.
 *
 *  `stalled` is the other half of "alive", and the reason this interface is not
 *  just `connected`: cards 04 and 17 both landed on the same lesson — a healthy
 *  socket (and a healthy `/health`) is not evidence that anything can be
 *  dispatched. It is true while the bridge is answering but its Lua-side pump is
 *  not draining, and it is *observed* rather than inferred: the bridge itself
 *  refuses a request with `-32002` in that state, so every reply the client
 *  already makes tells it which side of the line it is on. Meaningless while
 *  `connected` is false, and always false there. */
export interface BridgeStatus {
  connected: boolean;
  dcsTime: number | null;
  stalled: boolean;
}

/** The status before the first successful connect. */
export const INITIAL_BRIDGE_STATUS: BridgeStatus = {
  connected: false,
  dcsTime: null,
  stalled: false,
};

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
 * gui-reported mission time) means a mission is running; a connected bridge that
 * cannot be served is `stalled`. */
export type CombinedState = "offline" | "stalled" | "menu" | "mission";

/**
 * `stalled` outranks `menu`/`mission` because it is the finer fact: those two
 * say which Lua states exist, and this says whether either can be reached right
 * now. Reporting "mission" for a sim that is sitting on a briefing screen is the
 * exact over-claim cards 04 and 17 recorded.
 *
 * It is EITHER bridge, deliberately, not both. The two pumps stall
 * independently and for opposite reasons — a held mission breakpoint stops the
 * GUI bridge's frame drain while the mission bridge keeps serving, and an
 * ESC pause or a briefing screen freezes model time and stalls the mission
 * bridge while the GUI keeps drawing frames — so requiring both would report
 * the truth in neither of the two situations that actually occur.
 *
 * `offline` still wins: a bridge that is not connected has no pump to describe.
 */
export function combinedState(s: DualBridgeStatus): CombinedState {
  if (!s.gui.connected && !s.mission.connected) return "offline";
  if ((s.gui.connected && s.gui.stalled) || (s.mission.connected && s.mission.stalled))
    return "stalled";
  if (s.mission.connected || (s.gui.connected && (s.gui.dcsTime ?? 0) > 0)) return "mission";
  return "menu";
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

/**
 * The ping cadence while the pump is stalled.
 *
 * 2 s pings exist to keep the clock in the status bar fresh, and a stalled pump
 * has no clock to freshen — model time is frozen and every ping is refused
 * before it is even queued. Card 17's live session watched the extension's own
 * 2 s poll write `deadline has elapsed` into `dcs_studio_gui.log` every two
 * seconds for the whole of a held breakpoint; that is the noise this removes.
 *
 * The cost is bounded and worth stating plainly: a stalled → serving transition
 * noticed by the ping alone can take up to 10 s to reach the status bar. It is
 * bounded that way only when NOTHING else is talking to the bridge, because the
 * client treats every reply as evidence (see `pumpStateFromReply`) — a debugger
 * step, a console eval, the output tail, any of them clears the stall on the
 * spot and restores the fast cadence. The slow case is therefore an idle editor
 * whose user is watching only the status bar, and 10 s of a truthful "sim idle"
 * is a far smaller lie than 2 s pings into a queue that cannot drain.
 */
export const PING_STALLED_INTERVAL_MS = 10000;

/** How long to wait before the next ping, given the pump's last known state. */
export function pingIntervalFor(stalled: boolean): number {
  return stalled ? PING_STALLED_INTERVAL_MS : PING_INTERVAL_MS;
}

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

/**
 * The Lua state that would have answered is being destroyed, so nothing ever
 * will. Defined bridge-side as `JSON_RPC_BRIDGE_TORN_DOWN`
 * (bridge/crates/bridge-core/src/jsonrpc/mod.rs). Every request still queued at
 * `S_EVENT_MISSION_END` is answered with this — 45 and 23 of them in two live
 * runs — so it is the *expected* answer while a mission unloads, not a fault.
 */
export const BRIDGE_TORN_DOWN = -32001;

/**
 * The transport is healthy and the request was understood, but the Lua-side
 * pump has not drained this server's queue for long enough that queueing would
 * only end in the server's own 30 s timeout. Defined bridge-side as
 * `JSON_RPC_PUMP_STALLED`.
 *
 * Card 17's finding: a held mission breakpoint stops the GUI bridge's
 * `onSimulationFrame` drain while its socket still answers `/health` in 1–2 ms.
 * Nothing has gone away and the very next frame serves again — so this is a
 * condition to report, never a defect to file.
 *
 * The name records the first cause, not the only one. `-32002` carries TWO
 * bridge-side refusals, told apart by the message rather than by the code:
 *
 * - `"sim not pumping"` — the staleness refusal described above.
 * - `"queue full"` — the bridge's request queue is at its 256-entry cap, so a
 *   request arriving at a full one is answered rather than queued.
 *
 * They are the same thing from this side: transient back-pressure against a
 * perfectly well-formed request, where the remedy is to retry and nothing is
 * broken. Nothing in this extension branches on which one it was, and the
 * constant is deliberately not split in two to invite that.
 */
export const PUMP_STALLED = -32002;

/** The outcome of correlating an inbound frame against the pending map. */
export type ParsedResponse =
  | { kind: "ignore" }
  | { kind: "result"; id: string; result: unknown }
  | { kind: "error"; id: string; message: string; code?: number };

/**
 * Parse an inbound JSON-RPC message. Non-JSON and id-less messages are ignored.
 * The id is coerced to a string so a numeric id (should the server ever send one)
 * still correlates. The bridge carries the human-readable Lua error in `data`;
 * `message` is a generic "LuaError", so `data` (when a string) wins.
 *
 * `code` is carried through rather than parsed away. It is the only thing that
 * distinguishes "the mission ended" and "the sim is not pumping this instant"
 * from "the bridge is broken", and the editor treats those very differently.
 */
export function parseResponse(text: string): ParsedResponse {
  let msg: {
    id?: string | number;
    result?: unknown;
    error?: { message?: string; data?: unknown; code?: unknown };
  };
  try {
    msg = JSON.parse(text);
  } catch {
    return { kind: "ignore" };
  }
  if (msg.id === undefined || msg.id === null) return { kind: "ignore" };
  const id = String(msg.id);
  if (msg.error) {
    const detail = typeof msg.error.data === "string" ? msg.error.data : undefined;
    const code = typeof msg.error.code === "number" ? msg.error.code : undefined;
    return {
      kind: "error",
      id,
      message: detail || msg.error.message || JSON.stringify(msg.error),
      code,
    };
  }
  return { kind: "result", id, result: msg.result };
}

/**
 * A rejection that came back from the bridge as a JSON-RPC error, carrying the
 * `code` that says which kind it was. A plain `Error` is still used for
 * failures that never reached the server (not connected, client-side timeout,
 * socket dropped): those have no code because no server assigned one.
 */
export class BridgeRpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = "BridgeRpcError";
  }
}

/**
 * Whether a failed bridge call is an ordinary, expected answer rather than a
 * defect — and so must NOT be offered to the user as something to file a
 * GitHub issue about.
 *
 * The "Report Issue" toast is a claim that the extension did something wrong.
 * A mission that ended (`-32001`) and a sim that is not pumping this instant
 * (`-32002`) are both the bridge working correctly and saying so. Putting them
 * behind a report button trains users to file noise and buries the reports
 * that mean something.
 *
 * `-32002` covers both of its transient conditions here — `"sim not pumping"`
 * AND `"queue full"` — and suppressing both is DELIBERATE, not an accident of
 * matching on the code alone. A full queue is the bridge applying back-pressure
 * exactly as designed; there is no defect for a user to report and no action
 * for them to take beyond retrying. The unit suite pins both messages so this
 * stays a decision rather than a side effect of the coarser check.
 *
 * Note this is about the *report affordance*, not about silence: callers still
 * tell the user what happened, just as transient status rather than a fault.
 */
export function isExpectedBridgeFailure(e: unknown): boolean {
  return e instanceof BridgeRpcError && (e.code === BRIDGE_TORN_DOWN || e.code === PUMP_STALLED);
}

/**
 * What one correlated reply says about the pump behind it, or null when it says
 * nothing.
 *
 * This is the whole liveness signal, and it needs no transport of its own: the
 * bridge already refuses a request it cannot drain with `-32002` instead of
 * queueing it, so a reply carrying that code is a first-hand report that the
 * pump is stale, and ANY other reply — a result, or an error the sim had to be
 * running to produce — is first-hand proof that it drained. Polling `/health`
 * for `pump_stalled` was the alternative and was rejected: it would add an HTTP
 * client beside the WebSocket, a second cadence to reason about, and a second
 * source of truth that can disagree with the one the calls themselves see.
 *
 * `-32001` is the one reply that claims NOTHING, hence the `null`: the mission's
 * queue is failed wholesale by the teardown path, not by a drain, so it is
 * neither evidence the pump ran nor evidence it is stale. Reading it as "the
 * pump drained" would briefly paint a bridge as healthy on its way out of
 * existence.
 *
 * Note what is NOT here: a client-side timeout and a socket drop never reach
 * this function, because no server assigned them a code. That is deliberate.
 * "The bridge said it cannot drain" and "we heard nothing back" are different
 * claims, and only the first one may light up a status that tells the user
 * their sim is idle rather than gone.
 */
export function pumpStateFromReply(code: number | undefined): boolean | null {
  if (code === PUMP_STALLED) return true;
  if (code === BRIDGE_TORN_DOWN) return null;
  return false;
}

/** Derive `dcsTime` from a ping result: the numeric sim time, else null. */
export function dcsTimeFromPing(r: { dcs_time?: number } | undefined): number | null {
  return typeof r?.dcs_time === "number" ? r.dcs_time : null;
}

// The debug/REPL payload types (LuaEnv, DebugEnv, Repl*/Debug* results) live in
// debugProtocol.ts — a core module (dapTranslation) consumes them. The DCS
// unit-database (db_*) payload types live in bridge/dbTypes.ts, consumed only
// by the bridge adapter tier.
