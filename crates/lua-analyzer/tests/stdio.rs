//! End-to-end over real stdio: the `lua-analyzer` LSP server driven exactly
//! the way an external client (editor, the IDE host, an LLM agent) drives it.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

use serde_json::{Value, json};

fn lua_analyzer() -> Command {
    Command::new(env!("CARGO_BIN_EXE_lua-analyzer"))
}

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("lua-analyzer-e2e-{tag}-{}", std::process::id()));
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
fn initialize_walk_publishes_parse_and_type_diagnostics() {
    let root = temp_dir("lsp");
    std::fs::write(root.join("broken.lua"), "function f(\n").expect("seed file");
    // A type error: a number passed where a string @param is declared.
    std::fs::write(
        root.join("typed.lua"),
        "--- @param msg string\nlocal function log(msg) end\nlog(1)\n",
    )
    .expect("seed file");

    let mut child = lua_analyzer()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn lua-analyzer");
    let mut reader = BufReader::new(child.stdout.take().expect("stdout piped"));

    let root_uri = format!("file:///{}", root.display().to_string().replace('\\', "/"));
    lsp_send(
        &mut child,
        &json!({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": {"processId": null, "rootUri": root_uri, "capabilities": {}}}),
    );
    let init = lsp_read_until(&mut reader, |m| m.get("id") == Some(&json!(1)));
    assert_eq!(init["result"]["serverInfo"]["name"], json!("lua-analyzer"));
    assert_eq!(init["result"]["capabilities"]["textDocumentSync"], json!(1));
    assert_eq!(init["result"]["capabilities"]["hoverProvider"], json!(true));

    // initialized triggers the workspace walk → diagnostics for both files.
    lsp_send(
        &mut child,
        &json!({"jsonrpc": "2.0", "method": "initialized", "params": {}}),
    );
    // The parse error in broken.lua.
    let parse_publish = lsp_read_until(&mut reader, |m| {
        m.get("method") == Some(&json!("textDocument/publishDiagnostics"))
            && m["params"]["uri"].as_str().is_some_and(|u| u.ends_with("broken.lua"))
            && !m["params"]["diagnostics"].as_array().unwrap().is_empty()
    });
    assert!(
        parse_publish["params"]["diagnostics"][0]["code"]
            .as_str()
            .unwrap()
            .starts_with("LUA-E"),
    );

    // The type error in typed.lua — surfaced over the real LSP, the bug that
    // motivated lua-analyzer: type checks must reach the editor, not just the
    // browser wasm path.
    let type_publish = lsp_read_until(&mut reader, |m| {
        m.get("method") == Some(&json!("textDocument/publishDiagnostics"))
            && m["params"]["uri"].as_str().is_some_and(|u| u.ends_with("typed.lua"))
            && !m["params"]["diagnostics"].as_array().unwrap().is_empty()
    });
    assert_eq!(
        type_publish["params"]["diagnostics"][0]["code"],
        json!("LUA-T001")
    );

    // A full-sync didChange that fixes broken.lua clears its diagnostics.
    let file_uri = format!("{root_uri}/broken.lua");
    lsp_send(
        &mut child,
        &json!({"jsonrpc": "2.0", "method": "textDocument/didChange",
                "params": {"textDocument": {"uri": file_uri, "version": 2},
                           "contentChanges": [{"text": "function f() end\n"}]}}),
    );
    let cleared = lsp_read_until(&mut reader, |m| {
        m.get("method") == Some(&json!("textDocument/publishDiagnostics"))
            && m["params"]["uri"].as_str().is_some_and(|u| u.ends_with("broken.lua"))
            && m["params"]["diagnostics"].as_array().unwrap().is_empty()
    });
    assert!(cleared["params"]["uri"].as_str().unwrap().ends_with("broken.lua"));

    // Hover over a documented local answers a markdown card.
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
