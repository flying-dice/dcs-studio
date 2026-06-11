//! Host <-> real-server IPC seam (decisions/005): drives the app's frame
//! reader (`lsp.rs`) against an actual spawned `dcs-studio-cli lsp`
//! process — the exact byte path the Tauri host pumps, minus the webview
//! layer that /lab/lsp can only fake.
//!
//! Binary resolution: `DCS_STUDIO_CLI` env var, else the test target dir
//! (test executables live in `target/debug/deps`; the CLI sits one level
//! up). When neither yields a binary the test SKIPS (eprintln + success)
//! so machines without a built CLI don't fail; CI builds the CLI first
//! and pins `DCS_STUDIO_CLI`.

use std::io::{BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

use dcs_studio_lib::lsp::read_frame;
use serde_json::{json, Value};

/// Kill a process by id: std::process::Child can't be killed from a
/// watchdog thread without sharing the handle, but the OS tools can.
fn kill_by_id(id: u32) {
    #[cfg(windows)]
    let _ = Command::new("taskkill")
        .args(["/PID", &id.to_string(), "/T", "/F"])
        .output();
    #[cfg(not(windows))]
    let _ = Command::new("kill").args(["-9", &id.to_string()]).output();
}

/// `DCS_STUDIO_CLI`, else `<target dir of this test exe>/dcs-studio-cli`.
fn cli_path() -> Option<PathBuf> {
    if let Ok(overridden) = std::env::var("DCS_STUDIO_CLI") {
        return Some(PathBuf::from(overridden));
    }
    let exe = std::env::current_exe().ok()?; // target/debug/deps/host_ipc-…
    let target_dir = exe.parent()?.parent()?; // target/debug
    let candidate = target_dir.join(if cfg!(windows) {
        "dcs-studio-cli.exe"
    } else {
        "dcs-studio-cli"
    });
    if candidate.is_file() {
        Some(candidate)
    } else {
        None
    }
}

/// Write one `Content-Length`-framed message, exactly as `lsp_send` does.
fn send(child: &mut Child, message: &Value) {
    let body = serde_json::to_string(message).expect("serialise");
    let stdin = child.stdin.as_mut().expect("stdin piped");
    write!(stdin, "Content-Length: {}\r\n\r\n{body}", body.len()).expect("write frame");
    stdin.flush().expect("flush");
}

/// Pull frames through the HOST's own reader until one satisfies
/// `predicate` — every message crosses the seam under test.
fn read_until(reader: &mut BufReader<impl Read>, predicate: impl Fn(&Value) -> bool) -> Value {
    for _ in 0..50 {
        let raw = read_frame(reader).expect("server stream ended early");
        let message: Value = serde_json::from_str(&raw).expect("json frame");
        if predicate(&message) {
            return message;
        }
    }
    panic!("expected message never arrived");
}

#[test]
fn host_frame_reader_drives_a_real_dcs_studio_cli_lsp() {
    let Some(cli) = cli_path() else {
        eprintln!(
            "SKIP host_ipc: dcs-studio-cli binary not found — build it with \
             `cargo build -p dcs-studio-cli` or set DCS_STUDIO_CLI"
        );
        return;
    };

    let mut command = Command::new(&cli);
    command
        .arg("lsp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().expect("spawn dcs-studio-cli lsp");
    let mut reader = BufReader::new(child.stdout.take().expect("stdout piped"));

    // Watchdog: a wedged server would otherwise block read_line forever
    // and stall CI to the job timeout. Killing the child after the budget
    // turns every blocked read into EOF, failing the test fast instead.
    let child_id = child.id();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(60));
        kill_by_id(child_id);
    });

    // initialize with no rootUri — the in-memory didOpen below is the
    // only document, so no workspace walk competes for diagnostics.
    send(
        &mut child,
        &json!({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": {"processId": null, "rootUri": null, "capabilities": {}}}),
    );
    let init = read_until(&mut reader, |m| m.get("id") == Some(&json!(1)));
    assert_eq!(
        init["result"]["serverInfo"]["name"],
        json!("dcs-studio-cli")
    );

    send(
        &mut child,
        &json!({"jsonrpc": "2.0", "method": "initialized", "params": {}}),
    );

    // Broken lua via didOpen → publishDiagnostics with a stable LUA-E code.
    // The uri must be a platform-valid file path (the server round-trips
    // it through `Url::to_file_path`, which rejects drive-less paths on
    // Windows), but the file is never written — didOpen carries the
    // text, so the document stays in-memory.
    let path = std::env::temp_dir().join(format!("host-ipc-broken-{}.lua", std::process::id()));
    let uri = format!(
        "file:///{}",
        path.display()
            .to_string()
            .replace('\\', "/")
            .trim_start_matches('/')
    );
    send(
        &mut child,
        &json!({"jsonrpc": "2.0", "method": "textDocument/didOpen",
                "params": {"textDocument": {"uri": uri,
                                            "languageId": "lua",
                                            "version": 1,
                                            "text": "function f(\n"}}}),
    );
    let publish = read_until(&mut reader, |m| {
        m.get("method") == Some(&json!("textDocument/publishDiagnostics"))
            && m["params"]["diagnostics"]
                .as_array()
                .is_some_and(|d| !d.is_empty())
    });
    let code = publish["params"]["diagnostics"][0]["code"]
        .as_str()
        .unwrap_or_default();
    assert!(
        code.starts_with("LUA-E"),
        "stable LUA-E code expected, got {code:?}"
    );

    // Clean shutdown over the same framed path; the child must exit 0.
    send(
        &mut child,
        &json!({"jsonrpc": "2.0", "id": 2, "method": "shutdown"}),
    );
    read_until(&mut reader, |m| m.get("id") == Some(&json!(2)));
    send(&mut child, &json!({"jsonrpc": "2.0", "method": "exit"}));
    let status = child.wait().expect("child exit");
    assert!(status.success(), "server exited {status:?}");
}
