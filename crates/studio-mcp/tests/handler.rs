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
const FULL_TOOL_SURFACE: [&str; 22] = [
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
    "detect_mission_scripts",
    "mission_script_status",
    "mission_script_set",
    "mission_script_restore",
    "lua_diagnostics",
    "lua_hover",
    "lua_complete",
    "lua_definition",
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
        assert_eq!(init["result"]["serverInfo"]["name"], json!("dcs-studio-cli"));
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
