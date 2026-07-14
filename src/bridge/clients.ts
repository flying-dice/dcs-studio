import * as vscode from "vscode";
import {
  DualBridgeStatus,
  INITIAL_DUAL_STATUS,
  bridgeForEnv,
} from "../core/domain/bridgeProtocol";
import { BridgeClient } from "./client";

// The two bridge clients as one unit: the GUI bridge (port 25569, always up
// while DCS runs) and the mission bridge (port 25570, up only during a
// mission). Thin shell — env routing is the pure `bridgeForEnv` rule, and the
// merged status stream just re-emits whenever either client's status changes.
export class BridgeClients {
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
