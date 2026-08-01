import { describe, expect, it } from "vitest";
import {
  BRIDGE_BACKOFF_FACTOR,
  BRIDGE_INITIAL_BACKOFF_MS,
  BRIDGE_MAX_BACKOFF_MS,
  BRIDGE_TORN_DOWN,
  BridgeRpcError,
  buildRequest,
  dcsTimeFromPing,
  formatRequestId,
  INITIAL_BRIDGE_STATUS,
  isExpectedBridgeFailure,
  nextBackoff,
  PING_INTERVAL_MS,
  PING_TIMEOUT_MS,
  PUMP_STALLED,
  parseResponse,
} from "../../../src/core/domain/bridgeProtocol";

describe("constants", () => {
  it("match the live client's frozen values", () => {
    expect(BRIDGE_INITIAL_BACKOFF_MS).toBe(1000);
    expect(BRIDGE_MAX_BACKOFF_MS).toBe(10000);
    expect(BRIDGE_BACKOFF_FACTOR).toBe(1.6);
    expect(PING_INTERVAL_MS).toBe(2000);
    expect(PING_TIMEOUT_MS).toBe(4000);
    expect(INITIAL_BRIDGE_STATUS).toEqual({ connected: false, dcsTime: null });
  });
});

describe("nextBackoff", () => {
  it("produces the exact 1000 → ×1.6 → cap-10000 sequence", () => {
    const seq: number[] = [];
    let b = BRIDGE_INITIAL_BACKOFF_MS;
    for (let i = 0; i < 7; i++) {
      b = nextBackoff(b);
      seq.push(b);
    }
    // round(6553.6)=6554; round(6554*1.6)=10486 → capped
    expect(seq).toEqual([1600, 2560, 4096, 6554, 10000, 10000, 10000]);
  });

  it("stays at the cap once reached", () => {
    expect(nextBackoff(BRIDGE_MAX_BACKOFF_MS)).toBe(BRIDGE_MAX_BACKOFF_MS);
  });
});

describe("formatRequestId", () => {
  it("is a decimal string, never a number (bridge serde rejects numeric ids)", () => {
    expect(formatRequestId(1)).toBe("1");
    expect(formatRequestId(42)).toBe("42");
    expect(typeof formatRequestId(7)).toBe("string");
  });
});

describe("buildRequest", () => {
  it("builds a jsonrpc 2.0 envelope with a string id", () => {
    expect(buildRequest("eval", "3", { code: "return 1" })).toEqual({
      jsonrpc: "2.0",
      method: "eval",
      id: "3",
      params: { code: "return 1" },
    });
  });

  it("omits params entirely when undefined (not null, not present)", () => {
    const msg = buildRequest("ping", "1");
    expect("params" in msg).toBe(false);
    expect(JSON.stringify(msg)).toBe('{"jsonrpc":"2.0","method":"ping","id":"1"}');
  });

  it("keeps explicit null params", () => {
    expect(buildRequest("m", "2", null).params).toBeNull();
  });
});

