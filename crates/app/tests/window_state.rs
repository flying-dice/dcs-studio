#![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing, clippy::panic, clippy::print_stdout, clippy::print_stderr)] // integration test crate: test code, exempt from the production safety lints

//! Window-state coverage (issue #24, refs #23/!8). The plugin's actual OS-level
//! geometry read/write (resize/move → quit → relaunch sticks) is GUI-runtime
//! behaviour that needs a display/tauri-driver runner — unrunnable on the
//! headless shared CI (the issue's residual, to fold into the #7 tauri-driver
//! harness). What IS headless-testable, and pinned here, is the contract those
//! GUI scenarios depend on: the window-state plugin is wired (so save/restore
//! happens at all), and the config default geometry is the documented restore
//! fallback (1280×800) — the "delete the state file → falls back to config
//! default" half. A regression to either now fails the CI `app` job instead of
//! only surfacing under a manual GUI smoke.

use serde_json::Value;

const CONF: &str = include_str!("../tauri.conf.json");
const LIB_RS: &str = include_str!("../src/lib.rs");

#[test]
fn config_default_window_is_the_documented_restore_fallback() {
    let conf: Value = serde_json::from_str(CONF).expect("tauri.conf.json parses");
    let windows = conf["app"]["windows"]
        .as_array()
        .expect("app.windows array");
    assert_eq!(windows.len(), 1, "exactly one configured window");
    let main = &windows[0];
    assert_eq!(main["title"].as_str(), Some("dcs-studio"));
    // The restore fallback the plugin uses when no state file exists. Issue #24
    // names 1280×800 explicitly; changing it silently breaks that contract.
    assert_eq!(main["width"].as_i64(), Some(1280), "default width");
    assert_eq!(main["height"].as_i64(), Some(800), "default height");
}

#[test]
fn window_state_plugin_is_registered_on_the_builder() {
    // Save/restore exists only because the plugin is REGISTERED on the Tauri
    // builder. Assert the actual `.plugin(tauri_plugin_window_state::…)` call in
    // lib.rs — not merely the Cargo dependency — so unwiring it (the silent way
    // to disable persistence) fails CI, not just deleting the dep.
    let registered = LIB_RS
        .lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .any(|l| l.contains(".plugin(tauri_plugin_window_state::"));
    assert!(
        registered,
        "tauri_plugin_window_state must be registered on the builder in lib.rs"
    );
}
