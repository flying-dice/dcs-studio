//! Editor-side WebSocket JSON-RPC client (feature `client`).
//!
//! [`DcsClient::connect`] spawns a background manager task that dials the
//! bridge's `ws://…/ws` endpoint, retrying with exponential backoff (the
//! editor often starts before DCS). A single read loop correlates responses
//! to in-flight requests via an `id -> oneshot` map. Connection state is
//! exposed through a `tokio::sync::watch<bool>`.
//!
//! Liveness polling (`GET /health`) is intentionally **not** handled here —
//! the app layer does that.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot, watch};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use crate::protocol::{JsonRpcRequest, JsonRpcResponse, JSON_RPC_VERSION};

const INITIAL_BACKOFF: Duration = Duration::from_millis(500);
const MAX_BACKOFF: Duration = Duration::from_secs(10);
/// Client-side guard so a `call` can never wedge forever; the bridge hook is
/// expected to use a much shorter server-side timeout.
const CALL_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, thiserror::Error)]
pub enum DcsError {
    #[error("not connected to DCS")]
    NotConnected,
    #[error("websocket error: {0}")]
    WebSocket(#[from] tokio_tungstenite::tungstenite::Error),
    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("connection closed before a response was received")]
    ConnectionClosed,
    #[error("request timed out")]
    Timeout,
    #[error("rpc error: {0}")]
    Rpc(Value),
}

struct Command {
    id: String,
    request: JsonRpcRequest,
    reply: oneshot::Sender<Result<JsonRpcResponse, DcsError>>,
}

/// Handle to the background connection manager. Cheap to clone.
#[derive(Clone)]
pub struct DcsClient {
    cmd_tx: mpsc::Sender<Command>,
    connected_rx: watch::Receiver<bool>,
    next_id: Arc<AtomicU64>,
}

impl DcsClient {
    /// Spawn the connection manager for `url` (e.g. `ws://127.0.0.1:25569/ws`)
    /// and return immediately. The manager keeps retrying with backoff until
    /// every clone of the returned client is dropped.
    ///
    /// Must be called from within a tokio runtime.
    pub fn connect(url: &str) -> DcsClient {
        let (cmd_tx, cmd_rx) = mpsc::channel(16);
        let (connected_tx, connected_rx) = watch::channel(false);

        tokio::spawn(manager(url.to_string(), cmd_rx, connected_tx));

        DcsClient {
            cmd_tx,
            connected_rx,
            next_id: Arc::new(AtomicU64::new(1)),
        }
    }

    /// Watch channel that flips to `true` while the WebSocket is up.
    pub fn connected_watch(&self) -> watch::Receiver<bool> {
        self.connected_rx.clone()
    }

    /// Current connection state.
    pub fn is_connected(&self) -> bool {
        *self.connected_rx.borrow()
    }

    /// Send a JSON-RPC request and await the matching response.
    ///
    /// Ids are generated from an incrementing counter and always serialized
    /// as **strings** — the bridge's serde rejects numeric ids. A response
    /// carrying an `error` member is mapped to [`DcsError::Rpc`].
    pub async fn call(&self, method: &str, params: Option<Value>) -> Result<Value, DcsError> {
        if !self.is_connected() {
            return Err(DcsError::NotConnected);
        }

        let id = self.next_id.fetch_add(1, Ordering::Relaxed).to_string();
        let request = JsonRpcRequest {
            jsonrpc: JSON_RPC_VERSION.to_string(),
            method: method.to_string(),
            id: Some(id.clone()),
            params,
        };

        let (reply_tx, reply_rx) = oneshot::channel();
        self.cmd_tx
            .send(Command {
                id,
                request,
                reply: reply_tx,
            })
            .await
            .map_err(|_| DcsError::ConnectionClosed)?;

        let response = tokio::time::timeout(CALL_TIMEOUT, reply_rx)
            .await
            .map_err(|_| DcsError::Timeout)?
            .map_err(|_| DcsError::ConnectionClosed)??;

        if let Some(error) = response.error {
            return Err(DcsError::Rpc(error));
        }
        Ok(response.result.unwrap_or(Value::Null))
    }
}

async fn manager(
    url: String,
    mut cmd_rx: mpsc::Receiver<Command>,
    connected_tx: watch::Sender<bool>,
) {
    let mut backoff = INITIAL_BACKOFF;
    loop {
        match connect_async(&url).await {
            Ok((ws, _)) => {
                backoff = INITIAL_BACKOFF;
                let _ = connected_tx.send(true);
                let keep_running = run_connection(ws, &mut cmd_rx).await;
                let _ = connected_tx.send(false);
                if !keep_running {
                    return; // all client handles dropped
                }
            }
            Err(_) => {
                // Fail anything that raced in while we were disconnected.
                while let Ok(cmd) = cmd_rx.try_recv() {
                    let _ = cmd.reply.send(Err(DcsError::NotConnected));
                }
                if cmd_rx.is_closed() {
                    return;
                }
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(MAX_BACKOFF);
            }
        }
    }
}

/// Drive one live connection. Returns `true` if the manager should reconnect,
/// `false` if every client handle has been dropped.
async fn run_connection(
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
    cmd_rx: &mut mpsc::Receiver<Command>,
) -> bool {
    let (mut write, mut read) = ws.split();
    let mut pending: HashMap<String, oneshot::Sender<Result<JsonRpcResponse, DcsError>>> =
        HashMap::new();

    loop {
        tokio::select! {
            cmd = cmd_rx.recv() => {
                let Some(cmd) = cmd else {
                    // Client dropped: close politely and stop the manager.
                    let _ = write.send(Message::Close(None)).await;
                    return false;
                };
                // Only ever send well-formed JsonRpcRequest frames.
                let text = match serde_json::to_string(&cmd.request) {
                    Ok(text) => text,
                    Err(e) => {
                        let _ = cmd.reply.send(Err(DcsError::Serde(e)));
                        continue;
                    }
                };
                pending.insert(cmd.id.clone(), cmd.reply);
                if let Err(e) = write.send(Message::Text(text.into())).await {
                    if let Some(reply) = pending.remove(&cmd.id) {
                        let _ = reply.send(Err(DcsError::WebSocket(e)));
                    }
                    fail_all(&mut pending);
                    return true;
                }
            }
            msg = read.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        // tokio-tungstenite 0.26: text payloads are Utf8Bytes.
                        if let Ok(response) = serde_json::from_str::<JsonRpcResponse>(text.as_str()) {
                            if let Some(reply) = pending.remove(&response.id) {
                                let _ = reply.send(Ok(response));
                            }
                        }
                        // Unparseable or uncorrelated frames are ignored.
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        fail_all(&mut pending);
                        return true;
                    }
                    Some(Ok(_)) => {
                        // Binary/Ping/Pong/Frame: nothing to correlate
                        // (tungstenite queues protocol Pongs automatically).
                    }
                    Some(Err(_)) => {
                        fail_all(&mut pending);
                        return true;
                    }
                }
            }
        }
    }
}

fn fail_all(pending: &mut HashMap<String, oneshot::Sender<Result<JsonRpcResponse, DcsError>>>) {
    for (_, reply) in pending.drain() {
        let _ = reply.send(Err(DcsError::ConnectionClosed));
    }
}