describe("parseResponse", () => {
  it("ignores non-JSON", () => {
    expect(parseResponse("not json{{{")).toEqual({ kind: "ignore" });
  });

  it("ignores messages without an id (notifications)", () => {
    expect(parseResponse(JSON.stringify({ jsonrpc: "2.0", result: 1 }))).toEqual({
      kind: "ignore",
    });
  });

  it("ignores an explicit null id", () => {
    expect(parseResponse(JSON.stringify({ id: null, result: 1 }))).toEqual({ kind: "ignore" });
  });

  it("correlates a string id result", () => {
    expect(parseResponse(JSON.stringify({ id: "5", result: { ok: true } }))).toEqual({
      kind: "result",
      id: "5",
      result: { ok: true },
    });
  });

  it("coerces a numeric id to string so it still correlates", () => {
    expect(parseResponse(JSON.stringify({ id: 5, result: 1 }))).toEqual({
      kind: "result",
      id: "5",
      result: 1,
    });
  });

  it("yields an undefined result when the field is absent", () => {
    expect(parseResponse(JSON.stringify({ id: "9" }))).toEqual({
      kind: "result",
      id: "9",
      result: undefined,
    });
  });

  it("prefers the human-readable Lua error in error.data over the generic message", () => {
    const text = JSON.stringify({
      id: "2",
      error: { message: "LuaError", data: "attempt to index nil" },
    });
    expect(parseResponse(text)).toEqual({
      kind: "error",
      id: "2",
      message: "attempt to index nil",
    });
  });

  it("falls back to error.message when data is not a string", () => {
    const text = JSON.stringify({ id: "2", error: { message: "LuaError", data: { c: 1 } } });
    expect(parseResponse(text)).toEqual({ kind: "error", id: "2", message: "LuaError" });
  });

  it("falls back to the JSON of the error object when message and data are missing", () => {
    const text = JSON.stringify({ id: "2", error: { code: -32000 } });
    expect(parseResponse(text)).toEqual({
      kind: "error",
      id: "2",
      message: '{"code":-32000}',
      code: -32000,
    });
  });

  it("treats an empty-string data as absent (falsy fallback)", () => {
    const text = JSON.stringify({ id: "2", error: { message: "M", data: "" } });
    expect(parseResponse(text)).toEqual({ kind: "error", id: "2", message: "M" });
  });

  // The code is the ONLY thing separating "the mission ended" from "the bridge
  // is broken" — the messages read the same to a caller. It used to be parsed
  // away here, which is why every bridge failure looked equally alarming.
  it("carries the server's error code through, not just the text", () => {
    const text = JSON.stringify({
      id: "7",
      error: { code: BRIDGE_TORN_DOWN, message: "bridge torn down" },
    });
    expect(parseResponse(text)).toEqual({
      kind: "error",
      id: "7",
      message: "bridge torn down",
      code: BRIDGE_TORN_DOWN,
    });
  });

  it("keeps the code alongside a data-supplied message", () => {
    const text = JSON.stringify({
      id: "8",
      error: { code: PUMP_STALLED, message: "LuaError", data: "pump stalled" },
    });
    expect(parseResponse(text)).toEqual({
      kind: "error",
      id: "8",
      message: "pump stalled",
      code: PUMP_STALLED,
    });
  });

  it("leaves the code undefined when the server sent a non-numeric one", () => {
    const text = JSON.stringify({ id: "9", error: { code: "-32001", message: "odd" } });
    expect(parseResponse(text)).toEqual({
      kind: "error",
      id: "9",
      message: "odd",
      code: undefined,
    });
  });

  it("leaves the code undefined when the server sent none", () => {
    const text = JSON.stringify({ id: "10", error: { message: "no code here" } });
    expect(parseResponse(text)).toEqual({
      kind: "error",
      id: "10",
      message: "no code here",
      code: undefined,
    });
  });
});

describe("BridgeRpcError", () => {
  it("is an Error that remembers the code", () => {
    const e = new BridgeRpcError("bridge torn down", BRIDGE_TORN_DOWN);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("BridgeRpcError");
    expect(e.message).toBe("bridge torn down");
    expect(e.code).toBe(BRIDGE_TORN_DOWN);
  });

  it("can carry no code, for a failure no server answered", () => {
    // Not-connected, client-side timeout, socket dropped: real failures, but
    // nothing assigned them a code, and they must not be mistaken for the
    // expected lifecycle answers below.
    expect(new BridgeRpcError("timed out").code).toBeUndefined();
  });
});

describe("isExpectedBridgeFailure", () => {
  // The decision this guards: whether the user is shown a "Report Issue"
  // button. That button asserts the extension misbehaved. A mission ending and
  // a sim not pumping are the bridge behaving correctly and saying so, and
  // inviting bug reports for them buries the reports that matter.

  it("says yes to a mission that ended under a call", () => {
    expect(isExpectedBridgeFailure(new BridgeRpcError("bridge torn down", BRIDGE_TORN_DOWN))).toBe(
      true,
    );
  });

  it("says yes to a sim that is not pumping this instant", () => {
    expect(isExpectedBridgeFailure(new BridgeRpcError("sim not pumping", PUMP_STALLED))).toBe(true);
  });

  it("says yes to a full bridge queue, which shares the same code", () => {
    // -32002 carries two refusals — "sim not pumping" and "queue full" — and
    // suppressing the report affordance for BOTH is the decision, not a side
    // effect of matching on the code alone. A full queue is the bridge applying
    // back-pressure as designed: nothing for a user to report, nothing for them
    // to do but retry. Pinned here so that splitting the code, or narrowing the
    // check to the staleness message, has to break a test that says why.
    expect(isExpectedBridgeFailure(new BridgeRpcError("queue full", PUMP_STALLED))).toBe(true);
  });

  it("says no to any other server error code", () => {
    // -32603 internal error is a genuine bridge fault and must stay reportable.
    expect(isExpectedBridgeFailure(new BridgeRpcError("internal error", -32603))).toBe(false);
    expect(isExpectedBridgeFailure(new BridgeRpcError("method not found", -32601))).toBe(false);
  });

  it("says no to a bridge rejection that carries no code", () => {
    expect(isExpectedBridgeFailure(new BridgeRpcError("timed out"))).toBe(false);
  });

  it("says no to anything that is not a bridge rejection at all", () => {
    // A plain Error whose text happens to mention the code must not sneak
    // through: the classification is by code, never by message matching.
    expect(isExpectedBridgeFailure(new Error("-32001 bridge torn down"))).toBe(false);
    expect(isExpectedBridgeFailure("bridge torn down")).toBe(false);
    expect(isExpectedBridgeFailure(undefined)).toBe(false);
  });
});

