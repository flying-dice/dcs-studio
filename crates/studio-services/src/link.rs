// Shared editor<->DCS link state (model/studio/link.pds + studio/mcp.pds):
// owns the dcs-bridge-client handle plus the sim-running / latency snapshot.
// The Tauri app's DcsState wraps this and its heartbeat writes through it;
// the headless MCP server dials it lazily on the first DCS tool call.
//
// The 30s per-call guard (model CALL_TIMEOUT_SECONDS) is enforced inside
// `DcsClient::call` itself — every caller of `call` inherits it.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use dcs_bridge_client::client::DcsClient;
use dcs_bridge_client::protocol::{PongResult, METHOD_PING};

/// The in-DCS bridge's WebSocket endpoint.
pub const DCS_WS_URL: &str = "ws://127.0.0.1:25569/ws";
/// Seconds between heartbeat pings while connected (model HEARTBEAT_SECONDS).
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(2);
/// Per-ping guard so a stalled bridge can't wedge a status probe or the
/// heartbeat loop (model PING_TIMEOUT_SECONDS). The bridge answers from boot
/// (menu included), so this rarely fires while connected.
pub const PING_TIMEOUT: Duration = Duration::from_secs(3);
/// Sentinel for "no latency measured yet".
pub const LATENCY_UNKNOWN: u32 = u32::MAX;
/// First-dial grace: how long the lazy dial waits for the WS handshake
/// before answering from the (still disconnected) link. With a live bridge
/// the local handshake completes in milliseconds; without DCS the wait
/// simply expires and the caller sees connected:false.
const CONNECT_GRACE: Duration = Duration::from_secs(1);

/// Shared link state. The client is filled in by whoever starts the link
/// (the app's setup hook, or [`LinkShared::ensure_client`] in headless
/// hosts), so calls treat it as optional until then.
pub struct LinkShared {
    client: OnceLock<DcsClient>,
    sim_running: AtomicBool,
    latency_ms: AtomicU32,
}

impl Default for LinkShared {
    fn default() -> Self {
        LinkShared {
            client: OnceLock::new(),
            sim_running: AtomicBool::new(false),
            latency_ms: AtomicU32::new(LATENCY_UNKNOWN),
        }
    }
}

impl LinkShared {
    /// Adopt an already-connected client (the app creates it on its async
    /// runtime at setup). A second start is a no-op — the first client wins.
    pub fn init_client(&self, client: DcsClient) {
        let _ = self.client.set(client);
    }

    /// Record one heartbeat sample; `None` latency means "unmeasured" (the
    /// ping failed or the link is down).
    pub fn record_heartbeat(&self, sim_running: bool, latency_ms: Option<u32>) {
        self.sim_running.store(sim_running, Ordering::Relaxed);
        self.latency_ms
            .store(latency_ms.unwrap_or(LATENCY_UNKNOWN), Ordering::Relaxed);
    }

    /// Dial `url` lazily: the first call connects (waiting up to
    /// CONNECT_GRACE for the handshake so a live bridge answers
    /// immediately); later calls reuse the link. Must run inside a tokio
    /// runtime — `DcsClient::connect` spawns its manager task.
    pub async fn ensure_client(&self, url: &str) -> DcsClient {
        if let Some(client) = self.client.get() {
            return client.clone();
        }
        let client = DcsClient::connect(url);
        let mut connected = client.connected_watch();
        let _ = tokio::time::timeout(CONNECT_GRACE, connected.wait_for(|up| *up)).await;
        // A racing first dial may have won the OnceLock; adopt ours if the cell is
        // still empty, then return whichever client is stored — our just-built one
        // is the fallback for the impossible empty-cell case, never a panic.
        let _ = self.client.set(client.clone());
        self.client.get().cloned().unwrap_or(client)
    }

    /// Forward an arbitrary JSON-RPC call to the in-DCS bridge. Guard: a
    /// link that was never started answers "DCS link not started"; a started
    /// but disconnected link surfaces the client's not-connected error.
    pub async fn call(&self, method: &str, params: Option<Value>) -> Result<Value, String> {
        let client = self
            .client
            .get()
            .cloned()
            .ok_or_else(|| "DCS link not started".to_string())?;
        client
            .call(method, params)
            .await
            .map_err(|e| e.to_string())
    }

