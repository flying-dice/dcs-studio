//! Generic LSP process host (decisions/005): spawns language servers and
//! pumps framed JSON-RPC between their stdio and the webview over IPC.
//!
//! The webview owns the protocol (requests, ids, lifecycle); this module
//! is a dumb byte pump. One reader thread per server parses
//! `Content-Length` frames from stdout and emits each complete message as
//! an `lsp://message/{id}` event; stderr lines emit `lsp://stderr/{id}`;
//! process exit emits `lsp://exit/{id}`.
//!
//! First hosted server: `dcs-studio-cli lsp`. rust-analyzer follows
//! (issue #6 R2).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
pub struct LspHosts(Mutex<HashMap<String, ServerHandle>>);

struct ServerHandle {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Clone, Serialize)]
struct ExitPayload {
    code: Option<i32>,
}

/// Resolve the dcs-studio-cli binary: next to the app executable (both
/// dev `target/debug` and packaged installs lay them out side by side),
/// overridable via `DCS_STUDIO_CLI`.
#[tauri::command]
pub fn lsp_server_path() -> Result<String, String> {
    if let Ok(overridden) = std::env::var("DCS_STUDIO_CLI") {
        return Ok(overridden);
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let sibling = exe
        .parent()
        .ok_or("executable has no parent directory")?
        .join(if cfg!(windows) {
            "dcs-studio-cli.exe"
        } else {
            "dcs-studio-cli"
        });
    if sibling.is_file() {
        Ok(sibling.display().to_string())
    } else {
        Err(format!(
            "dcs-studio-cli not found at {} (build it with `cargo build -p dcs-studio-cli`)",
            sibling.display()
        ))
    }
}

#[tauri::command]
pub fn lsp_start(
    app: AppHandle,
    state: State<'_, LspHosts>,
    server_id: String,
    program: String,
    args: Vec<String>,
) -> Result<(), String> {
    let mut hosts = state.0.lock().map_err(|e| e.to_string())?;
    if hosts.contains_key(&server_id) {
        return Ok(()); // already running — idempotent start
    }

    let mut command = Command::new(&program);
    command
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("spawning {program}: {e}"))?;

    let stdin = child.stdin.take().ok_or("child stdin not piped")?;
    let stdout = child.stdout.take().ok_or("child stdout not piped")?;
    let stderr = child.stderr.take().ok_or("child stderr not piped")?;

    let message_app = app.clone();
    let message_id = server_id.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        while let Some(message) = read_frame(&mut reader) {
            let _ = message_app.emit(&format!("lsp://message/{message_id}"), message);
        }
    });

    let stderr_app = app.clone();
    let stderr_id = server_id.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let _ = stderr_app.emit(&format!("lsp://stderr/{stderr_id}"), line);
        }
    });

    hosts.insert(server_id, ServerHandle { child, stdin });
    Ok(())
}

#[tauri::command]
pub fn lsp_send(
    state: State<'_, LspHosts>,
    server_id: String,
    message: String,
) -> Result<(), String> {
    let mut hosts = state.0.lock().map_err(|e| e.to_string())?;
    let handle = hosts
        .get_mut(&server_id)
        .ok_or_else(|| format!("no language server '{server_id}'"))?;
    write!(handle.stdin, "Content-Length: {}\r\n\r\n{message}", message.len())
        .and_then(|()| handle.stdin.flush())
        .map_err(|e| e.to_string())
}

/// Stop a server. The client is expected to have sent `shutdown`/`exit`
/// first; this reaps (or kills) the process and reports its exit.
#[tauri::command]
pub fn lsp_stop(
    app: AppHandle,
    state: State<'_, LspHosts>,
    server_id: String,
) -> Result<(), String> {
    let handle = state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&server_id);
    let Some(mut handle) = handle else {
        return Ok(());
    };
    drop(handle.stdin); // EOF lets a polite server exit on its own
    let code = match handle.child.try_wait() {
        Ok(Some(status)) => status.code(),
        _ => {
            let _ = handle.child.kill();
            handle.child.wait().ok().and_then(|status| status.code())
        }
    };
    let _ = app.emit(&format!("lsp://exit/{server_id}"), ExitPayload { code });
    Ok(())
}

/// Stop every hosted server — wired to window close so no orphan
/// processes outlive the app (Windows has no SIGTERM).
pub fn stop_all(app: &AppHandle) {
    let Some(state) = app.try_state::<LspHosts>() else {
        return;
    };
    let ids: Vec<String> = match state.0.lock() {
        Ok(hosts) => hosts.keys().cloned().collect(),
        Err(_) => return,
    };
    for id in ids {
        let _ = lsp_stop(app.clone(), app.state::<LspHosts>(), id);
    }
}

/// Parse one `Content-Length`-framed message; `None` on EOF/error ends
/// the reader thread.
fn read_frame(reader: &mut BufReader<impl Read>) -> Option<String> {
    let mut content_length: Option<usize> = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).ok()? == 0 {
            return None; // EOF
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some(value) = line.strip_prefix("Content-Length: ") {
            content_length = value.parse().ok();
        }
    }
    let length = content_length?;
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).ok()?;
    String::from_utf8(body).ok()
}

#[cfg(test)]
mod tests {
    use super::read_frame;
    use std::io::BufReader;

    #[test]
    fn frames_parse_across_split_and_coalesced_reads() {
        let payload = b"Content-Length: 7\r\n\r\n{\"a\":1}Content-Length: 2\r\nX-Other: y\r\n\r\n{}".to_vec();
        let mut reader = BufReader::with_capacity(3, payload.as_slice());
        assert_eq!(read_frame(&mut reader).as_deref(), Some("{\"a\":1}"));
        assert_eq!(read_frame(&mut reader).as_deref(), Some("{}"));
        assert_eq!(read_frame(&mut reader), None);
    }

    #[test]
    fn garbage_headers_end_the_stream_cleanly() {
        let payload = b"Not-A-Header\r\n\r\n".to_vec();
        let mut reader = BufReader::new(payload.as_slice());
        assert_eq!(read_frame(&mut reader), None);
    }
}
