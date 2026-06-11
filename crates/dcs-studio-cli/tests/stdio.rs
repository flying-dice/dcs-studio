//! End-to-end over real stdio: the LSP and MCP servers driven exactly the
//! way an external client (editor, LLM agent) drives them.

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

// ---- LSP framing helpers ---------------------------------------------------

fn lsp_send(child: &mut Child, message: &Value) {
    let body = serde_json::to_string(message).expect("serialise");
    let stdin = child.stdin.as_mut().expect("stdin piped");
    write!(stdin, "Content-Length: {}\r\n\r\n{body}", body.len()).expect("write frame");
    stdin.flush().expect("flush");
}

fn lsp_read(reader: &mut BufReader<impl Read>) -> Value {
    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).expect("header line");
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some(value) = line.strip_prefix("Content-Length: ") {
            content_length = value.parse().expect("content length");
        }
    }
    let mut body = vec![0u8; content_length];
    reader.read_exact(&mut body).expect("body");
    serde_json::from_slice(&body).expect("json body")
}

/// Read messages until one satisfies `predicate`.
fn lsp_read_until(reader: &mut BufReader<impl Read>, predicate: impl Fn(&Value) -> bool) -> Value {
    for _ in 0..50 {
        let message = lsp_read(reader);
        if predicate(&message) {
            return message;
        }
    }
    panic!("expected message never arrived");
}

#[test]
fn lsp_initialize_didopen_publishes_diagnostics() {
    let root = temp_dir("lsp");
    std::fs::write(root.join("broken.lua"), "function f(\n").expect("seed file");

    let mut child = cli()
        .arg("lsp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn lsp");
    let mut reader = BufReader::new(child.stdout.take().expect("stdout piped"));

    let root_uri = format!("file:///{}", root.display().to_string().replace('\\', "/"));
    lsp_send(
        &mut child,
        &json!({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": {"processId": null, "rootUri": root_uri, "capabilities": {}}}),
    );
    let init = lsp_read_until(&mut reader, |m| m.get("id") == Some(&json!(1)));
    assert_eq!(
        init["result"]["serverInfo"]["name"],
        json!("dcs-studio-cli")
    );
    assert_eq!(init["result"]["capabilities"]["textDocumentSync"], json!(1));
    assert_eq!(init["result"]["capabilities"]["hoverProvider"], json!(true));

    // initialized triggers the workspace walk → diagnostics for broken.lua.
    lsp_send(
        &mut child,
        &json!({"jsonrpc": "2.0", "method": "initialized", "params": {}}),
    );
    let publish = lsp_read_until(&mut reader, |m| {
        m.get("method") == Some(&json!("textDocument/publishDiagnostics"))
            && !m["params"]["diagnostics"].as_array().unwrap().is_empty()
    });
    let diagnostic = &publish["params"]["diagnostics"][0];
    assert_eq!(diagnostic["source"], json!("dcs-lua"));
    assert!(
        diagnostic["code"].as_str().unwrap().starts_with("LUA-E"),
        "stable code expected, got {}",
        diagnostic["code"]
    );

    // A full-sync didChange that fixes the file clears its diagnostics.
    let file_uri = format!("{root_uri}/broken.lua");
    lsp_send(
        &mut child,
        &json!({"jsonrpc": "2.0", "method": "textDocument/didChange",
                "params": {"textDocument": {"uri": file_uri, "version": 2},
                           "contentChanges": [{"text": "function f() end\n"}]}}),
    );
    let cleared = lsp_read_until(&mut reader, |m| {
        m.get("method") == Some(&json!("textDocument/publishDiagnostics"))
            && m["params"]["diagnostics"].as_array().unwrap().is_empty()
    });
    assert!(
        cleared["params"]["uri"]
            .as_str()
            .unwrap()
            .ends_with("broken.lua")
    );

    // Hover over a documented local answers a markdown card with the
    // declaration headline and the doc text.
    lsp_send(
        &mut child,
        &json!({"jsonrpc": "2.0", "method": "textDocument/didChange",
                "params": {"textDocument": {"uri": file_uri, "version": 3},
                           "contentChanges": [{"text": "--- Greets the pilot.\nlocal greet = \"hello\"\nprint(greet)\n"}]}}),
    );
    lsp_send(
        &mut child,
        &json!({"jsonrpc": "2.0", "id": 7, "method": "textDocument/hover",
                "params": {"textDocument": {"uri": file_uri},
                           "position": {"line": 2, "character": 8}}}),
    );
    let hover = lsp_read_until(&mut reader, |m| m.get("id") == Some(&json!(7)));
    assert_eq!(hover["result"]["contents"]["kind"], json!("markdown"));
    let card = hover["result"]["contents"]["value"].as_str().unwrap();
    assert!(card.contains("local greet: string"), "card was: {card}");
    assert!(card.contains("Greets the pilot."), "card was: {card}");

    lsp_send(
        &mut child,
        &json!({"jsonrpc": "2.0", "id": 99, "method": "shutdown"}),
    );
    lsp_read_until(&mut reader, |m| m.get("id") == Some(&json!(99)));
    lsp_send(&mut child, &json!({"jsonrpc": "2.0", "method": "exit"}));
    let status = child.wait().expect("exit");
    assert!(status.success());
    let _ = std::fs::remove_dir_all(&root);
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
