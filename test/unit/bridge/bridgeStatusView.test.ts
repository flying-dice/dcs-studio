import { describe, expect, it } from "vitest";
import type { DualBridgeStatus } from "../../../src/core/domain/bridgeProtocol";
import {
  missionStartFailure,
  OFFLINE_DISPATCH_OPTIONS,
  statusBarClickAction,
  statusBarView,
} from "../../../src/core/domain/bridgeStatusView";

type Half = { connected: boolean; dcsTime: number | null; stalled?: boolean };

function dual(gui: Half, mission: Half): DualBridgeStatus {
  return { gui: { stalled: false, ...gui }, mission: { stalled: false, ...mission } };
}

const OFF = { connected: false, dcsTime: null };
const MENU = { connected: true, dcsTime: 0 };
const IN_MISSION = { connected: true, dcsTime: 87.5 };
const STALLED_MISSION = { connected: true, dcsTime: 87.5, stalled: true };

describe("statusBarView", () => {
  it("offline when neither bridge is reachable", () => {
    const v = statusBarView(dual(OFF, OFF));
    expect(v.text).toBe("$(debug-disconnect) DCS: offline");
    expect(v.tooltip).toContain("Launch DCS");
  });

  it("mission with sim time when the mission bridge is connected", () => {
    const v = statusBarView(dual(MENU, IN_MISSION));
    expect(v.text).toBe("$(rocket) DCS: mission 88s");
    expect(v.tooltip).toContain("mission running");
  });

  it("mission without a time suffix when neither clock has ticked through yet", () => {
    const v = statusBarView(dual(MENU, { connected: true, dcsTime: null }));
    expect(v.text).toBe("$(rocket) DCS: mission");
    // a zero clock (mission loading) also renders without the suffix
    const zero = statusBarView(dual(MENU, { connected: true, dcsTime: 0 }));
    expect(zero.text).toBe("$(rocket) DCS: mission");
  });

  it("menu when the GUI bridge is up but its first ping has not answered", () => {
    const v = statusBarView(dual({ connected: true, dcsTime: null }, OFF));
    expect(v.text).toBe("$(plug) DCS: at menu");
  });

  it("warns when a mission runs but the mission bridge is down", () => {
    const v = statusBarView(dual(IN_MISSION, OFF));
    expect(v.text).toBe("$(warning) DCS: mission (no mission bridge)");
    expect(v.tooltip).toContain("Desanitize MissionScripting.lua");
  });

  it("reports a stalled pump as its own state, not as a running mission", () => {
    const v = statusBarView(dual(MENU, STALLED_MISSION));
    expect(v.text).toBe("$(debug-pause) DCS: sim idle");
    // The stale clock is dropped: a frozen number beside a live-looking status
    // is the exact symptom card 04 predicted.
    expect(v.text).not.toContain("87");
    expect(v.text).not.toContain("88");
  });

  it("says what it observed and no more — never that the user paused it, never that it broke", () => {
    const v = statusBarView(dual(MENU, STALLED_MISSION));
    // Three causes land here (held breakpoint, ESC pause, briefing screen) and
    // the copy must fit all three without asserting any one of them.
    expect(v.tooltip).toContain("briefing");
    expect(v.tooltip).toContain("breakpoint");
    expect(v.tooltip).toContain("Nothing is broken");
    expect(v.text).not.toContain("offline");
  });

  it("prefers offline over stalled when nothing is connected at all", () => {
    const v = statusBarView(dual({ ...OFF, stalled: true }, { ...OFF, stalled: true }));
    expect(v.text).toBe("$(debug-disconnect) DCS: offline");
  });

  it("menu when only the GUI bridge is up", () => {
    const v = statusBarView(dual(MENU, OFF));
    expect(v.text).toBe("$(plug) DCS: at menu");
    expect(v.tooltip).toContain("mission bridge starts with a mission");
  });
});

describe("statusBarClickAction", () => {
  it("opens the console when the GUI bridge is connected, regardless of mission bridge state", () => {
    expect(statusBarClickAction(dual(MENU, OFF))).toBe("openConsole");
    expect(statusBarClickAction(dual(MENU, IN_MISSION))).toBe("openConsole");
    expect(statusBarClickAction(dual(IN_MISSION, OFF))).toBe("openConsole");
  });

  it("dispatches when the GUI bridge is down, even if the mission bridge (transiently) reports connected", () => {
    expect(statusBarClickAction(dual(OFF, OFF))).toBe("offlineDispatch");
    expect(statusBarClickAction(dual(OFF, IN_MISSION))).toBe("offlineDispatch");
  });
});

describe("OFFLINE_DISPATCH_OPTIONS", () => {
  it("offers launch, console and inject, each mapped to its existing command", () => {
    expect(OFFLINE_DISPATCH_OPTIONS.map((o) => o.command)).toEqual([
      "dcs.bridge.launch",
      "dcs.bridge.console",
      "dcs.bridge.inject",
    ]);
    for (const o of OFFLINE_DISPATCH_OPTIONS) {
      expect(o.label.length).toBeGreaterThan(0);
      expect(o.description.length).toBeGreaterThan(0);
    }
  });
});

describe("missionStartFailure", () => {
  it("is null when the mission bridge is connected", () => {
    expect(missionStartFailure(dual(MENU, IN_MISSION))).toBeNull();
  });

  it("still lets a mission action through while the pump is stalled — deliberately", () => {
    // A stalled pump does NOT block F5. Blocking would mean inventing a second,
    // client-side refusal for something the bridge already refuses truthfully
    // and instantly (-32002, in 1-23 ms live), and a briefing screen that is
    // three seconds from serving would become a command the editor forbids.
    // The call goes out and fails fast with the bridge's own words.
    expect(missionStartFailure(dual(MENU, STALLED_MISSION))).toBeNull();
  });

  it("points at launching DCS when both bridges are down", () => {
    expect(missionStartFailure(dual(OFF, OFF))).toContain("Launch DCS with the bridge");
  });

  it("points at desanitizing when MissionScripting.lua is sanitized", () => {
    const msg = missionStartFailure(dual(IN_MISSION, OFF), true);
    expect(msg).toContain("Desanitize MissionScripting.lua");
  });

  it("points at starting a mission otherwise (sanitize state false or unknown)", () => {
    expect(missionStartFailure(dual(MENU, OFF), false)).toContain("start a mission");
    expect(missionStartFailure(dual(MENU, OFF))).toContain("start a mission");
  });
});
