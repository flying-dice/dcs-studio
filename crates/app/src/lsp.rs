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

type SharedRegistry = Arc<Mutex<Registry>>;

#[derive(Default)]
pub struct LspHosts(SharedRegistry);

/// Two-level server registry (issue #31). A stable LOGICAL id the webview
/// knows (`"dcs-lua"`) maps to a per-spawn PHYSICAL id (`"dcs-lua:3"`) that
/// keys the live handle and its IPC event channel. The split lets a fresh
/// spawn claim a new physical id while a dying server's reader thread still
/// reaps the old one — no cross-stream of events, no clobber of the map.
#[derive(Default)]
struct Registry {
    /// physical_id -> live process handle.
    handles: HashMap<String, ServerHandle>,
    /// logical_id -> the physical_id currently serving it.
    logical: HashMap<String, String>,
    /// Monotonic source of unique physical ids; never reused within a run.
    next_seq: u64,
}

impl Registry {
    /// Physical id of a server safe to RE-ATTACH to for `logical_id`: stdin
    /// still open (not mid-stop), the initialize handshake already done, AND
    /// bound to the same `root` it was spawned for. A re-attaching client
    /// skips the handshake instead of illegally re-initializing a live server
    /// (the issue-#31 failure) — but only when the inherited server is rooted
    /// where the client now wants it.
    ///
    /// `root` is an opaque binding scope (rust-analyzer's project root, sent
    /// once at `initialize` and never re-sent — the server indexes from it for
    /// life). Re-attaching such a server for a DIFFERENT root would leave it
    /// indexing the old project while the client believes it switched; refusing
    /// here makes the caller evict it and spawn one that handshakes against the
    /// new root (MR !20). `None` = root-agnostic (dcs-lua re-`didOpen`s every
    /// file each mount), where any request re-attaches.
    fn reattach_target(&self, logical_id: &str, root: Option<&str>) -> Option<String> {
        let physical = self.logical.get(logical_id)?;
        let handle = self.handles.get(physical)?;
        if handle.stdin.is_some() && handle.initialized && handle.root.as_deref() == root {
            Some(physical.clone())
        } else {
            None
        }
    }

    /// Remove and return the handle currently mapped to `logical_id`, if any
    /// — a stale or never-initialized server the caller kills before
    /// spawning a replacement.
    fn remove(&mut self, logical_id: &str) -> Option<ServerHandle> {
        let physical = self.logical.remove(logical_id)?;
        self.handles.remove(&physical)
    }

    /// Allocate the next unique physical id for `logical_id`.
    fn next_physical(&mut self, logical_id: &str) -> String {
        self.next_seq += 1;
        format!("{logical_id}:{}", self.next_seq)
    }

    /// Register a freshly spawned `handle` under both index levels at once,
    /// so a physical handle never exists without its logical mapping.
    fn register(&mut self, logical_id: &str, physical_id: &str, handle: ServerHandle) {
        self.handles.insert(physical_id.to_string(), handle);
        self.logical.insert(logical_id.to_string(), physical_id.to_string());
    }

    /// Record that the server keyed by `physical_id` finished its handshake,
    /// so a later re-attach (page refresh / HMR) can skip it.
    fn mark_initialized(&mut self, physical_id: &str) {
        if let Some(handle) = self.handles.get_mut(physical_id) {
            handle.initialized = true;
        }
    }
}

struct ServerHandle {
    child: Child,
    /// `None` once an explicit stop has sent EOF; the entry itself stays
    /// until the reader thread reaps, so exit emits exactly once.
    stdin: Option<ChildStdin>,
    /// Set once the webview reports a completed initialize handshake; gates
    /// the re-attach decision in `lsp_get_or_start`.
    initialized: bool,
    /// The binding scope this server was spawned for — rust-analyzer's project
    /// root, fixed at `initialize`. A re-attach must match it
    /// (`reattach_target`); `None` = root-agnostic (dcs-lua).
    root: Option<String>,
}

#[derive(Clone, Serialize)]
struct ExitPayload {
    code: Option<i32>,
}

/// What `lsp_get_or_start` hands back: the PHYSICAL id the client must use
/// for every later send/stop/mark, and whether the server was freshly
/// spawned (`is_new` → run the initialize handshake) or re-attached
/// (`!is_new` → skip it). Serialized camelCase so the webview reads
/// `serverId` / `isNew` (Tauri camelCases command args, not return values).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartOutcome {
    server_id: String,
    is_new: bool,
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

