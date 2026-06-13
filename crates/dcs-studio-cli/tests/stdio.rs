//! End-to-end over real stdio: the MCP server driven exactly the way an
//! external client (LLM agent) drives it. (The LSP server is its own binary,
//! `lua-analyzer` — its stdio suite lives in that crate.)

use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

use serde_json::{Value, json};

fn cli() -> Command {
    Command::new(env!("CARGO_BIN_EXE_dcs-studio-cli"))
}

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("dcs-cli-e2e-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
}

// ---- MCP -------------------------------------------------------------------

/// Every tool the MCP server advertises, in registry order (issue #8).
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

fn mcp_send(child: &mut Child, message: &Value) {
    let stdin = child.stdin.as_mut().expect("stdin piped");
    serde_json::to_writer(&mut *stdin, message).expect("write");
    stdin.write_all(b"\n").expect("newline");
    stdin.flush().expect("flush");
}

fn mcp_read(reader: &mut BufReader<impl Read>) -> Value {
    let mut line = String::new();
    reader.read_line(&mut line).expect("response line");
    serde_json::from_str(&line).expect("json line")
}

#[test]
fn mcp_agent_inits_a_project_and_checks_it() {
    let parent = temp_dir("mcp");
    let mut child = cli()
        .arg("mcp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn mcp");
    let mut reader = BufReader::new(child.stdout.take().expect("stdout piped"));

    mcp_send(
        &mut child,
        &json!({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": {"protocolVersion": "2024-11-05", "capabilities": {}}}),
    );
    let init = mcp_read(&mut reader);
    assert_eq!(
        init["result"]["serverInfo"]["name"],
        json!("dcs-studio-cli")
    );

    mcp_send(
        &mut child,
        &json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
    );
    mcp_send(
        &mut child,
        &json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
    );
    let tools = mcp_read(&mut reader);
    let names: Vec<&str> = tools["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    // The full issue-#8 surface, in registry order — an accidental drop or
    // rename of any tool fails here.
    assert_eq!(names, FULL_TOOL_SURFACE);

    mcp_send(
        &mut child,
        &json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                "params": {"name": "init_project",
                           "arguments": {"name": "Agent Mod", "parent": parent.to_string_lossy(), "template": "lua-script"}}}),
    );
    let created = mcp_read(&mut reader);
    assert_eq!(created["result"]["isError"], json!(false));
    let project = parent.join("Agent Mod");
    assert!(project.join("dcs-studio.toml").is_file());

    // The freshly scaffolded project checks clean…
    mcp_send(
        &mut child,
        &json!({"jsonrpc": "2.0", "id": 4, "method": "tools/call",
                "params": {"name": "check", "arguments": {"root": project.to_string_lossy()}}}),
    );
    let clean = mcp_read(&mut reader);
    assert_eq!(clean["result"]["isError"], json!(false));

    // …and a broken file flips the check tool to error.
    std::fs::write(project.join("broken.lua"), "if x then\n").expect("seed broken");
    mcp_send(
        &mut child,
        &json!({"jsonrpc": "2.0", "id": 5, "method": "tools/call",
                "params": {"name": "check", "arguments": {"root": project.to_string_lossy()}}}),
    );
    let dirty = mcp_read(&mut reader);
    assert_eq!(dirty["result"]["isError"], json!(true));
    assert!(
        dirty["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("LUA-E")
    );

    // Lua projects have no build step — the build tool says so, cleanly.
    mcp_send(
        &mut child,
        &json!({"jsonrpc": "2.0", "id": 6, "method": "tools/call",
                "params": {"name": "build", "arguments": {"root": project.to_string_lossy()}}}),
    );
    let built = mcp_read(&mut reader);
    assert_eq!(built["result"]["isError"], json!(false));
    assert!(
        built["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("no build step")
    );

    drop(child.stdin.take()); // EOF ends the serve loop
    let status = child.wait().expect("exit");
    assert!(status.success());
    let _ = std::fs::remove_dir_all(&parent);
}

/// Spawn `dcs-studio-cli mcp`, run the initialize handshake, and hand back
/// the child + framed reader.
fn mcp_session(env: &[(&str, &str)]) -> (Child, BufReader<std::process::ChildStdout>) {
    let mut command = cli();
    command
        .arg("mcp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    for (key, value) in env {
        command.env(key, value);
    }
    let mut child = command.spawn().expect("spawn mcp");
    let mut reader = BufReader::new(child.stdout.take().expect("stdout piped"));
    mcp_send(
        &mut child,
        &json!({"jsonrpc": "2.0", "id": 0, "method": "initialize",
                "params": {"protocolVersion": "2024-11-05", "capabilities": {}}}),
    );
    let init = mcp_read(&mut reader);
    assert_eq!(
        init["result"]["serverInfo"]["name"],
        json!("dcs-studio-cli")
    );
    mcp_send(
        &mut child,
        &json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
    );
    (child, reader)
}

fn mcp_call(
    child: &mut Child,
    reader: &mut BufReader<std::process::ChildStdout>,
    id: u64,
    tool: &str,
    arguments: &Value,
) -> Value {
    mcp_send(
        child,
        &json!({"jsonrpc": "2.0", "id": id, "method": "tools/call",
                "params": {"name": tool, "arguments": arguments}}),
    );
    mcp_read(reader)
}

/// The first text block of a tool result.
fn tool_text(response: &Value) -> &str {
    response["result"]["content"][0]["text"]
        .as_str()
        .expect("tool text content")
}

#[test]
fn mcp_workspace_tools_round_trip_against_a_tempdir() {
    let root = temp_dir("mcp-fs");
    std::fs::create_dir(root.join("Scripts")).expect("subdir");
    let file = root.join("Scripts").join("note.lua");
    let file_arg = file.to_string_lossy().into_owned();

    let (mut child, mut reader) = mcp_session(&[]);

    // path_exists: false before the write…
    let absent = mcp_call(
        &mut child,
        &mut reader,
        1,
        "path_exists",
        &json!({"path": file_arg}),
    );
    assert_eq!(absent["result"]["isError"], json!(false));
    assert_eq!(tool_text(&absent), "false");

    // …write_text_file creates it…
    let written = mcp_call(
        &mut child,
        &mut reader,
        2,
        "write_text_file",
        &json!({"path": file_arg, "contents": "print('from the agent')\n"}),
    );
    assert_eq!(written["result"]["isError"], json!(false));

    // …read_text_file returns exactly what was written…
    let read = mcp_call(
        &mut child,
        &mut reader,
        3,
        "read_text_file",
        &json!({"path": file_arg}),
    );
    assert_eq!(read["result"]["isError"], json!(false));
    assert_eq!(tool_text(&read), "print('from the agent')\n");

    // …path_exists flips to true…
    let present = mcp_call(
        &mut child,
        &mut reader,
        4,
        "path_exists",
        &json!({"path": file_arg}),
    );
    assert_eq!(tool_text(&present), "true");

    // …and read_dir lists the folder (directories first).
    let listed = mcp_call(
        &mut child,
        &mut reader,
        5,
        "read_dir",
        &json!({"path": root.to_string_lossy()}),
    );
    assert_eq!(listed["result"]["isError"], json!(false));
    let entries: Value = serde_json::from_str(tool_text(&listed)).expect("entries json");
    assert_eq!(entries[0]["name"], json!("Scripts"));
    assert_eq!(entries[0]["is_dir"], json!(true));

    // A bad argument is a JSON-RPC error, not a dead session.
    mcp_send(
        &mut child,
        &json!({"jsonrpc": "2.0", "id": 6, "method": "tools/call",
                "params": {"name": "read_text_file", "arguments": {}}}),
    );
    let bad = mcp_read(&mut reader);
    assert_eq!(bad["error"]["code"], json!(-32602));
    assert!(
        bad["error"]["message"]
            .as_str()
            .unwrap()
            .contains("read_text_file requires 'path'")
    );

    // An unparseable frame is ignored and the session lives on: the next
    // well-formed request still answers.
    {
        let stdin = child.stdin.as_mut().expect("stdin piped");
        stdin.write_all(b"this is not json\n").expect("garbage");
        stdin.flush().expect("flush");
    }
    let survived = mcp_call(
        &mut child,
        &mut reader,
        7,
        "path_exists",
        &json!({"path": file_arg}),
    );
    assert_eq!(survived["id"], json!(7));
    assert_eq!(tool_text(&survived), "true");

    // A tool name nothing serves is the invalid-params error, not a result.
    let unknown = mcp_call(&mut child, &mut reader, 8, "frobnicate", &json!({}));
    assert_eq!(unknown["error"]["code"], json!(-32602));
    assert!(
        unknown["error"]["message"]
            .as_str()
            .unwrap()
            .contains("unknown tool: frobnicate")
    );

    drop(child.stdin.take());
    assert!(child.wait().expect("exit").success());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn mcp_dcs_tools_without_dcs_answer_status_false_and_the_link_guard() {
    // Pin a deterministically dead endpoint so a live local sim on the
    // well-known port can never flip this test.
    let (mut child, mut reader) = mcp_session(&[("DCS_BRIDGE_WS", "ws://127.0.0.1:59998/ws")]);

    // dcs_status works without DCS: connected:false, never an error.
    let status = mcp_call(&mut child, &mut reader, 1, "dcs_status", &json!({}));
    assert_eq!(status["result"]["isError"], json!(false));
    let snapshot: Value = serde_json::from_str(tool_text(&status)).expect("status json");
    assert_eq!(snapshot["connected"], json!(false));
    assert_eq!(snapshot["sim_running"], json!(false));

    // dcs_eval without DCS surfaces the link guard as a tool error.
    let eval = mcp_call(
        &mut child,
        &mut reader,
        2,
        "dcs_eval",
        &json!({"code": "return 1 + 1"}),
    );
    assert_eq!(eval["result"]["isError"], json!(true));
    assert!(
        tool_text(&eval).contains("not connected to DCS"),
        "guard text was: {}",
        tool_text(&eval)
    );

    // dcs_call follows the same guard.
    let call = mcp_call(
        &mut child,
        &mut reader,
        3,
        "dcs_call",
        &json!({"method": "ping"}),
    );
    assert_eq!(call["result"]["isError"], json!(true));
    assert!(tool_text(&call).contains("not connected to DCS"));

    drop(child.stdin.take());
    assert!(child.wait().expect("exit").success());
}

#[test]
fn mcp_lang_tools_answer_from_the_real_engine() {
    let root = temp_dir("mcp-lang");
    std::fs::write(root.join("broken.lua"), "if x then\n").expect("seed broken");
    let documented = root.join("doc.lua");
    std::fs::write(
        &documented,
        "--- Greets the pilot.\nlocal greet = \"hello\"\nprint(greet)\n",
    )
    .expect("seed documented");

    let (mut child, mut reader) = mcp_session(&[]);

    // lua_diagnostics: the broken file's parse finding surfaces with a
    // stable LUA-Exxx code and a 1-based position.
    let diagnostics = mcp_call(
        &mut child,
        &mut reader,
        1,
        "lua_diagnostics",
        &json!({"root": root.to_string_lossy()}),
    );
    assert_eq!(diagnostics["result"]["isError"], json!(false));
    let report: Value = serde_json::from_str(tool_text(&diagnostics)).expect("report json");
    assert_eq!(report["files_checked"], json!(2));
    let findings = report["findings"].as_array().expect("findings array");
    let broken = findings
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
    let hover = mcp_call(
        &mut child,
        &mut reader,
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

    // lua_complete / lua_definition: stable not-implemented JSON-RPC errors.
    for (id, tool) in [(3u64, "lua_complete"), (4u64, "lua_definition")] {
        mcp_send(
            &mut child,
            &json!({"jsonrpc": "2.0", "id": id, "method": "tools/call",
                    "params": {"name": tool,
                               "arguments": {"root": root.to_string_lossy(),
                                              "path": documented.to_string_lossy(),
                                              "line": 1, "character": 1}}}),
        );
        let pending = mcp_read(&mut reader);
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

    drop(child.stdin.take());
    assert!(child.wait().expect("exit").success());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn mcp_lua_hover_edges_answer_errors_not_guesses() {
    let root = temp_dir("mcp-hover-edges");
    let documented = root.join("doc.lua");
    std::fs::write(
        &documented,
        "--- Greets the pilot.\nlocal greet = \"hello\"\nprint(greet)\n",
    )
    .expect("seed documented");

    let (mut child, mut reader) = mcp_session(&[]);

    // lua_hover without a usable position is invalid-params, naming the arg.
    let no_line = mcp_call(
        &mut child,
        &mut reader,
        1,
        "lua_hover",
        &json!({"root": root.to_string_lossy(),
               "path": documented.to_string_lossy(),
               "character": 8}),
    );
    assert_eq!(no_line["error"]["code"], json!(-32602));
    assert!(
        no_line["error"]["message"]
            .as_str()
            .unwrap()
            .contains("'line'"),
        "message was: {}",
        no_line["error"]["message"]
    );

    // lua_hover on a file the root does not contain is a tool error.
    let stray = mcp_call(
        &mut child,
        &mut reader,
        2,
        "lua_hover",
        &json!({"root": root.to_string_lossy(),
               "path": "Z:/nowhere/else.lua",
               "line": 1, "character": 1}),
    );
    assert_eq!(stray["result"]["isError"], json!(true));
    assert!(tool_text(&stray).contains("is not a Lua source under"));

    // Hover over empty space answers the no-information text, cleanly.
    let miss = mcp_call(
        &mut child,
        &mut reader,
        3,
        "lua_hover",
        &json!({"root": root.to_string_lossy(),
               "path": documented.to_string_lossy(),
               "line": 1, "character": 1}),
    );
    assert_eq!(miss["result"]["isError"], json!(false));
    assert!(tool_text(&miss).contains("no hover information"));

    drop(child.stdin.take());
    assert!(child.wait().expect("exit").success());
    let _ = std::fs::remove_dir_all(&root);
}

/// A stock MissionScripting.lua, as DCS ships it.
const STOCK_MISSION_SCRIPT: &str = "do\n\tsanitizeModule('os')\n\tsanitizeModule('io')\n\
                                    \tsanitizeModule('lfs')\n\t_G['require'] = nil\n\
                                    \t_G['loadlib'] = nil\n\t_G['package'] = nil\nend\n";

#[test]
fn mcp_mission_and_injection_tools_drive_the_real_services() {
    let root = temp_dir("mcp-mission");
    let script = root.join("MissionScripting.lua");
    std::fs::write(&script, STOCK_MISSION_SCRIPT).expect("seed script");
    let script_arg = script.to_string_lossy().into_owned();

    let (mut child, mut reader) = mcp_session(&[]);

    // mission_script_status: the stock file reads fully sanitized.
    let status = mcp_call(
        &mut child,
        &mut reader,
        1,
        "mission_script_status",
        &json!({"path": script_arg}),
    );
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
    let set = mcp_call(
        &mut child,
        &mut reader,
        2,
        "mission_script_set",
        &json!({"path": script_arg, "items": {"lfs": false}}),
    );
    assert_eq!(set["result"]["isError"], json!(false));
    let after: Value = serde_json::from_str(tool_text(&set)).expect("set json");
    assert_eq!(after["backup_exists"], json!(true));
    let lfs = after["items"]
        .as_array()
        .expect("items")
        .iter()
        .find(|i| i["name"] == json!("lfs"))
        .expect("lfs item")
        .clone();
    assert_eq!(lfs["sanitized"], json!(false));
    let edited = std::fs::read_to_string(&script).expect("edited");
    assert!(edited.contains("-- sanitizeModule('lfs')"));

    // Items that aren't an item -> bool object are invalid params.
    let bad = mcp_call(
        &mut child,
        &mut reader,
        3,
        "mission_script_set",
        &json!({"path": script_arg, "items": {"lfs": "nope"}}),
    );
    assert_eq!(bad["error"]["code"], json!(-32602));
    assert!(
        bad["error"]["message"]
            .as_str()
            .unwrap()
            .contains("item -> bool")
    );

    // mission_script_restore copies the pristine backup back.
    let restored = mcp_call(
        &mut child,
        &mut reader,
        4,
        "mission_script_restore",
        &json!({"path": script_arg}),
    );
    assert_eq!(restored["result"]["isError"], json!(false));
    assert_eq!(
        std::fs::read_to_string(&script).expect("restored"),
        STOCK_MISSION_SCRIPT
    );

    // restore without a backup is the disclosed error, as a tool error.
    let bare = root.join("Bare").join("MissionScripting.lua");
    std::fs::create_dir_all(bare.parent().unwrap()).expect("dir");
    std::fs::write(&bare, STOCK_MISSION_SCRIPT).expect("seed bare");
    let no_backup = mcp_call(
        &mut child,
        &mut reader,
        5,
        "mission_script_restore",
        &json!({"path": bare.to_string_lossy()}),
    );
    assert_eq!(no_backup["result"]["isError"], json!(true));
    assert_eq!(tool_text(&no_backup), "No backup found");

    drop(child.stdin.take());
    assert!(child.wait().expect("exit").success());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn mcp_injection_tools_on_an_empty_write_dir_report_not_installed() {
    let root = temp_dir("mcp-inject");
    let empty = root.join("EmptyWriteDir");
    std::fs::create_dir(&empty).expect("dir");

    let (mut child, mut reader) = mcp_session(&[]);

    // injection_status on a write dir with nothing installed says so —
    // and never errors.
    let inject_status = mcp_call(
        &mut child,
        &mut reader,
        1,
        "injection_status",
        &json!({"write_dir": empty.to_string_lossy()}),
    );
    assert_eq!(inject_status["result"]["isError"], json!(false));
    let report: Value = serde_json::from_str(tool_text(&inject_status)).expect("status json");
    assert_eq!(report["dll_installed"], json!(false));
    assert_eq!(report["hook_installed"], json!(false));

    // eject with nothing installed is fine (missing files are fine).
    let ejected = mcp_call(
        &mut child,
        &mut reader,
        2,
        "eject",
        &json!({"write_dir": empty.to_string_lossy()}),
    );
    assert_eq!(ejected["result"]["isError"], json!(false));

    drop(child.stdin.take());
    assert!(child.wait().expect("exit").success());
    let _ = std::fs::remove_dir_all(&root);
}

// ---- fake in-DCS bridge ------------------------------------------------------

/// A minimal in-process stand-in for the in-DCS bridge: a WebSocket JSON-RPC
/// server that pongs `ping` with a scripted `dcs_time` and echoes every other
/// method back as `{ method, params }` — the external oracle for the dcs_*
/// tools' wire behaviour (no real DCS in CI).
fn fake_bridge(dcs_time: std::sync::Arc<std::sync::Mutex<f64>>) -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { break };
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
                    let response = json!({
                        "jsonrpc": "2.0", "id": request["id"], "result": result,
                    });
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

#[test]
fn mcp_dcs_tools_against_a_fake_bridge_follow_the_wire_rules() {
    let dcs_time = std::sync::Arc::new(std::sync::Mutex::new(0.0_f64));
    let port = fake_bridge(dcs_time.clone());
    let url = format!("ws://127.0.0.1:{port}/ws");
    let (mut child, mut reader) = mcp_session(&[("DCS_BRIDGE_WS", &url)]);

    // dcs_status against a pong with dcs_time = 0: connected, but the menu
    // is not a mission — sim_running stays false.
    let menu = mcp_call(&mut child, &mut reader, 1, "dcs_status", &json!({}));
    assert_eq!(menu["result"]["isError"], json!(false));
    let snapshot: Value = serde_json::from_str(tool_text(&menu)).expect("status json");
    assert_eq!(snapshot["connected"], json!(true));
    assert_eq!(snapshot["sim_running"], json!(false));

    // Once dcs_time advances past 0, sim_running flips on.
    *dcs_time.lock().expect("lock") = 27.5;
    let live = mcp_call(&mut child, &mut reader, 2, "dcs_status", &json!({}));
    let snapshot: Value = serde_json::from_str(tool_text(&live)).expect("status json");
    assert_eq!(snapshot["connected"], json!(true));
    assert_eq!(snapshot["sim_running"], json!(true));
    assert_eq!(snapshot["dcs_time"], json!(27.5));

    // dcs_eval forwards the snippet verbatim — quotes, escapes, newlines —
    // as the `eval` method's { code } params.
    let tricky = "return \"a\\\"b\" .. [[multi\nline]]";
    let eval = mcp_call(
        &mut child,
        &mut reader,
        3,
        "dcs_eval",
        &json!({"code": tricky}),
    );
    assert_eq!(eval["result"]["isError"], json!(false));
    let echoed: Value = serde_json::from_str(tool_text(&eval)).expect("echo json");
    assert_eq!(echoed["method"], json!("eval"));
    assert_eq!(echoed["params"]["code"], json!(tricky));

    // dcs_call forwards an arbitrary method with its params untouched.
    let call = mcp_call(
        &mut child,
        &mut reader,
        4,
        "dcs_call",
        &json!({"method": "outText", "params": {"text": "hi", "delay": 3}}),
    );
    assert_eq!(call["result"]["isError"], json!(false));
    let echoed: Value = serde_json::from_str(tool_text(&call)).expect("echo json");
    assert_eq!(echoed["method"], json!("outText"));
    assert_eq!(echoed["params"], json!({"text": "hi", "delay": 3}));

    drop(child.stdin.take());
    assert!(child.wait().expect("exit").success());
}
