#![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing, clippy::panic, clippy::print_stdout, clippy::print_stderr)] // integration test crate: test code, exempt from the production safety lints

//! The MCP handler driven in-process, exactly the dispatch the app hosts over
//! its loopback transport: a real [`Session`] (its own lazily dialed link, or
//! a fake bridge) fed JSON-RPC through [`handle`]. The LSP server is its own
//! binary (`lua-analyzer`); per-service depth (inject/mission/engine) lives in
//! those crates' suites, and the full end-to-end over a socket is the app's
//! loopback integration test.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use studio_mcp::{Session, handle};

/// Every tool the surface advertises, in registry order — an accidental drop
/// or rename of any tool fails the `tools/list` assertion below.
const FULL_TOOL_SURFACE: [&str; 36] = [
    "init_project",
    "check",
    "build",
    "read_dir",
    "read_text_file",
    "write_text_file",
    "path_exists",
    "dcs_status",
    "dcs_eval",
    "dcs_call",
    "detect_installs",
    "injection_status",
    "inject",
    "eject",
    "launch_dcs",
    "launch_status",
    "stop_dcs",
    "detect_mission_scripts",
    "mission_script_status",
    "mission_script_set",
    "mission_script_restore",
    "lua_diagnostics",
    "lua_hover",
    "lua_complete",
    "lua_definition",
    "debug_set_breakpoints",
    "debug_breakpoints",
    "debug_clear_breakpoints",
    "debug_run",
    "debug_state",
    "debug_expand",
    "debug_eval",
    "debug_pause",
    "debug_stop",
    "debug_inspect",
    "debug_continue",
];

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("studio-mcp-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
}

/// In-process driver: feeds messages straight through `handle` — the dispatch
/// the app hosts — over a real `Session`. Responses queue so a notification
/// (no response) followed by a request reads back the request's response.
struct Mcp {
    session: Session,
    out: RefCell<VecDeque<Value>>,
}

impl Mcp {
    fn new() -> Self {
        Self::over(Session::default())
    }

    fn over(session: Session) -> Self {
        let mcp = Mcp {
            session,
            out: RefCell::new(VecDeque::new()),
        };
        // The handshake an agent always runs first.
        mcp.send(&json!({"jsonrpc": "2.0", "id": 0, "method": "initialize",
                "params": {"protocolVersion": "2024-11-05", "capabilities": {}}}));
        let init = mcp.read();
        assert_eq!(init["result"]["serverInfo"]["name"], json!("dcs-studio"));
        mcp.send(&json!({"jsonrpc": "2.0", "method": "notifications/initialized"}));
        mcp
    }

    fn send(&self, message: &Value) {
        if let Some(response) = handle(&self.session, message) {
            self.out.borrow_mut().push_back(response);
        }
    }

    fn read(&self) -> Value {
        self.out
            .borrow_mut()
            .pop_front()
            .expect("a response was queued")
    }

    fn call(&self, id: u64, tool: &str, arguments: &Value) -> Value {
        self.send(&json!({"jsonrpc": "2.0", "id": id, "method": "tools/call",
                "params": {"name": tool, "arguments": arguments}}));
        self.read()
    }
}

/// The first text block of a tool result.
fn tool_text(response: &Value) -> &str {
    response["result"]["content"][0]["text"]
        .as_str()
        .expect("tool text content")
}

#[test]
fn tools_list_advertises_the_full_surface_in_order() {
    let mcp = Mcp::new();
    mcp.send(&json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}));
    let tools = mcp.read();
    let names: Vec<&str> = tools["result"]["tools"]
        .as_array()
        .expect("tools array")
        .iter()
        .map(|t| t["name"].as_str().expect("tool name"))
        .collect();
    assert_eq!(names, FULL_TOOL_SURFACE);
}