    /// Snapshot of the link state, for late-mounting frontends that missed
    /// events (the app's `dcs_status` command).
    pub fn status(&self) -> Value {
        let connected = self
            .client
            .get()
            .map(|c| c.is_connected())
            .unwrap_or(false);
        let latency = self.latency_ms.load(Ordering::Relaxed);
        json!({
            "connected": connected,
            "sim_running": self.sim_running.load(Ordering::Relaxed),
            "latency_ms": if latency == LATENCY_UNKNOWN { Value::Null } else { json!(latency) },
        })
    }

    /// On-demand probe (the MCP `dcs_status` tool): ping the bridge once and
    /// derive sim-running from the pong's `dcs_time` advancing past 0 — the
    /// established rule; the bridge pongs from the main menu too, so ping
    /// success alone proves nothing. Works without DCS: an unstarted or
    /// disconnected link answers `connected: false` instead of erroring.
    pub async fn status_live(&self) -> Value {
        let disconnected = json!({
            "connected": false,
            "sim_running": false,
            "latency_ms": Value::Null,
        });
        let Some(client) = self.client.get().cloned() else {
            return disconnected;
        };
        if !client.is_connected() {
            self.record_heartbeat(false, None);
            return disconnected;
        }
        let started = Instant::now();
        match tokio::time::timeout(PING_TIMEOUT, client.call(METHOD_PING, None)).await {
            Ok(Ok(result)) => {
                let ms = started.elapsed().as_millis().min(u128::from(u32::MAX - 1)) as u32;
                let dcs_time = serde_json::from_value::<PongResult>(result)
                    .map(|pong| pong.dcs_time)
                    .unwrap_or(0.0);
                // A mission is live only once DCS.getModelTime() passes 0.
                let sim = dcs_time > 0.0;
                self.record_heartbeat(sim, Some(ms));
                json!({
                    "connected": true,
                    "sim_running": sim,
                    "latency_ms": ms,
                    "dcs_time": dcs_time,
                })
            }
            // No pong within the guard (or a call error): bridge not
            // answering. Still connected at the WS layer.
            Ok(Err(_)) | Err(_) => {
                self.record_heartbeat(false, None);
                json!({
                    "connected": true,
                    "sim_running": false,
                    "latency_ms": Value::Null,
                })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn call_without_a_started_link_fails_with_the_guard() {
        let link = LinkShared::default();
        let err = link
            .call("ping", None)
            .await
            .expect_err("unstarted link must not call");
        assert_eq!(err, "DCS link not started");
    }

    #[test]
    fn status_before_start_is_disconnected_with_unknown_latency() {
        let link = LinkShared::default();
        let status = link.status();
        assert_eq!(status["connected"], json!(false));
        assert_eq!(status["sim_running"], json!(false));
        assert_eq!(status["latency_ms"], Value::Null);
    }

    #[tokio::test]
    async fn status_live_without_a_client_reports_disconnected() {
        let link = LinkShared::default();
        let status = link.status_live().await;
        assert_eq!(status["connected"], json!(false));
        assert_eq!(status["sim_running"], json!(false));
    }

    #[tokio::test]
    async fn lazily_dialed_dead_endpoint_stays_disconnected_and_calls_fail() {
        let link = LinkShared::default();
        // Nothing listens here; the grace expires and the link stays down.
        let client = link.ensure_client("ws://127.0.0.1:59999/ws").await;
        assert!(!client.is_connected());

        let status = link.status_live().await;
        assert_eq!(status["connected"], json!(false));

        let err = link
            .call("eval", Some(json!({ "code": "return 1" })))
            .await
            .expect_err("dead endpoint must not answer");
        assert!(err.contains("not connected to DCS"), "err was: {err}");
    }

    #[tokio::test]
    async fn status_live_on_a_disconnected_link_clears_a_stale_sample() {
        let link = LinkShared::default();
        let _ = link.ensure_client("ws://127.0.0.1:59997/ws").await;
        // A stale "mission live" sample from before the disconnect…
        link.record_heartbeat(true, Some(9));

        let live = link.status_live().await;
        assert_eq!(live["connected"], json!(false));

        // …must be cleared by the probe, not left to lie in status().
        let snapshot = link.status();
        assert_eq!(snapshot["sim_running"], json!(false));
        assert_eq!(snapshot["latency_ms"], Value::Null);
    }

    #[test]
    fn heartbeat_samples_write_through() {
        let link = LinkShared::default();
        link.record_heartbeat(true, Some(12));
        let up = link.status();
        assert_eq!(up["sim_running"], json!(true));
        assert_eq!(up["latency_ms"], json!(12));

        link.record_heartbeat(false, None);
        let down = link.status();
        assert_eq!(down["sim_running"], json!(false));
        assert_eq!(down["latency_ms"], Value::Null);
    }
}
