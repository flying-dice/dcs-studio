//! Shared DCS link: JSON-RPC protocol types (both ends) and the editor-side
//! WebSocket client. The in-DCS bridge uses only `protocol`; the editor also
//! uses `client`.

pub mod client;
pub mod protocol;

pub use protocol::{
    JsonRpcError, JsonRpcRequest, JsonRpcResponse, PingParams, PongResult, JSON_RPC_VERSION,
    METHOD_PING,
};

pub use client::{DcsClient, DcsError};
