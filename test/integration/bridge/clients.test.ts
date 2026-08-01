import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetVscode, vscodeMock } from "../support/vscode";

vi.mock("vscode", () => vscodeMock());

import type { BridgeClient } from "../../../src/bridge/client";
import { BridgeClients } from "../../../src/bridge/clients";
import type { DualBridgeStatus } from "../../../src/core/domain/bridgeProtocol";
import { CONNECTED, FakeBridgeClient, OFFLINE } from "./fakeBridgeClient";

// The pair of bridges as one unit. Both are separate DLLs with separate
// lifetimes — the GUI bridge lives as long as DCS, the mission bridge only
// while a mission is loaded — so everything above this (the console, the status
// bar, the debugger) depends on the merged signal firing for either one and on
// env routing sending a call to the bridge that can actually serve it.

let gui: FakeBridgeClient;
let mission: FakeBridgeClient;
let clients: BridgeClients;

beforeEach(() => {
  resetVscode();
  gui = new FakeBridgeClient();
  mission = new FakeBridgeClient();
  clients = new BridgeClients(gui as unknown as BridgeClient, mission as unknown as BridgeClient);
});

describe("env routing", () => {
  it("sends mission-env calls to the mission bridge and everything else to the GUI one", () => {
    // The mission env only exists inside the mission scripting state; asking
    // the GUI bridge for it would silently evaluate in the wrong Lua universe.
    expect(clients.forEnv("mission")).toBe(mission);
    expect(clients.forEnv("gui")).toBe(gui);
    // The net states (server/config/export) are reached from the GUI state via
    // net.dostring_in, so they route to the GUI bridge too.
    expect(clients.forEnv("server")).toBe(gui);
  });
});

describe("combined status", () => {
  it("reports both bridges' live statuses", () => {
    gui.emit(CONNECTED);
    expect(clients.current).toEqual({ gui: CONNECTED, mission: OFFLINE });
  });

  it("replays a full dual status to a new subscriber", () => {
    gui.emit({ connected: true, dcsTime: 12, stalled: false });
    const seen: DualBridgeStatus[] = [];
    clients.onStatus((s) => seen.push(s));
    // Each underlying client replays on subscribe, so the pair converges on the
    // live value without the caller having to ask for it.
    expect(seen[seen.length - 1]).toEqual({
      gui: { connected: true, dcsTime: 12, stalled: false },
      mission: OFFLINE,
    });
  });

  it("fires when either bridge changes, carrying the other's last value", () => {
    const seen: DualBridgeStatus[] = [];
    clients.onStatus((s) => seen.push(s));
    seen.length = 0;

    gui.emit(CONNECTED);
    expect(seen).toEqual([{ gui: CONNECTED, mission: OFFLINE }]);

    // A mission starting must not blank out what we know about the GUI bridge.
    mission.emit({ connected: true, dcsTime: 3.5, stalled: false });
    expect(seen[1]).toEqual({
      gui: CONNECTED,
      mission: { connected: true, dcsTime: 3.5, stalled: false },
    });
  });

  it("unsubscribes from both bridges when the merged subscription is disposed", () => {
    const sub = clients.onStatus(() => {});
    expect(gui.listenerCount).toBe(1);
    expect(mission.listenerCount).toBe(1);
    // A panel that closes must not keep both bridges' listener lists growing.
    sub.dispose();
    expect(gui.listenerCount).toBe(0);
    expect(mission.listenerCount).toBe(0);
  });
});

describe("lifecycle", () => {
  it("starts, reconnects and disposes both bridges together", () => {
    clients.start();
    expect([gui.started, mission.started]).toEqual([1, 1]);

    // After launching DCS neither bridge is up yet; both need the nudge, or the
    // mission bridge waits out its backoff while the GUI one is already live.
    clients.reconnect();
    expect([gui.reconnected, mission.reconnected]).toEqual([1, 1]);

    clients.dispose();
    expect([gui.disposed, mission.disposed]).toEqual([1, 1]);
  });
});
