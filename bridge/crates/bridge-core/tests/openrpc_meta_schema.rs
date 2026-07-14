#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)] // idiomatic in tests

//! The `OpenRPC` document `rpc.discover` returns is a conformant `OpenRPC` 1.3.2
//! document — validated here against the **official** `OpenRPC` meta-schema.
//!
//! The vendored fixture `tests/fixtures/openrpc-meta-schema.json` is the
//! released `@open-rpc/meta-schema` document with its one external
//! `$ref: "https://meta.json-schema.tools"` bundled in-line (the referenced
//! JSON Schema meta-schema is inlined under `definitions.jsonSchemaMeta__*` and
//! the ref repointed), so validation is offline and deterministic. Its
//! top-level `$schema` is normalised to draft-07 (the draft it is written in)
//! so the validator selects the dialect without a network lookup.
//!
//! Like the rest of the mlua-backed suite this is gated on Windows (needs DCS's
//! `lua.dll` on PATH; run with `-- --include-ignored`); on Linux CI it runs as
//! an ordinary test.

use dcs_bridge_core::{emit_openrpc_json, BridgeKind};

const META_SCHEMA: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/openrpc-meta-schema.json"
));

fn assert_valid_openrpc(kind: BridgeKind) {
    let schema: serde_json::Value =
        serde_json::from_str(META_SCHEMA).expect("meta-schema is valid JSON");
    let validator = jsonschema::validator_for(&schema).expect("compile meta-schema");

    let doc_json =
        emit_openrpc_json(kind, env!("CARGO_PKG_VERSION")).expect("generate openrpc doc");
    let doc: serde_json::Value =
        serde_json::from_str(&doc_json).expect("openrpc doc is valid JSON");

    let errors: Vec<String> = validator.iter_errors(&doc).map(|e| e.to_string()).collect();
    assert!(
        errors.is_empty(),
        "{} OpenRPC document failed the official meta-schema:\n{}",
        kind.service_name(),
        errors.join("\n")
    );
}

#[test]
#[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
fn gui_openrpc_document_is_meta_schema_valid() {
    assert_valid_openrpc(BridgeKind::Gui);
}

#[test]
#[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
fn mission_openrpc_document_is_meta_schema_valid() {
    assert_valid_openrpc(BridgeKind::Mission);
}
