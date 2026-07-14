//! Build a conformant [OpenRPC](https://spec.open-rpc.org/) document from the
//! router's registered methods. This is what `rpc.discover` returns (the
//! `OpenRPC` standard defines `rpc.discover` → the service's `OpenRPC` document),
//! and what the per-cdylib golden tests pin — generated from the exact method
//! set the DLL registers, never handcrafted.
//!
//! The document is deterministic (methods sorted by name) so a checked-in
//! golden can equal the live output byte-for-byte, and it validates against the
//! vendored official `OpenRPC` meta-schema (see `tests/openrpc_meta_schema.rs`).

use crate::jsonrpc::router::{MethodMeta, ParamMeta, ResultMeta};
use serde_json::{json, Map, Value};

/// The `OpenRPC` specification version this document conforms to.
pub const OPENRPC_VERSION: &str = "1.3.2";

/// Map a bridge param/result `type` string to a JSON-Schema `type`. An unknown
/// or absent type yields an empty schema (`{}`, "any"), which is valid `OpenRPC`.
fn schema_for_type(ty: Option<&str>) -> Value {
    let json_type = match ty {
        Some("string") => "string",
        Some("number") => "number",
        Some("integer") => "integer",
        Some("boolean") => "boolean",
        Some("array") => "array",
        Some("table" | "object") => "object",
        _ => return json!({}),
    };
    json!({ "type": json_type })
}

/// Build one `OpenRPC` content descriptor for a parameter.
fn param_descriptor(p: &ParamMeta) -> Value {
    let mut obj = Map::new();
    obj.insert("name".into(), json!(p.name));
    if let Some(required) = p.required {
        obj.insert("required".into(), json!(required));
    }
    if let Some(description) = &p.description {
        obj.insert("description".into(), json!(description));
    }
    obj.insert("schema".into(), schema_for_type(p.ty.as_deref()));
    Value::Object(obj)
}

/// Build the `OpenRPC` `result` content descriptor for a method, defaulting to a
/// permissive `{ name: "result", schema: {} }` when the registration gave none.
fn result_descriptor(result: Option<&ResultMeta>) -> Value {
    let mut obj = Map::new();
    let name = result
        .and_then(|r| r.name.as_deref())
        .unwrap_or("result")
        .to_string();
    obj.insert("name".into(), json!(name));
    if let Some(description) = result.and_then(|r| r.description.as_deref()) {
        obj.insert("description".into(), json!(description));
    }
    obj.insert(
        "schema".into(),
        schema_for_type(result.and_then(|r| r.ty.as_deref())),
    );
    Value::Object(obj)
}

/// Build one `OpenRPC` method object from its metadata.
fn method_object(name: &str, meta: &MethodMeta) -> Value {
    let mut obj = Map::new();
    obj.insert("name".into(), json!(name));
    if let Some(summary) = &meta.summary {
        obj.insert("summary".into(), json!(summary));
    }
    if let Some(description) = &meta.description {
        obj.insert("description".into(), json!(description));
    }
    let params: Vec<Value> = meta
        .params
        .as_deref()
        .unwrap_or_default()
        .iter()
        .map(param_descriptor)
        .collect();
    obj.insert("params".into(), Value::Array(params));
    obj.insert("result".into(), result_descriptor(meta.result.as_ref()));
    Value::Object(obj)
}

/// The spec-mandated `rpc.discover` method entry (its result is the `OpenRPC`
/// document itself). Appended so the document self-describes the discovery call.
fn discover_method_object() -> Value {
    json!({
        "name": "rpc.discover",
        "summary": "Returns this OpenRPC document.",
        "description": "The OpenRPC service description for this bridge — every JSON-RPC method it serves, with parameters and results. Per the OpenRPC spec, rpc.discover returns the service's OpenRPC document.",
        "params": [],
        "result": {
            "name": "OpenRPC Schema",
            "description": "The OpenRPC document describing this bridge.",
            "schema": { "type": "object" }
        }
    })
}