#[test]
fn project_tools_init_check_and_build() {
    let parent = temp_dir("proj");
    let mcp = Mcp::new();

    let created = mcp.call(
        1,
        "init_project",
        &json!({"name": "Agent Mod", "parent": parent.to_string_lossy(), "template": "lua-script"}),
    );
    assert_eq!(created["result"]["isError"], json!(false));
    let project = parent.join("Agent Mod");
    assert!(project.join("dcs-studio.toml").is_file());

    // A freshly scaffolded project checks clean…
    let clean = mcp.call(2, "check", &json!({"root": project.to_string_lossy()}));
    assert_eq!(clean["result"]["isError"], json!(false));

    // …a broken file flips the check tool to error with a stable code.
    std::fs::write(project.join("broken.lua"), "if x then\n").expect("seed broken");
    let dirty = mcp.call(3, "check", &json!({"root": project.to_string_lossy()}));
    assert_eq!(dirty["result"]["isError"], json!(true));
    assert!(tool_text(&dirty).contains("LUA-E"));

    // Lua projects have no build step — the build tool says so, cleanly.
    let built = mcp.call(4, "build", &json!({"root": project.to_string_lossy()}));
    assert_eq!(built["result"]["isError"], json!(false));
    assert!(tool_text(&built).contains("no build step"));

    let _ = std::fs::remove_dir_all(&parent);
}