describe("dcsTimeFromPing", () => {
  it("returns the numeric sim time", () => {
    expect(dcsTimeFromPing({ dcs_time: 1234.5 })).toBe(1234.5);
    expect(dcsTimeFromPing({ dcs_time: 0 })).toBe(0);
  });

  it("returns null for a missing/typeless field or undefined result", () => {
    expect(dcsTimeFromPing(undefined)).toBeNull();
    expect(dcsTimeFromPing({})).toBeNull();
    expect(dcsTimeFromPing({ dcs_time: "12" as unknown as number })).toBeNull();
  });
});

// ── Two-bridge routing + combined status ──

import {
  bridgeForEnv,
  combinedState,
  type DualBridgeStatus,
  displayTime,
  GUI_BRIDGE_PORT,
  INITIAL_DUAL_STATUS,
  MISSION_BRIDGE_PORT,
} from "../../../src/core/domain/bridgeProtocol";

function dual(
  gui: { connected: boolean; dcsTime: number | null },
  mission: { connected: boolean; dcsTime: number | null },
): DualBridgeStatus {
  return { gui, mission };
}

const OFF = { connected: false, dcsTime: null };
const MENU = { connected: true, dcsTime: 0 };
const IN_MISSION = { connected: true, dcsTime: 87.5 };

describe("two-bridge constants and routing", () => {
  it("pins the well-known ports and the initial dual status", () => {
    expect(GUI_BRIDGE_PORT).toBe(25569);
    expect(MISSION_BRIDGE_PORT).toBe(25570);
    expect(INITIAL_DUAL_STATUS).toEqual({ gui: OFF, mission: OFF });
  });

  it("routes mission to the mission bridge and every other env to the GUI bridge", () => {
    expect(bridgeForEnv("mission")).toBe("mission");
    for (const env of ["gui", "server", "config", "export"]) {
      expect(bridgeForEnv(env)).toBe("gui");
    }
  });
});

describe("combinedState", () => {
  it("is offline when neither bridge is connected", () => {
    expect(combinedState(dual(OFF, OFF))).toBe("offline");
  });

  it("is menu when only the GUI bridge is up with no mission time", () => {
    expect(combinedState(dual(MENU, OFF))).toBe("menu");
    // before the first ping answers, dcsTime is still null
    expect(combinedState(dual({ connected: true, dcsTime: null }, OFF))).toBe("menu");
  });

  it("is mission when the mission bridge is connected", () => {
    expect(combinedState(dual(MENU, IN_MISSION))).toBe("mission");
    // even if the gui side is down (transient)
    expect(combinedState(dual(OFF, IN_MISSION))).toBe("mission");
  });

  it("is mission when the GUI bridge reports mission time (mission bridge not up)", () => {
    expect(combinedState(dual(IN_MISSION, OFF))).toBe("mission");
  });
});

describe("displayTime", () => {
  it("prefers the mission bridge's own clock when connected", () => {
    expect(displayTime(dual(MENU, IN_MISSION))).toBe(87.5);
  });

  it("falls back to the GUI mirror when the mission bridge is down or timeless", () => {
    expect(displayTime(dual(IN_MISSION, OFF))).toBe(87.5);
    expect(displayTime(dual(IN_MISSION, { connected: true, dcsTime: null }))).toBe(87.5);
    expect(displayTime(dual(OFF, OFF))).toBeNull();
  });
});

// The status-bar view-model, offline quick-pick and missionStartFailure copy
// moved to bridgeStatusView.ts — see bridgeStatusView.test.ts.
