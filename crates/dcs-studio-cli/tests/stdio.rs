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
    assert_eq!(names, vec!["init_project", "check", "build"]);

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