#[test]
fn workspace_fs_tools_round_trip_against_a_tempdir() {
    let root = temp_dir("fs");
    std::fs::create_dir(root.join("Scripts")).expect("subdir");
    let file = root.join("Scripts").join("note.lua");
    let file_arg = file.to_string_lossy().into_owned();
    let mcp = Mcp::new();

    // Absent before, present after the write, with the exact bytes back.
    let before = mcp.call(1, "path_exists", &json!({"path": file_arg}));
    assert_eq!(tool_text(&before), "false");

    let written = mcp.call(
        2,
        "write_text_file",
        &json!({"path": file_arg, "contents": "print('hi')\n"}),
    );
    assert_eq!(written["result"]["isError"], json!(false));

    let after = mcp.call(3, "path_exists", &json!({"path": file_arg}));
    assert_eq!(tool_text(&after), "true");

    let read = mcp.call(4, "read_text_file", &json!({"path": file_arg}));
    assert_eq!(tool_text(&read), "print('hi')\n");

    // read_dir lists the new file under Scripts.
    let listed = mcp.call(
        5,
        "read_dir",
        &json!({"path": root.join("Scripts").to_string_lossy()}),
    );
    assert!(tool_text(&listed).contains("note.lua"));

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn dcs_tools_without_a_bridge_answer_status_false_and_guard() {
    // Default session dials a deterministically dead port (DCS_BRIDGE_WS) so
    // even a live sim on this box cannot make this flaky.
    let mcp = Mcp::over(Session::with_bridge_url("ws://127.0.0.1:1/ws".to_string()));

    let status = mcp.call(1, "dcs_status", &json!({}));
    assert_eq!(status["result"]["isError"], json!(false));
    let snapshot: Value = serde_json::from_str(tool_text(&status)).expect("status json");
    assert_eq!(snapshot["connected"], json!(false));
    assert_eq!(snapshot["sim_running"], json!(false));

    // An eval with no DCS comes back as a tool error (the link guard), never a
    // hang.
    let eval = mcp.call(2, "dcs_eval", &json!({"code": "return 1"}));
    assert_eq!(eval["result"]["isError"], json!(true));
}

#[test]
fn dcs_tools_against_a_fake_bridge_follow_the_wire_rules() {
    let dcs_time = Arc::new(Mutex::new(0.0_f64));
    let port = fake_bridge(dcs_time.clone());
    let url = format!("ws://127.0.0.1:{port}/ws");
    let mcp = Mcp::over(Session::with_bridge_url(url));

    // dcs_time = 0: connected, but the menu is not a mission — sim stays false.
    let menu = mcp.call(1, "dcs_status", &json!({}));
    let snapshot: Value = serde_json::from_str(tool_text(&menu)).expect("status json");
    assert_eq!(snapshot["connected"], json!(true));
    assert_eq!(snapshot["sim_running"], json!(false));

    // Once dcs_time advances past 0, sim_running flips on.
    *dcs_time.lock().expect("lock") = 27.5;
    let live = mcp.call(2, "dcs_status", &json!({}));
    let snapshot: Value = serde_json::from_str(tool_text(&live)).expect("status json");
    assert_eq!(snapshot["sim_running"], json!(true));
    assert_eq!(snapshot["dcs_time"], json!(27.5));

    // dcs_eval forwards the snippet verbatim as the `eval` method's { code }.
    let tricky = "return \"a\\\"b\" .. [[multi\nline]]";
    let eval = mcp.call(3, "dcs_eval", &json!({"code": tricky}));
    let echoed: Value = serde_json::from_str(tool_text(&eval)).expect("echo json");
    assert_eq!(echoed["method"], json!("eval"));
    assert_eq!(echoed["params"]["code"], json!(tricky));

    // dcs_call forwards an arbitrary method with its params untouched.
    let call = mcp.call(
        4,
        "dcs_call",
        &json!({"method": "outText", "params": {"text": "hi", "delay": 3}}),
    );
    let echoed: Value = serde_json::from_str(tool_text(&call)).expect("echo json");
    assert_eq!(echoed["method"], json!("outText"));
    assert_eq!(echoed["params"], json!({"text": "hi", "delay": 3}));
}

#[test]
fn lang_tools_answer_from_the_real_engine() {
    let root = temp_dir("lang");
    std::fs::write(root.join("broken.lua"), "if x then\n").expect("seed broken");
    let documented = root.join("doc.lua");
    std::fs::write(
        &documented,
        "--- Greets the pilot.\nlocal greet = \"hello\"\nprint(greet)\n",
    )
    .expect("seed documented");
    let mcp = Mcp::new();

    // lua_diagnostics: the broken file's parse finding surfaces with a stable
    // LUA-Exxx code and a 1-based position — the real engine, not a stub.
    let diagnostics = mcp.call(1, "lua_diagnostics", &json!({"root": root.to_string_lossy()}));
    assert_eq!(diagnostics["result"]["isError"], json!(false));
    let report: Value = serde_json::from_str(tool_text(&diagnostics)).expect("report json");
    assert_eq!(report["files_checked"], json!(2));
    let broken = report["findings"]
        .as_array()
        .expect("findings array")
        .iter()
        .find(|f| f["path"].as_str().unwrap().ends_with("broken.lua"))
        .expect("a finding for broken.lua");
    assert!(
        broken["code"].as_str().unwrap().starts_with("LUA-E"),
        "stable code expected, got {}",
        broken["code"]
    );
    assert!(broken["line"].as_u64().unwrap() >= 1);

    // lua_hover on the documented local (line 3 `print(greet)`, column 8 is
    // inside `greet`) answers the engine's card: headline + doc text.
    let hover = mcp.call(
        2,
        "lua_hover",
        &json!({"root": root.to_string_lossy(),
               "path": documented.to_string_lossy(),
               "line": 3, "character": 8}),
    );
    assert_eq!(hover["result"]["isError"], json!(false));
    let card: Value = serde_json::from_str(tool_text(&hover)).expect("hover json");
    assert!(
        card["title"].as_str().unwrap().contains("local greet: string"),
        "card was: {card}"
    );
    assert!(
        card["body"].as_str().unwrap().contains("Greets the pilot."),
        "card was: {card}"
    );

    // lua_complete / lua_definition: stable not-implemented JSON-RPC errors,
    // not a guess — the model's pending-query contract (mcp.pds).
    for (id, tool) in [(3u64, "lua_complete"), (4u64, "lua_definition")] {
        let pending = mcp.call(
            id,
            tool,
            &json!({"root": root.to_string_lossy(),
                   "path": documented.to_string_lossy(),
                   "line": 1, "character": 1}),
        );
        assert_eq!(pending["error"]["code"], json!(-32601), "tool: {tool}");
        assert!(
            pending["error"]["message"]
                .as_str()
                .unwrap()
                .contains("not implemented in the engine yet"),
            "tool {tool} answered: {}",
            pending["error"]["message"]
        );
    }

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn lua_hover_edges_answer_errors_not_guesses() {
    let root = temp_dir("hover-edges");
    let documented = root.join("doc.lua");
    std::fs::write(
        &documented,
        "--- Greets the pilot.\nlocal greet = \"hello\"\nprint(greet)\n",
    )
    .expect("seed documented");
    let mcp = Mcp::new();

    // lua_hover without a usable position is invalid-params, naming the arg.
    let no_line = mcp.call(
        1,
        "lua_hover",
        &json!({"root": root.to_string_lossy(),
               "path": documented.to_string_lossy(),
               "character": 8}),
    );
    assert_eq!(no_line["error"]["code"], json!(-32602));
    assert!(
        no_line["error"]["message"].as_str().unwrap().contains("'line'"),
        "message was: {}",
        no_line["error"]["message"]
    );

    // lua_hover on a file the root does not contain is a tool error.
    let stray = mcp.call(
        2,
        "lua_hover",
        &json!({"root": root.to_string_lossy(),
               "path": "Z:/nowhere/else.lua",
               "line": 1, "character": 1}),
    );
    assert_eq!(stray["result"]["isError"], json!(true));
    assert!(tool_text(&stray).contains("is not a Lua source under"));

    // Hover over empty space answers the no-information text, cleanly.
    let miss = mcp.call(
        3,
        "lua_hover",
        &json!({"root": root.to_string_lossy(),
               "path": documented.to_string_lossy(),
               "line": 1, "character": 1}),
    );
    assert_eq!(miss["result"]["isError"], json!(false));
    assert!(tool_text(&miss).contains("no hover information"));

    let _ = std::fs::remove_dir_all(&root);
}

/// A stock MissionScripting.lua, as DCS ships it.
const STOCK_MISSION_SCRIPT: &str = "do\n\tsanitizeModule('os')\n\tsanitizeModule('io')\n\
                                    \tsanitizeModule('lfs')\n\t_G['require'] = nil\n\
                                    \t_G['loadlib'] = nil\n\t_G['package'] = nil\nend\n";

#[test]
fn mission_and_injection_tools_drive_the_real_services() {
    let root = temp_dir("mission");
    let script = root.join("MissionScripting.lua");
    std::fs::write(&script, STOCK_MISSION_SCRIPT).expect("seed script");
    let script_arg = script.to_string_lossy().into_owned();
    let mcp = Mcp::new();

    // mission_script_status: the stock file reads fully sanitized.
    let status = mcp.call(1, "mission_script_status", &json!({"path": script_arg}));
    assert_eq!(status["result"]["isError"], json!(false));
    let snapshot: Value = serde_json::from_str(tool_text(&status)).expect("status json");
    assert_eq!(snapshot["backup_exists"], json!(false));
    let lfs = snapshot["items"]
        .as_array()
        .expect("items")
        .iter()
        .find(|i| i["name"] == json!("lfs"))
        .expect("lfs item")
        .clone();
    assert_eq!(lfs["sanitized"], json!(true));

    // mission_script_set desanitizes lfs and snapshots the pristine backup.
    let set = mcp.call(
        2,
        "mission_script_set",
        &json!({"path": script_arg, "items": {"lfs": false}}),
    );
    assert_eq!(set["result"]["isError"], json!(false));
    let after: Value = serde_json::from_str(tool_text(&set)).expect("set json");
    assert_eq!(after["backup_exists"], json!(true));
    let edited = std::fs::read_to_string(&script).expect("edited");
    assert!(edited.contains("-- sanitizeModule('lfs')"));

    // Items that aren't an item -> bool object are invalid params.
    let bad = mcp.call(
        3,
        "mission_script_set",
        &json!({"path": script_arg, "items": {"lfs": "nope"}}),
    );
    assert_eq!(bad["error"]["code"], json!(-32602));
    assert!(bad["error"]["message"].as_str().unwrap().contains("item -> bool"));

    // mission_script_restore copies the pristine backup back.
    let restored = mcp.call(4, "mission_script_restore", &json!({"path": script_arg}));
    assert_eq!(restored["result"]["isError"], json!(false));
    assert_eq!(
        std::fs::read_to_string(&script).expect("restored"),
        STOCK_MISSION_SCRIPT
    );

    // injection_status on a write dir with nothing installed says so — and
    // never errors; eject on the same empty dir is a clean no-op.
    let empty = root.join("EmptyWriteDir");
    std::fs::create_dir(&empty).expect("dir");
    let inject_status = mcp.call(
        5,
        "injection_status",
        &json!({"write_dir": empty.to_string_lossy()}),
    );
    assert_eq!(inject_status["result"]["isError"], json!(false));
    let report: Value = serde_json::from_str(tool_text(&inject_status)).expect("status json");
    assert_eq!(report["dll_installed"], json!(false));
    assert_eq!(report["hook_installed"], json!(false));

    let ejected = mcp.call(6, "eject", &json!({"write_dir": empty.to_string_lossy()}));
    assert_eq!(ejected["result"]["isError"], json!(false));

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn launcher_tools_guard_without_a_running_dcs() {
    let mcp = Mcp::new();

    // launch_status with nothing launched: clean, running=false.
    let status = mcp.call(1, "launch_status", &json!({}));
    assert_eq!(status["result"]["isError"], json!(false));
    let snap: Value = serde_json::from_str(tool_text(&status)).expect("status json");
    assert_eq!(snap["running"], json!(false));
    assert_eq!(snap["config_patched"], json!(false));

    // stop_dcs with nothing running is a clean no-op (eject + restore on an
    // empty dir both no-op), never a hang.
    let empty = temp_dir("launcher-stop");
    let stopped = mcp.call(2, "stop_dcs", &json!({"write_dir": empty.to_string_lossy()}));
    assert_eq!(stopped["result"]["isError"], json!(false));
    let snap: Value = serde_json::from_str(tool_text(&stopped)).expect("stop json");
    assert_eq!(snap["running"], json!(false));

    // launch_dcs against a dir with no bridge source / no DCS config is a clean
    // tool error (no DLL, or no Config/options.lua), never a panic.
    let launched = mcp.call(3, "launch_dcs", &json!({"write_dir": empty.to_string_lossy()}));
    assert_eq!(launched["result"]["isError"], json!(true));

    let _ = std::fs::remove_dir_all(&empty);
}

/// A synchronous WS JSON-RPC server standing in for the in-DCS bridge: `ping`
/// pongs the shared `dcs_time`, anything else echoes method + params so the
/// forwarding tools can be asserted against a real socket.
fn fake_bridge(dcs_time: Arc<Mutex<f64>>) -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else {
                return;
            };
            let dcs_time = dcs_time.clone();
            std::thread::spawn(move || {
                let Ok(mut ws) = tungstenite::accept(stream) else {
                    return;
                };
                while let Ok(message) = ws.read() {
                    let Ok(text) = message.to_text() else {
                        continue;
                    };
                    let Ok(request) = serde_json::from_str::<Value>(text) else {
                        continue;
                    };
                    let result = if request["method"] == json!("ping") {
                        json!({"pong": true, "dcs_time": *dcs_time.lock().expect("lock")})
                    } else {
                        json!({"method": request["method"], "params": request["params"]})
                    };
                    let response = json!({"jsonrpc": "2.0", "id": request["id"], "result": result});
                    if ws
                        .send(tungstenite::Message::text(response.to_string()))
                        .is_err()
                    {
                        return;
                    }
                }
            });
        }
    });
    port
}
