#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
// idiomatic in tests

//! Regression harness for the F5-to-first-stop latency bug (issue: pressing F5
//! took ~25-30s to reach the first debug stop, sim frozen the whole time).
//!
//! Root cause was in the shared JSON-RPC server (`bridge-core`): the WebSocket
//! read loop awaited each request's full response before reading the next frame
//! (head-of-line blocking). `debug_run` blocks bridge-side for the WHOLE debug
//! session — the sim thread's pump answers the editor's `debug_state` polls from
//! inside it — so with a serial read loop those polls sat UNREAD in the socket
//! until `debug_run`'s server-side request timeout (30s) fired, at which point
//! the already-reached breakpoint finally surfaced. Both bridges share this code,
//! so both envs were affected.
//!
//! This test drives the real engine + server exactly as the adapter does: it
//! stands up a bridge state (via `bootstrap`), wires a hook-shaped router with
//! `DBG.pump` serving this server's queue, runs a "sim thread" that pumps
//! `process_rpc` every frame, then over a real WebSocket sets a breakpoint,
//! fires `debug_run` WITHOUT awaiting it, and polls `debug_state` — asserting the
//! first paused snapshot arrives in well under 2s. Before the fix this blocks for
//! the full server timeout and fails; after it, the stop surfaces in ~one poll.
//!
//! Windows-gated like the rest of the suite: the test binary links DCS's own
//! lua.dll, so put it on PATH and run with `-- --include-ignored`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

mod support;

use support::{connect_ws, rpc, Ws};

use dcs_bridge_core::{bootstrap, BridgeKind};
use mlua::{Function, Lua};

const PORT: u16 = 27571;

// The debugged chunk: a breakpoint on line 1 must be hit on the run's first line
// event, so time-to-first-stop measures the transport, not execution.
const SCRIPT: &str = "local x = 1\nlocal y = x + 1\n";
const SOURCE: &str = "=harness.lua";

/// Stand up the bridge state, start its server, wire a hook-shaped router, and
/// pump `process_rpc` until told to stop — the "sim thread" (onSimulationFrame).
/// `debug_run` blocks this loop for the whole session; the engine's own re-entrant
/// pump (`DBG.pump`) serves the editor meanwhile, exactly as in DCS.
fn spawn_sim_thread(shutdown: Arc<AtomicBool>, ready: mpsc::Sender<()>) {
    std::thread::spawn(move || {
        // `unsafe_new` loads ALL standard libraries including `debug` — which the
        // engine needs and which the DCS Lua states have, but `Lua::new()` omits
        // as unsafe. This is a test harness, not the DLL.
        let lua = unsafe { Lua::unsafe_new() };
        let exports = bootstrap(&lua, BridgeKind::Gui, "test").expect("bootstrap");

        // A minimal DcsStudio.lua: bind the server, register the debug methods,
        // and wire the engine's pump to drain THIS server's queue.
        let glue = format!(
            r#"
local bridge = ...
local server = bridge.jsonrpc.JsonRpcServer.new({{ host = "127.0.0.1", port = {PORT}, timeout = 30, env = "gui" }})
local router = bridge.jsonrpc.JsonRpcRouter.new()
local DBG = assert(__DCS_STUDIO_DBG, "debug engine not installed")
DBG.pump = function() server:process_rpc(router) end
router:add_method("ping", function() return {{ pong = true }} end)
router:add_method("debug_set_breakpoints", function(p) return DBG.set_breakpoints(p) end)
router:add_method("debug_clear_breakpoints", function() return DBG.clear_breakpoints() end)
router:add_method("debug_run", function(p)
  return DBG.run((p and p.code) or "", (p and p.source) or "=debug", p and p.pause_on_error == true)
end)
router:add_method("debug_state", function() return DBG.state() end)
router:add_method("debug_continue", function(p)
  bridge.debug.request_resume((p and p.mode) or "continue"); return {{ ok = true }}
end)
router:add_method("debug_stop", function()
  bridge.debug.request_stop(); bridge.debug.request_resume("continue"); return {{ ok = true }}
end)
pump_once = function() server:process_rpc(router) end
"#
        );
        lua.load(&glue)
            .set_name("=harness_hook")
            .call::<()>(exports)
            .expect("wire hook");

        let pump: Function = lua.globals().get("pump_once").expect("pump_once");
        let _ = ready.send(());
        while !shutdown.load(Ordering::Relaxed) {
            pump.call::<()>(()).expect("pump");
            std::thread::sleep(Duration::from_millis(5));
        }
    });
}

#[test]
#[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
fn first_stop_is_prompt_while_run_blocks_the_sim() {
    let shutdown = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = mpsc::channel();
    spawn_sim_thread(shutdown.clone(), ready_tx);
    ready_rx
        .recv_timeout(Duration::from_secs(10))
        .expect("sim thread ready");

    // The actix server binds asynchronously in its own thread — retry the connect.
    let mut ws = connect_ws(PORT);

    // The adapter awaits the breakpoint set before firing the run — mirror that.
    ws.send(&rpc(
        "bp",
        "debug_set_breakpoints",
        &format!(r#"{{"source":"{SOURCE}","breakpoints":[{{"line":1}}]}}"#),
    ))
    .unwrap();
    wait_for_id(&mut ws, "bp", Duration::from_secs(5));

    // Fire the run and DO NOT await it (it blocks for the whole session), then
    // poll debug_state exactly like the adapter's 250ms loop.
    let start = Instant::now();
    ws.send(&rpc(
        "run",
        "debug_run",
        &format!(
            r#"{{"source":"{SOURCE}","code":"{}","pause_on_error":false}}"#,
            SCRIPT.replace('\n', "\\n")
        ),
    ))
    .unwrap();

    let mut paused_at = None;
    let mut n = 0;
    let deadline = Instant::now() + Duration::from_secs(6);
    while Instant::now() < deadline {
        n += 1;
        ws.send(&rpc(&format!("st{n}"), "debug_state", "{}"))
            .unwrap();
        if let Some(msg) = ws.poll(Duration::from_millis(100)).unwrap() {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&msg) {
                if v["result"]["paused"] == serde_json::Value::Bool(true) {
                    paused_at = Some(start.elapsed());
                    break;
                }
            }
        }
    }

    // Let the run finish so the sim loop can exit, then tear down.
    let _ = ws.send(&rpc("go", "debug_continue", r#"{"mode":"continue"}"#));
    shutdown.store(true, Ordering::Relaxed);

    let elapsed = paused_at.expect("never reached the first stop within 6s (head-of-line blocked)");
    assert!(
        elapsed < Duration::from_secs(2),
        "time-to-first-stop was {elapsed:?}; expected < 2s (the run must not block the poll path)"
    );
}

fn wait_for_id(ws: &mut Ws, id: &str, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Some(msg) = ws.poll(Duration::from_millis(100)).unwrap() {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&msg) {
                if v["id"] == serde_json::Value::String(id.to_string()) {
                    return;
                }
            }
        }
    }
    panic!("no response for id '{id}' within {timeout:?}");
}
