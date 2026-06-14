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
        json!("param-type-mismatch")
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

#[test]
fn definition_references_and_rename_round_trip() {
    let root = temp_dir("nav");
    // A global function declared in one file and called from another.
    std::fs::write(root.join("lib.lua"), "function shared()\nend\n").expect("seed lib");
    std::fs::write(root.join("main.lua"), "shared()\nshared()\n").expect("seed main");

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
    assert_eq!(init["result"]["capabilities"]["definitionProvider"], json!(true));
    assert_eq!(init["result"]["capabilities"]["referencesProvider"], json!(true));
    assert_eq!(init["result"]["capabilities"]["renameProvider"], json!(true));
    lsp_send(
        &mut child,
        &json!({"jsonrpc": "2.0", "method": "initialized", "params": {}}),
    );

    let main_uri = format!("{root_uri}/main.lua");

    // Go-to-definition on the `shared()` use jumps to lib.lua's declaration.
    lsp_send(
        &mut child,
        &json!({"jsonrpc": "2.0", "id": 21, "method": "textDocument/definition",
                "params": {"textDocument": {"uri": main_uri},
                           "position": {"line": 0, "character": 0}}}),
    );
    let def = lsp_read_until(&mut reader, |m| m.get("id") == Some(&json!(21)));
    assert!(
        def["result"]["uri"].as_str().unwrap().ends_with("lib.lua"),
        "definition was: {}",
        def["result"]
    );
    // Lands on the function name `shared` (line 0, char 9), not the keyword.
    assert_eq!(def["result"]["range"]["start"]["character"], json!(9));

    // Find-references returns the declaration plus both call sites (3 total).
    lsp_send(
        &mut child,
        &json!({"jsonrpc": "2.0", "id": 22, "method": "textDocument/references",
                "params": {"textDocument": {"uri": main_uri},
                           "position": {"line": 0, "character": 0},
                           "context": {"includeDeclaration": true}}}),
    );
    let refs = lsp_read_until(&mut reader, |m| m.get("id") == Some(&json!(22)));
    let locations = refs["result"].as_array().expect("references array");
    assert_eq!(locations.len(), 3, "references were: {locations:?}");
    assert!(
        locations.iter().any(|l| l["uri"].as_str().unwrap().ends_with("lib.lua")),
        "declaration file missing from references"
    );

    // Rename rewrites every occurrence across both files.
    lsp_send(
        &mut child,
        &json!({"jsonrpc": "2.0", "id": 23, "method": "textDocument/rename",
                "params": {"textDocument": {"uri": main_uri},
                           "position": {"line": 0, "character": 0},
                           "newName": "renamed"}}),
    );
    let rename = lsp_read_until(&mut reader, |m| m.get("id") == Some(&json!(23)));
    let changes = rename["result"]["changes"].as_object().expect("changes map");
    assert_eq!(changes.len(), 2, "expected edits in two files: {changes:?}");
    let total_edits: usize = changes.values().map(|v| v.as_array().unwrap().len()).sum();
    assert_eq!(total_edits, 3, "expected three edits total");

    // An invalid new name is refused with an error, not a silent no-op.
    lsp_send(
        &mut child,
        &json!({"jsonrpc": "2.0", "id": 24, "method": "textDocument/rename",
                "params": {"textDocument": {"uri": main_uri},
                           "position": {"line": 0, "character": 0},
                           "newName": "1bad"}}),
    );
    let refused = lsp_read_until(&mut reader, |m| m.get("id") == Some(&json!(24)));
    assert!(refused.get("error").is_some(), "expected an error: {refused}");

    lsp_send(
        &mut child,
        &json!({"jsonrpc": "2.0", "id": 99, "method": "shutdown"}),
    );
    lsp_read_until(&mut reader, |m| m.get("id") == Some(&json!(99)));
    lsp_send(&mut child, &json!({"jsonrpc": "2.0", "method": "exit"}));
    assert!(child.wait().expect("exit").success());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn inlay_hints_carry_inferred_signature_types() {
    let root = temp_dir("inlay");
    // An unannotated function whose parameter and return type the body implies.
    std::fs::write(
        root.join("sig.lua"),
        "local function f(p)\n  return p:upper()\nend\n",
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
    // The server advertises the inlay-hint capability.
    assert_eq!(init["result"]["capabilities"]["inlayHintProvider"], json!(true));
    lsp_send(
        &mut child,
        &json!({"jsonrpc": "2.0", "method": "initialized", "params": {}}),
    );

    let file_uri = format!("{root_uri}/sig.lua");
    lsp_send(
        &mut child,
        &json!({"jsonrpc": "2.0", "id": 11, "method": "textDocument/inlayHint",
                "params": {"textDocument": {"uri": file_uri},
                           "range": {"start": {"line": 0, "character": 0},
                                     "end": {"line": 3, "character": 0}}}}),
    );
    let response = lsp_read_until(&mut reader, |m| m.get("id") == Some(&json!(11)));
    let hints = response["result"].as_array().expect("inlay hint array");
    let labels: Vec<&str> = hints.iter().filter_map(|h| h["label"].as_str()).collect();
    // The parameter `p: string` (after the name) and the return `: string`
    // (after the parameter list) — both reach the editor over real stdio.
    assert_eq!(
        labels.iter().filter(|l| **l == ": string").count(),
        2,
        "expected two `: string` hints; got {labels:?}"
    );

    lsp_send(
        &mut child,
        &json!({"jsonrpc": "2.0", "id": 99, "method": "shutdown"}),
    );
    lsp_read_until(&mut reader, |m| m.get("id") == Some(&json!(99)));
    lsp_send(&mut child, &json!({"jsonrpc": "2.0", "method": "exit"}));
    assert!(child.wait().expect("exit").success());
    let _ = std::fs::remove_dir_all(&root);
}
