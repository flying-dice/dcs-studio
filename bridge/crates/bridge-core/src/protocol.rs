//! JSON-RPC envelope types shared by the editor client and the in-DCS bridge.
//!
//! These deliberately match pelican's (slightly non-spec) wire shapes
//! (`pelican/src/jsonrpc/mod.rs`):
//! - request `id` is a **string or absent — never numeric**; a numeric id fails
//!   serde on the server and kills its WS read task,
//! - response `id` is a non-optional string,
//! - `result` / `error` / error `data` are omitted (not `null`) when absent.

use serde::{Deserialize, Serialize};

pub const JSON_RPC_VERSION: &str = "2.0";

/// Method names understood by the in-DCS bridge.
pub const METHOD_PING: &str = "ping";

/// https://www.jsonrpc.org/specification#request_object
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    pub method: String,
    pub id: Option<String>,
    pub params: Option<serde_json::Value>,
}

impl JsonRpcRequest {
    /// A request without an `id` is a notification — the server will not reply.
    pub fn is_notification(&self) -> bool {
        self.id.is_none()
    }
}

/// https://www.jsonrpc.org/specification#response_object
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    pub id: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<serde_json::Value>,
}

/// https://www.jsonrpc.org/specification#error_object
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct JsonRpcError {
    pub code: i32,
    pub message: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

/// Result payload of [`METHOD_PING`].
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct PongResult {
    pub pong: bool,
    pub dcs_time: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_round_trips_with_string_id() {
        let request = JsonRpcRequest {
            jsonrpc: JSON_RPC_VERSION.to_string(),
            method: METHOD_PING.to_string(),
            id: Some("42".to_string()),
            params: Some(serde_json::json!([])),
        };

        let text = serde_json::to_string(&request).unwrap();
        let back: JsonRpcRequest = serde_json::from_str(&text).unwrap();
        assert_eq!(request, back);
        assert!(!back.is_notification());

        // The id must be a JSON string on the wire, never a number.
        let raw: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert!(raw["id"].is_string());
    }

    #[test]
    fn request_without_id_is_a_notification() {
        let request = JsonRpcRequest {
            jsonrpc: JSON_RPC_VERSION.to_string(),
            method: METHOD_PING.to_string(),
            id: None,
            params: None,
        };
        assert!(request.is_notification());

        let text = serde_json::to_string(&request).unwrap();
        let back: JsonRpcRequest = serde_json::from_str(&text).unwrap();
        assert_eq!(request, back);
        assert!(back.is_notification());
    }

    #[test]
    fn response_matches_pelican_wire_shape() {
        // Frame shape as produced by pelican's server (result-only — no `error` key).
        let frame = r#"{"jsonrpc":"2.0","id":"7","result":{"pong":true,"dcs_time":12.5}}"#;
        let response: JsonRpcResponse = serde_json::from_str(frame).unwrap();
        assert_eq!(response.id, "7");
        assert!(response.error.is_none());

        let pong: PongResult = serde_json::from_value(response.result.clone().unwrap()).unwrap();
        assert_eq!(
            pong,
            PongResult {
                pong: true,
                dcs_time: 12.5
            }
        );

        // Absent fields stay absent when re-serialized (skip_serializing_if).
        let text = serde_json::to_string(&response).unwrap();
        assert!(!text.contains("error"));
    }
}
