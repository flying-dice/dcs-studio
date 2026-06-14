// Live editor↔DCS link: owns the dcs-bridge-client WebSocket client and drives
// the heartbeat that the frontend status bar listens to. The shared link state
// (client handle, sim-running, latency) lives in studio-services' LinkShared
// (issue #8) so the headless MCP server reuses the exact same guards; this
// module keeps the Tauri-specific parts — the event emits and the heartbeat
// schedule.
//
// Two independent signals:
// - "connected"  = the WS handshake to the in-DCS actix server is up. Sourced
//   from `DcsClient::connected_watch()` and surfaced as `dcs://connected` /
//   `dcs://disconnected`. The bridge accepts connections from the main menu, so
//   this only means the bridge DLL is loaded — not that a mission is running.
// - "sim running" = a mission is actually live. The bridge drains its RPC queue
//   on `onSimulationFrame`, which fires at the main menu too (verified live), so
//   a `ping` pongs from boot. What distinguishes a running mission is that
//   `DCS.getModelTime()` advances past 0 — so we derive sim-running from the
//   pong's `dcs_time`, NOT from whether the ping succeeded. Via `dcs://heartbeat`.

use std::sync::Arc;
use std::time::Instant;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use dcs_bridge_client::client::DcsClient;
use dcs_bridge_client::protocol::{PongResult, METHOD_PING};
use studio_services::link::{LinkShared, DCS_WS_URL, HEARTBEAT_INTERVAL, PING_TIMEOUT};

/// Managed by Tauri: a wrapper over the shared link state. The client is
/// filled in by [`start`] (it must be created on the async runtime), so
/// commands treat it as optional until then.
#[derive(Default)]
pub struct DcsState {
    link: Arc<LinkShared>,
}

impl DcsState {
    /// The shared, already-connected link — handed to the app-hosted MCP
    /// server (issue #33) so its DCS tools run on this one open connection.
    #[must_use]
    pub fn link(&self) -> Arc<LinkShared> {
        self.link.clone()
    }
}

/// Connect the client and spawn the connection watcher + heartbeat tasks.
/// Called once from the Tauri `.setup` hook.
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // `DcsClient::connect` spawns its manager with `tokio::spawn`, so it
        // must run inside the runtime — hence connecting here, not in setup.
        let client = DcsClient::connect(DCS_WS_URL);

        let state = app.state::<DcsState>();
        let link = state.link.clone();
        link.init_client(client.clone());

        // Connection watcher: relay WS up/down to the frontend. The first
        // iteration emits the current state once at startup.
        {
            let app = app.clone();
            let mut connected_rx = client.connected_watch();
            tauri::async_runtime::spawn(async move {
                loop {
                    let connected = *connected_rx.borrow_and_update();
                    let event = if connected {
                        "dcs://connected"
                    } else {
                        "dcs://disconnected"
                    };
                    let _ = app.emit(event, ());
                    if connected_rx.changed().await.is_err() {
                        return; // client dropped
                    }
                }
            });
        }

        // Heartbeat: one ping in flight, every ~2s while connected.
        let mut ticker = tokio::time::interval(HEARTBEAT_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            if !client.is_connected() {
                link.record_heartbeat(false, None);
                continue;
            }

            let started = Instant::now();
            match tokio::time::timeout(PING_TIMEOUT, client.call(METHOD_PING, None)).await {
                Ok(Ok(result)) => {
                    let ms = started.elapsed().as_millis().min(u128::from(u32::MAX - 1)) as u32;
                    let dcs_time = serde_json::from_value::<PongResult>(result)
                        .map(|pong| pong.dcs_time)
                        .unwrap_or(0.0);
                    // The bridge pongs at the main menu too; a mission is only
                    // live once DCS.getModelTime() (dcs_time) advances past 0.
                    let sim = dcs_time > 0.0;
                    link.record_heartbeat(sim, Some(ms));
                    let _ = app.emit(
                        "dcs://heartbeat",
                        &json!({ "sim_running": sim, "latency_ms": ms, "dcs_time": dcs_time }),
                    );
                }
                // No pong within the guard (or a call error): bridge not
                // answering. Still connected at the WS layer.
                Ok(Err(_)) | Err(_) => {
                    link.record_heartbeat(false, None);
                    let _ = app.emit("dcs://heartbeat", &json!({ "sim_running": false }));
                }
            }
        }
    });
}

/// Forward an arbitrary JSON-RPC call to the in-DCS bridge.
#[tauri::command]
pub async fn dcs_call(
    state: tauri::State<'_, DcsState>,
    method: String,
    params: Option<Value>,
) -> Result<Value, String> {
    state.link.call(&method, params).await
}

/// Snapshot of the link state, for late-mounting frontends that missed events.
#[tauri::command]
pub fn dcs_status(state: tauri::State<'_, DcsState>) -> Value {
    state.link.status()
}
