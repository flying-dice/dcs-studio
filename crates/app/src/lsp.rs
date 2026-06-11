//! Generic LSP process host (decisions/005): spawns language servers and
//! pumps framed JSON-RPC between their stdio and the webview over IPC.
//!
//! The webview owns the protocol (requests, ids, lifecycle); this module
//! is a dumb byte pump. One reader thread per server parses
//! `Content-Length` frames from stdout and emits each complete message as
//! an `lsp://message/{id}` event; stderr lines emit `lsp://stderr/{id}`;
//! process exit — explicit stop OR spontaneous crash — always emits
//! `lsp://exit/{id}` and removes the server, so the client can reject
//! in-flight requests instead of hanging.
//!
//! First hosted server: `dcs-studio-cli lsp`. rust-analyzer follows
//! (issue #6 R2).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

/// Upper bound on one framed message; a `Content-Length` beyond this is a
/// corrupt/hostile stream and ends the session instead of allocating it.
const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

type Hosts = Arc<Mutex<HashMap<String, ServerHandle>>>;

#[derive(Default)]
pub struct LspHosts(Hosts);

struct ServerHandle {
    child: Child,
    /// `None` once an explicit stop has sent EOF; the entry itself stays
    /// until the reader thread reaps, so exit emits exactly once.
    stdin: Option<ChildStdin>,
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
    let hosts = state.0.clone();
    {
        let map = hosts.lock().map_err(|e| e.to_string())?;
        if map.contains_key(&server_id) {
            return Ok(()); // already running — idempotent start
        }
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

    {
        let message_app = app.clone();
        let message_id = server_id.clone();
        let reader_hosts = hosts.clone();
        std::thread::spawn(move || {
            pump_messages(stdout, |message| {
                let _ = message_app.emit(&format!("lsp://message/{message_id}"), message);
            });
            // Stream ended: explicit stop already removed the handle; a
            // SPONTANEOUS end (crash, abort, EOF) still holds it — reap
            // and tell the client either way, so nothing hangs.
            let code = reap(&reader_hosts, &message_id);
            let _ = message_app.emit(&format!("lsp://exit/{message_id}"), ExitPayload { code });
        });
    }

    {
        let stderr_app = app.clone();
        let stderr_id = server_id.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let _ = stderr_app.emit(&format!("lsp://stderr/{stderr_id}"), line);
            }
        });
    }

    hosts.lock().map_err(|e| e.to_string())?.insert(
        server_id,
        ServerHandle {
            child,
            stdin: Some(stdin),
        },
    );
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
    let stdin = handle
        .stdin
        .as_mut()
        .ok_or_else(|| format!("language server '{server_id}' is stopping"))?;
    write!(stdin, "Content-Length: {}\r\n\r\n{message}", message.len())
        .and_then(|()| stdin.flush())
        .map_err(|e| e.to_string())
}

/// Explicit stop: closing stdin (EOF) lets a polite server exit; the
/// reader thread observes the stream end, reaps, removes the handle, and
/// emits `lsp://exit`. An impolite server is killed after a short grace.
#[tauri::command]
pub fn lsp_stop(state: State<'_, LspHosts>, server_id: String) -> Result<(), String> {
    {
        let mut hosts = state.0.lock().map_err(|e| e.to_string())?;
        let Some(handle) = hosts.get_mut(&server_id) else {
            return Ok(()); // already gone — reader thread beat us to it
        };
        drop(handle.stdin.take()); // EOF
    }
    let hosts = state.0.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(1500));
        if let Ok(mut map) = hosts.lock() {
            if let Some(handle) = map.get_mut(&server_id) {
                let _ = handle.child.kill(); // reader thread reaps + emits exit
            }
        }
    });
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
        if let Ok(mut map) = state.0.lock() {
            if let Some(mut handle) = map.remove(&id) {
                let _ = handle.child.kill();
                let _ = handle.child.wait();
            }
        }
    }
}

/// Remove `id` from the host map and wait the child out, returning its
/// exit code. Safe to call whether or not the handle is still present.
fn reap(hosts: &Hosts, id: &str) -> Option<i32> {
    let handle = hosts.lock().ok()?.remove(id);
    let mut handle = handle?;
    let _ = handle.child.kill(); // no-op if already dead
    handle.child.wait().ok().and_then(|status| status.code())
}

/// Pump every framed message from `stdout` into `deliver`; returns when
/// the stream ends (EOF, crash, or a corrupt frame).
fn pump_messages(stdout: impl Read, deliver: impl Fn(String)) {
    let mut reader = BufReader::new(stdout);
    while let Some(message) = read_frame(&mut reader) {
        deliver(message);
    }
}

/// Parse one `Content-Length`-framed message; `None` on EOF, error, or an
/// implausible length (`MAX_FRAME_BYTES`) ends the session cleanly.
///
/// `pub` solely so the host-IPC integration test (`tests/host_ipc.rs`)
/// can drive the host's own frame reader against a real spawned
/// `dcs-studio-cli lsp`; production code reaches it via `pump_messages`.
pub fn read_frame(reader: &mut BufReader<impl Read>) -> Option<String> {
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
    if length > MAX_FRAME_BYTES {
        return None;
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).ok()?;
    String::from_utf8(body).ok()
}

#[cfg(windows)]
fn throwaway_child() -> Child {
    Command::new("cmd")
        .args(["/c", "exit"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn throwaway")
}

#[cfg(not(windows))]
fn throwaway_child() -> Child {
    Command::new("true")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn throwaway")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_parse_across_split_and_coalesced_reads() {
        let payload =
            b"Content-Length: 7\r\n\r\n{\"a\":1}Content-Length: 2\r\nX-Other: y\r\n\r\n{}".to_vec();
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

    #[test]
    fn implausible_content_length_ends_the_stream() {
        let payload = b"Content-Length: 99999999999\r\n\r\n".to_vec();
        let mut reader = BufReader::new(payload.as_slice());
        assert_eq!(read_frame(&mut reader), None);
    }

    /// A server that dies on its own must be reaped, removed from the
    /// host map, and surfaced as an exit — never left to hang clients.
    #[test]
    fn spontaneous_child_exit_reaps_and_reports() {
        let hosts: Hosts = Arc::default();
        let mut child = throwaway_child(); // exits immediately
        let stdout = {
            // Give the reader a stream that ends right away.
            let empty: &[u8] = b"";
            empty
        };
        let stdin = child.stdin.take().expect("piped stdin");
        hosts.lock().unwrap().insert(
            "t".to_string(),
            ServerHandle {
                child,
                stdin: Some(stdin),
            },
        );

        let delivered = std::sync::atomic::AtomicUsize::new(0);
        pump_messages(stdout, |_| {
            delivered.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        });
        let code = reap(&hosts, "t");

        assert_eq!(delivered.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert!(code.is_some(), "exit code observed");
        assert!(hosts.lock().unwrap().is_empty(), "handle removed");
        // A second reap (e.g. racing stop) is a clean no-op.
        assert_eq!(reap(&hosts, "t"), None);
    }
}
