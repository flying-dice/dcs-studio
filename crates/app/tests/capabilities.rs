//! Capability-manifest guard for the binary placeholder's OS actions.
//!
//! `open_path` (the "Open in associated application" action) is scope-gated by
//! `tauri-plugin-opener`: the command runs `is_path_allowed`, and a *bare*
//! `"opener:allow-open-path"` flag grants it with an EMPTY scope — so every
//! path is rejected (`Error::ForbiddenPath`) and the button is dead on arrival.
//!
//! The e2e suite (`pnpm test:lang`) runs without Tauri and no-ops both OS
//! actions via `isTauri()`, so it can only prove the buttons are click-safe —
//! never that the scope is real. This test is the layer that suite can't reach:
//! it pins the shipped capability to the *scoped object* form with a non-empty
//! `path` allow-list, so a flag-without-scope can't ship green again.
//!
//! `reveal_item_in_dir` (the "Open in Explorer" action) is deliberately NOT
//! asserted: in opener 2.5.4 that command takes only `paths` and is not
//! scope-checked, so `opener:default` alone makes it work and there is no scope
//! to declare.

use serde_json::Value;

/// Embedded at compile time so the test pins the real shipped artifact with no
/// runtime working-directory assumptions.
const DEFAULT_CAPABILITY: &str = include_str!("../capabilities/default.json");

#[test]
fn open_path_permission_declares_a_non_empty_path_scope() {
    let capability: Value =
        serde_json::from_str(DEFAULT_CAPABILITY).expect("default.json is valid JSON");
    let permissions = capability["permissions"]
        .as_array()
        .expect("capability declares a permissions array");

    // A bare-string `opener:allow-open-path` is the exact regression: it enables
    // the command with no scope, so open_path forbids every path.
    assert!(
        !permissions
            .iter()
            .any(|p| p.as_str() == Some("opener:allow-open-path")),
        "opener:allow-open-path is a bare flag (empty scope) — open_path would reject every path"
    );

    let open_path = permissions
        .iter()
        .find(|p| p.get("identifier").and_then(Value::as_str) == Some("opener:allow-open-path"))
        .expect("opener:allow-open-path permission present in object form");

    let allow = open_path
        .get("allow")
        .and_then(Value::as_array)
        .expect("opener:allow-open-path declares an `allow` scope");

    assert!(
        !allow.is_empty(),
        "opener:allow-open-path scope is empty — open_path rejects every path"
    );
    assert!(
        allow
            .iter()
            .all(|entry| entry
                .get("path")
                .and_then(Value::as_str)
                .is_some_and(|glob| !glob.is_empty())),
        "every open-path scope entry must declare a non-empty `path` glob"
    );
}