/// Get or start the language server for a stable LOGICAL id (issue #31).
///
/// The backend is the authoritative owner of server lifecycle: a webview
/// recreated by a page refresh or HMR asks here on every (re)mount and is
/// told whether it inherited a live, already-initialized server (re-attach,
/// `is_new=false`, skip the handshake) or got a fresh spawn (`is_new=true`,
/// run it). A stale, never-initialized, or wrong-`root` leftover is killed
/// first so the replacement never shares a physical id — or an event stream —
/// with it.
///
/// `root` binds the spawn to a scope: a re-attach is granted only for the SAME
/// root, so a root-bound server (rust-analyzer indexes from its `rootUri`) is
/// never silently reused for a different project after a reload — that
/// mismatch evicts it and spawns fresh against the new root (MR !20). `None`
/// = root-agnostic (dcs-lua).
#[tauri::command]
pub fn lsp_get_or_start(
    app: AppHandle,
    state: State<'_, LspHosts>,
    logical_id: String,
    program: String,
    args: Vec<String>,
    root: Option<String>,
) -> Result<StartOutcome, String> {
    let shared = state.0.clone();

    // One critical section decides the outcome: re-attach to a healthy
    // initialized server rooted where the client wants, or evict any stale
    // leftover (dead, pre-handshake, OR rooted elsewhere) and reserve a fresh
    // physical id. The evicted child is killed AFTER the lock releases, so its
    // blocking wait never stalls another command.
    let (physical, stale) = {
        let mut reg = shared.lock().map_err(|e| e.to_string())?;
        if let Some(physical) = reg.reattach_target(&logical_id, root.as_deref()) {
            return Ok(StartOutcome {
                server_id: physical,
                is_new: false,
            });
        }
        let stale = reg.remove(&logical_id);
        (reg.next_physical(&logical_id), stale)
    };
    if let Some(mut stale) = stale {
        let _ = stale.child.kill();
        let _ = stale.child.wait();
    }

    spawn_server(&app, &shared, &logical_id, &physical, &program, &args, root)?;
    Ok(StartOutcome {
        server_id: physical,
        is_new: true,
    })
}

/// Mark the server keyed by `server_id` (a physical id) as initialized,
/// called by the client once its initialize handshake succeeds so a later
/// re-attach can skip it.
#[tauri::command]
pub fn lsp_mark_initialized(state: State<'_, LspHosts>, server_id: String) -> Result<(), String> {
    state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .mark_initialized(&server_id);
    Ok(())
}

/// Spawn `program args`, wire its stdout/stderr to IPC events keyed by
/// `physical_id`, and register the (uninitialized) handle. The reader thread
/// reaps `physical_id` on stream end and emits `lsp://exit/{physical_id}`,
/// so a crash or stop never leaves a client hanging.
fn spawn_server(
    app: &AppHandle,
    shared: &SharedRegistry,
    logical_id: &str,
    physical_id: &str,
    program: &str,
    args: &[String],
    root: Option<String>,
) -> Result<(), String> {
    let mut command = Command::new(program);
    command
        .args(args)
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
        let message_id = physical_id.to_string();
        let reader_hosts = shared.clone();
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
        let stderr_id = physical_id.to_string();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let _ = stderr_app.emit(&format!("lsp://stderr/{stderr_id}"), line);
            }
        });
    }

    shared.lock().map_err(|e| e.to_string())?.register(
        logical_id,
        physical_id,
        ServerHandle {
            child,
            stdin: Some(stdin),
            initialized: false,
            root,
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
    let mut reg = state.0.lock().map_err(|e| e.to_string())?;
    let handle = reg
        .handles
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
        let mut reg = state.0.lock().map_err(|e| e.to_string())?;
        let Some(handle) = reg.handles.get_mut(&server_id) else {
            return Ok(()); // already gone — reader thread beat us to it
        };
        drop(handle.stdin.take()); // EOF
    }
    let shared = state.0.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(1500));
        if let Ok(mut reg) = shared.lock() {
            if let Some(handle) = reg.handles.get_mut(&server_id) {
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
        Ok(reg) => reg.handles.keys().cloned().collect(),
        Err(_) => return,
    };
    for id in ids {
        if let Ok(mut reg) = state.0.lock() {
            if let Some(mut handle) = reg.handles.remove(&id) {
                let _ = handle.child.kill();
                let _ = handle.child.wait();
            }
        }
    }
}

