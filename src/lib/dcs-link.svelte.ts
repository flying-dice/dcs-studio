// The live DCS-link status + its heartbeat (model studio::link `DcsLink`),
// extracted from AppState so the app store isn't both global UI state and a
// link-polling engine. Inside Tauri it relays the Rust-side heartbeat events
// (crates/app/src/dcs.rs); outside Tauri (vite dev / Playwright) there are no
// Rust events, so it self-drives from a browser-side ping heartbeat over the
// bridge WS. The app store re-exposes these fields via `app.dcsConnected` etc.
// (read-only proxies) so the status bar reads them unchanged.

import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { dcsCall, dcsStatus } from "./api";
import { wsConnected } from "./dcs-ws";

class DcsLink {
  // `connected` = WS to the bridge is up (DCS may still be in the menu);
  // `simRunning` = pings are ponging, i.e. a mission is actually running.
  connected = $state(false);
  simRunning = $state(false);
  latencyMs = $state<number | null>(null);
  time = $state<number | null>(null);
  private initialised = false;

  /** Subscribe to the DCS link heartbeat. Called once from the root layout. */
  async init(): Promise<void> {
    if (this.initialised) return;
    this.initialised = true;

    if (!isTauri()) {
      this.startBrowserHeartbeat();
      return;
    }
    await this.listenToLinkEvents();
    await this.seedFromBackendSnapshot();
  }

  /**
   * Outside Tauri (vite dev / Playwright) there are no Rust-side events:
   * drive the status from a browser-side ping heartbeat over the bridge WS.
   */
  private startBrowserHeartbeat() {
    const beat = async () => {
      const started = performance.now();
      try {
        const pong = (await dcsCall("ping")) as { dcs_time?: number } | null;
        // Same rule as the Rust heartbeat (dcs.rs): the bridge pongs from
        // the main menu too; a mission is live only once dcs_time > 0.
        const dcsTime = typeof pong?.dcs_time === "number" ? pong.dcs_time : 0;
        this.connected = true;
        this.simRunning = dcsTime > 0;
        this.time = dcsTime;
        this.latencyMs = Math.round(performance.now() - started);
      } catch {
        this.connected = wsConnected();
        this.simRunning = false;
        this.latencyMs = null;
        this.time = null;
      }
    };
    void beat();
    setInterval(() => void beat(), 2000);
  }

  /** Relay the Rust-side link events into the reactive fields. */
  private async listenToLinkEvents() {
    await listen("dcs://connected", () => {
      this.connected = true;
    });
    await listen("dcs://disconnected", () => {
      this.connected = false;
      this.simRunning = false;
      this.latencyMs = null;
      this.time = null;
    });
    await listen<{ sim_running: boolean; latency_ms?: number; dcs_time?: number }>(
      "dcs://heartbeat",
      (e) => {
        this.simRunning = e.payload.sim_running;
        this.latencyMs = e.payload.latency_ms ?? null;
        this.time = e.payload.dcs_time ?? null;
      },
    );
  }

  /**
   * Seed from the backend snapshot to cover events emitted before we
   * started listening (the heartbeat starts with the app, not the UI).
   */
  private async seedFromBackendSnapshot() {
    try {
      const s = await dcsStatus();
      this.connected = s.connected;
      this.simRunning = s.sim_running;
      this.latencyMs = s.latency_ms;
    } catch {
      /* backend not ready yet — events will catch us up */
    }
  }
}

/** Singleton — the one live link status the app store proxies and the UI reads. */
export const dcsLink = new DcsLink();
