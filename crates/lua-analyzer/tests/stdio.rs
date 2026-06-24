#![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing, clippy::panic, clippy::print_stdout, clippy::print_stderr)] // integration test crate: test code, exempt from the production safety lints

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

/// Read non-empty `publishDiagnostics` notifications until one whose URI ends
/// with each suffix has arrived; returns them in `suffixes` order. The boot
/// walk publishes per file in filesystem-walk order, so a test needing several
/// files' diagnostics must capture them order-independently — waiting for a
/// fixed order with successive `lsp_read_until` calls deadlocks on filesystems
/// whose readdir yields the other file first (each call discards the publishes
/// it is not waiting for).
fn read_publishes_for(reader: &mut BufReader<impl Read>, suffixes: &[&str]) -> Vec<Value> {
    let mut found: Vec<Option<Value>> = vec![None; suffixes.len()];
    for _ in 0..100 {
        if found.iter().all(Option::is_some) {
            break;
        }
        let message = lsp_read(reader);
        if message.get("method") != Some(&json!("textDocument/publishDiagnostics")) {
            continue;
        }
        let uri = message["params"]["uri"].as_str().unwrap_or_default().to_string();
        let nonempty = message["params"]["diagnostics"]
            .as_array()
            .is_some_and(|diags| !diags.is_empty());
        if !nonempty {
            continue;
        }
        for (slot, suffix) in found.iter_mut().zip(suffixes) {
            if slot.is_none() && uri.ends_with(suffix) {
                *slot = Some(message);
                break;
            }
        }
    }
    found
        .into_iter()
        .zip(suffixes)
        .map(|(slot, suffix)| slot.unwrap_or_else(|| panic!("no diagnostics published for {suffix:?}")))
        .collect()
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
    // The boot walk publishes broken.lua's parse error and typed.lua's type
    // error in filesystem-walk order; capture both regardless of which lands
    // first (the type error is the bug that motivated lua-analyzer — checks
    // must reach the editor over real LSP, not just the browser wasm path).
    let publishes = read_publishes_for(&mut reader, &["broken.lua", "typed.lua"]);
    assert!(
        publishes[0]["params"]["diagnostics"][0]["code"]
            .as_str()
            .unwrap()
            .starts_with("LUA-E"),
    );
    assert_eq!(
        publishes[1]["params"]["diagnostics"][0]["code"],
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

#[test]
fn completion_advertises_capability_and_offers_members_over_stdio() {
    let root = temp_dir("completion");
    // A dotted-global table whose members the engine enumerates; the member is
    // a function, so the offered item carries a snippet.
    std::fs::write(
        root.join("api.lua"),
        "DCS = {}\nDCS.getPlayerUnit = function() end\nlocal probe = DCS.\n",
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
    // The server advertises completion with `.` as the member trigger.
    assert_eq!(
        init["result"]["capabilities"]["completionProvider"]["triggerCharacters"],
        json!(["."])
    );
    lsp_send(
        &mut child,
        &json!({"jsonrpc": "2.0", "method": "initialized", "params": {}}),
    );

    let file_uri = format!("{root_uri}/api.lua");
    // `local probe = DCS.` — the cursor sits just past the dot on line 2.
    lsp_send(
        &mut child,
        &json!({"jsonrpc": "2.0", "id": 11, "method": "textDocument/completion",
                "params": {"textDocument": {"uri": file_uri},
                           "position": {"line": 2, "character": 18}}}),
    );
    let response = lsp_read_until(&mut reader, |m| m.get("id") == Some(&json!(11)));
    let items = response["result"].as_array().expect("completion array");
    let member = items
        .iter()
        .find(|item| item["label"] == json!("getPlayerUnit"))
        .unwrap_or_else(|| panic!("DCS.getPlayerUnit not offered; items: {items:?}"));
    // CompletionItemKind::Function == 3; the function member inserts a snippet
    // (InsertTextFormat::Snippet == 2).
    assert_eq!(member["kind"], json!(3), "item was: {member}");
    assert_eq!(member["insertTextFormat"], json!(2), "item was: {member}");

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
fn initialize_walk_indexes_vendored_dependencies() {
    let root = temp_dir("vendored");
    // A CargoLua.toml declaring one dependency, vendored on disk under the
    // dot-prefixed `.lua-cargo/deps` cache the plain workspace walk skips.
    std::fs::write(
        root.join("CargoLua.toml"),
        "[package]\nname = \"p\"\n[dependencies]\nmoose = { github = \"flying-dice/moose\" }\n",
    )
    .expect("seed manifest");
    let dep_dir = root.join(".lua-cargo").join("deps").join("moose");
    std::fs::create_dir_all(&dep_dir).expect("vendor dir");
    // The dep declares a global; the project calls it. Only an indexed dep
    // resolves that call to the vendored file (globals are workspace-wide), so
    // a successful go-to-definition is proof the vendor tree was walked.
    std::fs::write(dep_dir.join("init.lua"), "function MooseHelper()\nend\n").expect("seed dep");
    std::fs::write(root.join("main.lua"), "MooseHelper()\n").expect("seed main");

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
    lsp_read_until(&mut reader, |m| m.get("id") == Some(&json!(1)));
    lsp_send(
        &mut child,
        &json!({"jsonrpc": "2.0", "method": "initialized", "params": {}}),
    );

    // Go-to-definition on the `MooseHelper()` call jumps INTO the vendored dep.
    let main_uri = format!("{root_uri}/main.lua");
    lsp_send(
        &mut child,
        &json!({"jsonrpc": "2.0", "id": 21, "method": "textDocument/definition",
                "params": {"textDocument": {"uri": main_uri},
                           "position": {"line": 0, "character": 0}}}),
    );
    let def = lsp_read_until(&mut reader, |m| m.get("id") == Some(&json!(21)));
    let target = def["result"]["uri"].as_str().unwrap_or_default();
    assert!(
        target.contains("moose") && target.ends_with("init.lua"),
        "definition did not resolve into the vendored dep: {}",
        def["result"]
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

#[test]
fn requires_resolve_into_deps_and_warn_on_unresolved_and_shadowing() {
    // Pillar 2 (issue #51) end-to-end over real stdio: go-to-definition on a
    // `require("dep")` jumps into the vendored checkout the bundler would
    // amalgamate, and unresolved / shadowing requires reach the editor as
    // warnings — the same verdict the bundler reports (the parity goal).
    let root = temp_dir("requires");
    std::fs::write(
        root.join("CargoLua.toml"),
        "[package]\nname = \"p\"\n[dependencies]\nmoose = { github = \"a/moose\" }\nshared = { github = \"a/shared\" }\n",
    )
    .expect("seed manifest");
    std::fs::create_dir_all(root.join("src")).expect("src dir");
    let moose = root.join(".lua-cargo").join("deps").join("moose");
    let shared = root.join(".lua-cargo").join("deps").join("shared");
    std::fs::create_dir_all(&moose).expect("moose dir");
    std::fs::create_dir_all(&shared).expect("shared dir");
    std::fs::write(moose.join("init.lua"), "return {}\n").expect("seed moose");
    std::fs::write(shared.join("init.lua"), "return \"vendored\"\n").expect("seed vendored shared");
    // Entry: a local module (clean), a vendored dep (clean, the goto target), a
    // name present BOTH locally and vendored (shadowing), and a host module that
    // resolves nowhere (unresolved — never an error).
    std::fs::write(
        root.join("src").join("main.lua"),
        "local u = require(\"util\")\nlocal m = require(\"moose\")\nlocal s = require(\"shared\")\nlocal net = require(\"socket\")\nreturn u\n",
    )
    .expect("seed main");
    std::fs::write(root.join("src").join("util.lua"), "return {}\n").expect("seed util");
    std::fs::write(root.join("src").join("shared.lua"), "return \"local\"\n").expect("seed local shared");

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
    lsp_read_until(&mut reader, |m| m.get("id") == Some(&json!(1)));
    lsp_send(
        &mut child,
        &json!({"jsonrpc": "2.0", "method": "initialized", "params": {}}),
    );

    // The boot walk publishes main.lua's require findings: socket unresolved,
    // shared shadowed — and nothing for the cleanly-resolved util / moose.
    let publishes = read_publishes_for(&mut reader, &["main.lua"]);
    let codes: Vec<&str> = publishes[0]["params"]["diagnostics"]
        .as_array()
        .expect("diagnostics array")
        .iter()
        .filter_map(|d| d["code"].as_str())
        .collect();
    assert!(codes.contains(&"unresolved-require"), "missing unresolved warning: {codes:?}");
    assert!(codes.contains(&"require-shadowing"), "missing shadowing warning: {codes:?}");
    assert_eq!(codes.len(), 2, "only socket + shared warn; util + moose resolve clean: {codes:?}");

    // Go-to-definition on the `require("moose")` string jumps INTO the vendored
    // checkout — the exact file the bundler would pull in.
    let main_uri = format!("{root_uri}/src/main.lua");
    lsp_send(
        &mut child,
        &json!({"jsonrpc": "2.0", "id": 31, "method": "textDocument/definition",
                "params": {"textDocument": {"uri": main_uri},
                           "position": {"line": 1, "character": 20}}}),
    );
    let def = lsp_read_until(&mut reader, |m| m.get("id") == Some(&json!(31)));
    let target = def["result"]["uri"].as_str().unwrap_or_default();
    assert!(
        target.ends_with("moose/init.lua") && target.contains(".lua-cargo"),
        "require did not resolve into the vendored dep: {}",
        def["result"]
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
