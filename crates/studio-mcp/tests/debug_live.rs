//! Live debugger-over-MCP round against a running DCS bridge. Gated on
//! `DCS_DEBUG_LIVE` (and a reachable bridge on 25569) so it never runs in normal
//! CI — it needs the in-sim `dcs_studio` debugger. Drives the full
//! set-breakpoint → run → pause/inspect → continue loop entirely through
//! `studio_mcp::handle`, proving the MCP debug tools control the in-sim
//! debugger end to end.

use serde_json::{json, Value};
use studio_mcp::{handle, Session};

const URL: &str = "ws://127.0.0.1:25569/ws";

fn call_tool(session: &Session, id: u64, name: &str, args: Value) -> Value {
    let msg = json!({
        "jsonrpc": "2.0", "id": id, "method": "tools/call",
        "params": { "name": name, "arguments": args }
    });
    handle(session, &msg).expect("a tool response")
}

/// The bridge result carried in the tool's text content, parsed back to JSON.
fn tool_inner(resp: &Value) -> Value {
    let text = resp["result"]["content"][0]["text"].as_str().unwrap_or("null");
    serde_json::from_str(text).unwrap_or(Value::Null)
}

#[test]
fn debug_over_mcp_drives_a_full_round() {
    if std::env::var("DCS_DEBUG_LIVE").is_err() {
        eprintln!("skipping: set DCS_DEBUG_LIVE=1 with DCS running to drive this");
        return;
    }

    let ctl = Session::with_bridge_url(URL.to_string());

    // Set a breakpoint at line 2 of source "=mcp", through MCP.
    let set = call_tool(
        &ctl,
        1,
        "debug_set_breakpoints",
        json!({ "source": "=mcp", "lines": [2] }),
    );
    assert_eq!(set["result"]["isError"], json!(false), "set_breakpoints: {set}");

    let listed = tool_inner(&call_tool(&ctl, 2, "debug_breakpoints", json!({})));
    assert!(listed.get("=mcp").is_some(), "registry lists =mcp: {listed}");

    // Fire debug_run on its own connection — it blocks while paused, pumping RPC.
    let run = std::thread::spawn(move || {
        let runner = Session::with_bridge_url(URL.to_string());
        let code = "local x = 41\nlocal y = x + 1\nreturn y";
        call_tool(&runner, 3, "debug_run", json!({ "source": "=mcp", "code": code }))
    });

    // Poll debug_state through MCP until the debugger reports paused.
    let mut paused = Value::Null;
    for _ in 0..40 {
        std::thread::sleep(std::time::Duration::from_millis(250));
        let state = tool_inner(&call_tool(&ctl, 4, "debug_state", json!({})));
        if state["paused"] == json!(true) {
            paused = state;
            break;
        }
    }
    assert_eq!(paused["paused"], json!(true), "debugger paused via MCP");
    // The snapshot is a JSON string of the call stack; the top frame is at line
    // 2 with a Locals scope ref.
    let snap: Value =
        serde_json::from_str(paused["snapshot"].as_str().unwrap_or("null")).unwrap_or(Value::Null);
    let top = &snap["frames"][0];
    assert_eq!(top["line"], json!(2), "paused at line 2: {snap}");
    let locals_ref = top["scopes"]
        .as_array()
        .and_then(|s| s.iter().find(|sc| sc["name"] == json!("Locals")))
        .map(|sc| sc["ref"].as_u64().unwrap_or(0))
        .unwrap_or(0);
    assert!(locals_ref > 0, "Locals scope has a ref: {top}");

    // Lazily expand the Locals scope through MCP and find `x = 41`.
    let vars = tool_inner(&call_tool(&ctl, 8, "debug_expand", json!({ "ref": locals_ref })));
    let x = vars["variables"]
        .as_array()
        .and_then(|a| a.iter().find(|v| v["name"] == json!("x")))
        .cloned()
        .unwrap_or(Value::Null);
    assert_eq!(x["value"], json!("41"), "local x = 41 via lazy expand: {vars}");

    // Resume through MCP, then collect the run result.
    let cont = call_tool(&ctl, 5, "debug_continue", json!({}));
    assert_eq!(cont["result"]["isError"], json!(false), "continue: {cont}");

    let run_resp = run.join().expect("run thread");
    let ran = tool_inner(&run_resp);
    assert_eq!(ran["ran"], json!(true), "run completed after resume: {ran}");

    let after = tool_inner(&call_tool(&ctl, 6, "debug_state", json!({})));
    assert_eq!(after["paused"], json!(false), "no longer paused");

    // Tidy the registry.
    call_tool(&ctl, 7, "debug_clear_breakpoints", json!({}));
}
