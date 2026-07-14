// Presentation for the dual bridge status: the status-bar view-model (text +
// tooltip, with $(icon) codes and user-facing copy), the offline quick-pick
// menu, and the "why a mission action can't proceed" message composition. Pure
// and exhaustively testable — the wire-protocol/status math it builds on lives
// in bridgeProtocol.ts (this module imports the status types + displayTime from
// there). Kept apart from bridgeProtocol so that module stays pure JSON-RPC
// protocol logic with no view concerns.

import { type DualBridgeStatus, displayTime } from "./bridgeProtocol";

/** Status-bar rendering for the dual status (pure, testable). */
export function statusBarView(s: DualBridgeStatus): { text: string; tooltip: string } {
  if (!s.gui.connected && !s.mission.connected) {
    return {
      text: "$(debug-disconnect) DCS: offline",
      tooltip:
        "Neither bridge is reachable. Click for options: Launch DCS (with bridge), Open Lua Console, or Inject Bridge.",
    };
  }
  const t = displayTime(s);
  if (s.mission.connected) {
    return {
      text: `$(rocket) DCS: mission ${t && t > 0 ? `${t.toFixed(0)}s` : ""}`.trimEnd(),
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
    tooltip:
      "GUI bridge connected — at the menu. The mission bridge starts with a mission. Click for the Lua console.",
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