/// Remove the handle for physical `id` and wait the child out, returning
/// its exit code. Safe to call whether or not the handle is still present;
/// a now-dangling logical mapping self-heals on the next `lsp_get_or_start`.
fn reap(shared: &SharedRegistry, id: &str) -> Option<i32> {
    let handle = shared.lock().ok()?.handles.remove(id);
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

#[cfg(all(test, windows))]
fn throwaway_child() -> Child {
    Command::new("cmd")
        .args(["/c", "exit"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn throwaway")
}

#[cfg(all(test, not(windows)))]
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
        let shared: SharedRegistry = Arc::default();
        let mut child = throwaway_child(); // exits immediately
        let stdout = {
            // Give the reader a stream that ends right away.
            let empty: &[u8] = b"";
            empty
        };
        let stdin = child.stdin.take().expect("piped stdin");
        shared.lock().unwrap().handles.insert(
            "t".to_string(),
            ServerHandle {
                child,
                stdin: Some(stdin),
                initialized: false,
                root: None,
            },
        );

        let delivered = std::sync::atomic::AtomicUsize::new(0);
        pump_messages(stdout, |_| {
            delivered.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        });
        let code = reap(&shared, "t");

        assert_eq!(delivered.load(std::sync::atomic::Ordering::SeqCst), 0);
        // code is None when reap's kill races the child's own exit and
        // the process dies by signal (Unix signal deaths carry no exit
        // code) - the ExitPayload contract is Option for exactly that.
        // What matters is that reap completed and the handle is gone.
        assert!(shared.lock().unwrap().handles.is_empty(), "handle removed");
        let _ = code;
        // A second reap (e.g. racing stop) is a clean no-op.
        assert_eq!(reap(&shared, "t"), None);
    }

    /// Register a throwaway-backed handle under `logical`/`physical` — also
    /// exercises `Registry::register`, the path `spawn_server` uses.
    fn insert_handle(
        reg: &mut Registry,
        logical: &str,
        physical: &str,
        initialized: bool,
        root: Option<&str>,
    ) {
        let mut child = throwaway_child();
        let stdin = child.stdin.take().expect("piped stdin");
        reg.register(
            logical,
            physical,
            ServerHandle {
                child,
                stdin: Some(stdin),
                initialized,
                root: root.map(str::to_owned),
            },
        );
    }

    /// Kill + wait every remaining handle so the test leaks no zombies.
    fn drain(reg: &mut Registry) {
        for (_, mut handle) in reg.handles.drain() {
            let _ = handle.child.kill();
            let _ = handle.child.wait();
        }
    }

    /// The re-attach guard is the heart of issue #31: only a live, already
    /// initialized server may be inherited without a fresh handshake.
    #[test]
    fn reattach_only_to_a_healthy_initialized_server() {
        let mut reg = Registry::default();
        // Unknown logical id: nothing to inherit.
        assert_eq!(reg.reattach_target("dcs-lua", None), None);

        // Live but pre-handshake: re-attaching would skip the initialize the
        // server still expects — refuse.
        insert_handle(&mut reg, "dcs-lua", "dcs-lua:1", false, None);
        assert_eq!(reg.reattach_target("dcs-lua", None), None);

        // Handshake done: re-attach to exactly this physical id.
        reg.mark_initialized("dcs-lua:1");
        assert_eq!(
            reg.reattach_target("dcs-lua", None).as_deref(),
            Some("dcs-lua:1")
        );

        // Mid-stop (stdin closed) is unhealthy even when initialized.
        reg.handles.get_mut("dcs-lua:1").unwrap().stdin = None;
        assert_eq!(reg.reattach_target("dcs-lua", None), None);

        drain(&mut reg);
    }

    /// A root-bound server (rust-analyzer) re-attaches ONLY for the same root.
    /// A re-attach for a different project root must miss — otherwise the
    /// inherited server keeps indexing the old root forever (Rust diagnostics
    /// silently dead after a cross-project reload, MR !20). The miss is what
    /// drives the caller to evict the stale server and spawn one that
    /// handshakes against the new root.
    #[test]
    fn reattach_requires_matching_root() {
        let mut reg = Registry::default();
        insert_handle(
            &mut reg,
            "rust-analyzer",
            "rust-analyzer:1",
            true,
            Some("/work/proj-a"),
        );

        // Same root: re-attach to the warm, already-indexed server.
        assert_eq!(
            reg.reattach_target("rust-analyzer", Some("/work/proj-a"))
                .as_deref(),
            Some("rust-analyzer:1")
        );
        // Different root: the live server is rooted elsewhere — refuse, so the
        // caller evicts it and spawns fresh against the new root.
        assert_eq!(reg.reattach_target("rust-analyzer", Some("/work/proj-b")), None);

        // The eviction the caller then performs clears both index levels, so
        // the next get_or_start spawns cleanly under a fresh physical id.
        let mut evicted = reg.remove("rust-analyzer").expect("stale present");
        let _ = evicted.child.kill();
        let _ = evicted.child.wait();
        assert!(reg.handles.is_empty());
        assert!(reg.logical.is_empty());
    }

    /// Evicting a stale server clears both index levels and is idempotent.
    #[test]
    fn remove_evicts_logical_and_physical() {
        let mut reg = Registry::default();
        insert_handle(&mut reg, "dcs-lua", "dcs-lua:1", true, None);

        let mut evicted = reg.remove("dcs-lua").expect("handle present");
        let _ = evicted.child.kill();
        let _ = evicted.child.wait();
        assert!(reg.handles.is_empty());
        assert!(reg.logical.is_empty());
        assert!(
            reg.remove("dcs-lua").is_none(),
            "second remove is a clean miss"
        );
    }

    /// Every respawn takes a brand-new physical id — a dying server's reader
    /// thread can never reap its replacement.
    #[test]
    fn physical_ids_are_unique_per_respawn() {
        let mut reg = Registry::default();
        assert_eq!(reg.next_physical("dcs-lua"), "dcs-lua:1");
        assert_eq!(reg.next_physical("dcs-lua"), "dcs-lua:2");
        assert_eq!(reg.next_physical("rust-analyzer"), "rust-analyzer:3");
    }
}