/// Assemble the whole `OpenRPC` document for a bridge.
///
/// `methods` is the router's `methods_sorted()` output; the synthetic
/// `rpc.discover` entry is appended and the final list re-sorted so the document
/// is fully deterministic.
pub fn build_document(
    title: &str,
    version: &str,
    env: &str,
    host: &str,
    port: u16,
    methods: &[(&str, &MethodMeta)],
) -> Value {
    let mut method_objects: Vec<Value> = methods
        .iter()
        .map(|(name, meta)| method_object(name, meta))
        .collect();
    method_objects.push(discover_method_object());
    method_objects.sort_by(|a, b| {
        a.get("name")
            .and_then(Value::as_str)
            .cmp(&b.get("name").and_then(Value::as_str))
    });

    json!({
        "openrpc": OPENRPC_VERSION,
        "info": {
            "title": title,
            "version": version,
            "description": format!("In-DCS DCS Studio JSON-RPC bridge for the {env} environment."),
            "x-dcs-env": env,
        },
        "servers": [
            { "name": "rpc", "url": format!("http://{host}:{port}/rpc") },
            { "name": "ws", "url": format!("ws://{host}:{port}/ws") },
        ],
        "methods": method_objects,
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // idiomatic in tests
mod tests {
    use super::*;

    fn meta(summary: &str) -> MethodMeta {
        MethodMeta {
            summary: Some(summary.to_string()),
            ..MethodMeta::default()
        }
    }

    #[test]
    fn schema_maps_known_types_and_defaults_to_any() {
        assert_eq!(schema_for_type(Some("string")), json!({"type": "string"}));
        assert_eq!(schema_for_type(Some("table")), json!({"type": "object"}));
        assert_eq!(schema_for_type(Some("mystery")), json!({}));
        assert_eq!(schema_for_type(None), json!({}));
    }

    #[test]
    fn result_defaults_when_absent() {
        let d = result_descriptor(None);
        assert_eq!(d["name"], "result");
        assert_eq!(d["schema"], json!({}));

        let d = result_descriptor(Some(&ResultMeta {
            name: Some("value".into()),
            ty: Some("number".into()),
            description: Some("the number".into()),
        }));
        assert_eq!(d["name"], "value");
        assert_eq!(d["schema"], json!({"type": "number"}));
        assert_eq!(d["description"], "the number");
    }

    #[test]
    fn param_descriptor_has_name_and_schema_always() {
        let p = param_descriptor(&ParamMeta {
            name: "code".into(),
            ty: None,
            required: Some(true),
            description: None,
        });
        assert_eq!(p["name"], "code");
        assert_eq!(p["required"], true);
        assert_eq!(p["schema"], json!({})); // absent type → permissive schema
    }

    #[test]
    fn document_has_required_top_level_shape_and_sorted_methods() {
        let methods = [("ping", &meta("Liveness")), ("eval", &meta("Run Lua"))];
        let refs: Vec<(&str, &MethodMeta)> = methods.iter().map(|(n, m)| (*n, *m)).collect();
        let doc = build_document("dcs-studio-gui", "0.2.0", "gui", "127.0.0.1", 25569, &refs);

        assert_eq!(doc["openrpc"], OPENRPC_VERSION);
        assert_eq!(doc["info"]["title"], "dcs-studio-gui");
        assert_eq!(doc["info"]["version"], "0.2.0");
        assert_eq!(doc["info"]["x-dcs-env"], "gui");
        assert_eq!(doc["servers"][0]["url"], "http://127.0.0.1:25569/rpc");
        assert_eq!(doc["servers"][1]["url"], "ws://127.0.0.1:25569/ws");

        let names: Vec<&str> = doc["methods"]
            .as_array()
            .expect("methods array")
            .iter()
            .map(|m| m["name"].as_str().expect("name"))
            .collect();
        // Sorted, with the synthetic rpc.discover entry present.
        assert_eq!(names, vec!["eval", "ping", "rpc.discover"]);
        // Every method carries params + result content descriptors.
        for m in doc["methods"].as_array().expect("methods") {
            assert!(m["params"].is_array(), "params array on {}", m["name"]);
            assert!(m["result"]["name"].is_string(), "result on {}", m["name"]);
        }
    }
}
