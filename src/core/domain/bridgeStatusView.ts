// Presentation for the dual bridge status: the status-bar view-model (text +
// tooltip, with $(icon) codes and user-facing copy), the offline quick-pick
// menu, and the "why a mission action can't proceed" message composition. Pure
// and exhaustively testable — the wire-protocol/status math it builds on lives
// in bridgeProtocol.ts (this module imports the status types + displayTime from
// there). Kept apart from bridgeProtocol so that module stays pure JSON-RPC
// protocol logic with no view concerns.

import { combinedState, type DualBridgeStatus, displayTime } from "./bridgeProtocol";

/** Status-bar rendering for the dual status (pure, testable). */
export function statusBarView(s: DualBridgeStatus): { text: string; tooltip: string } {
  if (!s.gui.connected && !s.mission.connected) {
    return {
      text: "$(debug-disconnect) DCS: offline",
      tooltip:
        "Neither bridge is reachable. Click for options: Launch DCS (with bridge), Open Lua Console, or Inject Bridge.",
    };
  }
  // A connected-but-unservable bridge, before any of the "which states exist"
  // branches below — those describe what is loaded, and this describes whether
  // it can be reached, which is the more urgent of the two.
  //
  // The copy is the careful part. Three different situations land here — a
  // breakpoint the user is holding, an ESC pause, and a briefing screen that has
  // not started yet — and the extension cannot tell them apart, because the
  // bridge cannot either (its own message says the queue has not been drained
  // rather than naming a cause, for exactly this reason). So the text claims
  // only the thing common to all three: the sim is not running its callbacks.
  // "Paused" would be wrong on a briefing screen and "paused by you" wrong at
  // two of the three; "not responding" would say something is broken, when in
  // fact the bridge is answering and serves again on the very next frame.
  //
  // The sim clock is deliberately dropped here even though a stale one is
  // available. A frozen number ticking nowhere beside a live-looking status is
  // precisely the symptom card 04 predicted, and the state itself is the honest
  // version of what that number was trying to say.
  if (combinedState(s) === "stalled") {
    return {
      text: "$(debug-pause) DCS: sim idle",
      tooltip:
        "The bridge is connected but DCS is not running the sim callbacks that serve it — paused, on a briefing screen, or held at a breakpoint. " +
        "Nothing is broken: calls fail fast until it resumes, and it serves again on the very next frame. Click for the Lua console.",
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
