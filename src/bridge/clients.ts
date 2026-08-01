import * as vscode from "vscode";
import {
  bridgeForEnv,
  type DualBridgeStatus,
  INITIAL_DUAL_STATUS,
} from "../core/domain/bridgeProtocol";
import type { BridgeRouterPort } from "../core/ports/debugBridge";
import type { BridgeClient } from "./client";

// The two bridge clients as one unit: the GUI bridge (port 25569, always up
// while DCS runs) and the mission bridge (port 25570, up only during a
// mission). Thin shell — env routing is the pure `bridgeForEnv` rule, and the
// merged status stream just re-emits whenever either client's status changes.
//
// "A mission is running" is still inferred from `mission.connected`, and that
// is now sound for the mission-ended case: card 04 confirmed live that card
// 18's per-mission server stop closes :25570 at S_EVENT_MISSION_END, so the
// socket no longer outlives the mission and the status bar reads "DCS: at
// menu" correctly. #32's premise was overtaken by events and the issue closed.
//
// Where connectedness still is not liveness is a paused sim or the briefing
// screen — the state exists, the model-time pump does not run. That gap is now
// carried in the status itself rather than left to callers to infer: each
// client reads the bridge's own `-32002` refusals off the replies it already
// receives and reports `stalled`, which `combinedState`/`statusBarView` render
// as a state of their own. `/health`'s `pump_idle_ms`/`pump_stalled` say the
// same thing over HTTP and are the right probe for a script or a live session;
// the editor gets it from the WebSocket it is already holding.
export class BridgeClients implements BridgeRouterPort {
  constructor(
    readonly gui: BridgeClient,
    readonly mission: BridgeClient,
  ) {}

  /** The client that serves `env` (mission → mission bridge, else GUI). */
  forEnv(env: string): BridgeClient {
    return bridgeForEnv(env) === "mission" ? this.mission : this.gui;
  }

  get current(): DualBridgeStatus {
    return { gui: this.gui.current, mission: this.mission.current };
  }

  /** Merged status stream: fires with the dual status when EITHER bridge's
   * status changes (and once immediately, like BridgeClient.onStatus). */
  onStatus(fn: (s: DualBridgeStatus) => void): vscode.Disposable {
    // Each subscription fires immediately; seed once from INITIAL and let the
    // two immediate callbacks converge on the live value.
    let last: DualBridgeStatus = INITIAL_DUAL_STATUS;
    const emit = () => fn(last);
    const subGui = this.gui.onStatus((s) => {
      last = { ...last, gui: s };
      emit();
    });
    const subMission = this.mission.onStatus((s) => {
      last = { ...last, mission: s };
      emit();
    });
    return new vscode.Disposable(() => {
      subGui.dispose();
      subMission.dispose();
    });
  }

  start(): void {
    this.gui.start();
    this.mission.start();
  }

  /** Force an immediate reconnect attempt on both (e.g. after launching DCS). */
  reconnect(): void {
    this.gui.reconnect();
    this.mission.reconnect();
  }

  dispose(): void {
    this.gui.dispose();
    this.mission.dispose();
  }
}
