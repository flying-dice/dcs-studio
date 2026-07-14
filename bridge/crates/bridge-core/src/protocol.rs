//! JSON-RPC envelope types shared by the editor client and the in-DCS bridge.
//!
//! These deliberately match pelican's (slightly non-spec) wire shapes
//! (`pelican/src/jsonrpc/mod.rs`):
//! - request `id` is a **string or absent — never numeric**; a numeric id fails
//!   serde on the server and kills its WS read task,
//! - response `id` is a non-optional string,
//! - `result` / `error` / error `data` are omitted (not `null`) when absent.

use serde::{Deserialize, Serialize};

/// The JSON-RPC protocol version string in every envelope's `jsonrpc` field.
pub const JSON_RPC_VERSION: &str = "2.0";

/// <https://www.jsonrpc.org/specification#request_object>
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    pub method: String,
    pub id: Option<String>,
    pub params: Option<serde_json::Value>,
}

/// <https://www.jsonrpc.org/specification#response_object>
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    pub id: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<serde_json::Value>,
}

/// <https://www.jsonrpc.org/specification#error_object>
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct JsonRpcError {
    pub code: i32,
    pub message: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}
