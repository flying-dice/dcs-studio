//! studio-services::term — the integrated terminal session registry
//! (model/studio/term.pds, issue #13).
//!
//! Tauri-free, mirroring this crate's other services: owns the live
//! pseudo-terminals (wezterm's `portable-pty`, ConPTY-backed on Windows),
//! a bounded replay ring buffer per session, and the per-session output pump.
//! The app crate wraps these in thin `#[tauri::command]`s and bridges the
//! pump's `sink` callback to `term://data/{id}` / `term://exit/{id}` events.
//!
//! Realises the model's `PtySession` adapter (`spawn`/`write`/`resize`/`kill`)
//! and the `Terminal` container's registry helpers (register / find / drop
//! buffer / deregister) and replay rule. A session outlives the view that
//! unmounts on panel collapse: the pump keeps appending to the ring buffer
//! Rust-side, and [`TermRegistry::replay`] hands a freshly mounted view the
//! buffered tail before live streaming resumes. Each output chunk carries a
//! monotonic byte offset (`seq` = total bytes produced through that chunk) so
//! a remounting view can splice replay and live output with neither a gap nor
//! a repeat (model `ReplayThenLiveOnRemount`).

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};

/// Largest tail of output a session retains for replay (model
/// `BUFFER_REPLAY_BYTES`). A long-lived session trims its ring buffer to this
/// so it can't grow without bound; a freshly mounted view replays at most this
/// much before live output resumes.
pub const BUFFER_REPLAY_BYTES: usize = 204_800;

/// Size of each read from a session's pseudo-terminal before it is appended
/// and streamed.
const READ_CHUNK_BYTES: usize = 8192;

/// One environment variable layered onto a profile's child process.
#[derive(Clone, serde::Deserialize)]
pub struct EnvVar {
    pub key: String,
    pub value: String,
}

/// A resolved launch spec: the profile already resolved by the caller (the
/// frontend `Terminal` orchestration) to a concrete command, working
/// directory, layered environment, and initial size. The registry never reads
/// settings — resolving a profile id to this is the caller's job.
#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnSpec {
    /// The profile this session was launched from — carried so [`list`] can
    /// rebuild the tab strip.
    ///
    /// [`list`]: TermRegistry::list
    pub profile_id: String,
    /// The label shown on the session's tab.
    pub label: String,
    /// Program to run (already shell-detected for the default profile).
    pub command: String,
    pub args: Vec<String>,
    /// Working directory — the open project root for the built-in profiles;
    /// `None` inherits the app's cwd.
    pub cwd: Option<String>,
    /// Environment layered onto the inherited environment (e.g. the MCP
    /// discovery path the app injects for harness profiles).
    #[serde(default)]
    pub env: Vec<EnvVar>,
    pub rows: u16,
    pub cols: u16,
}

/// One live session in the tab strip (model `Session`).
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub profile_id: String,
    pub label: String,
}

/// The recent output a freshly mounted view replays (model `Terminal.Replay`):
/// the ring-buffer tail plus `seq`, the total bytes produced through the tail's
/// last byte. A view writes the tail and then ignores any live chunk whose
/// `seq` is `<= seq` here — so replay and live never overlap or gap.
#[derive(Clone, serde::Serialize)]
pub struct ReplaySnapshot {
    pub bytes: Vec<u8>,
    pub seq: usize,
}

/// What the output pump hands the sink: a chunk of raw output tagged with the
/// running byte offset, or the stream's end carrying the child's exit code
/// (model `SessionExited`).
pub enum TermEvent {
    Data { bytes: Vec<u8>, seq: usize },
    Exit(Option<i32>),
}

/// A live pseudo-terminal: the master (for resize), its writer (the child's
/// input), the child killer, the replay ring buffer, and the monotonic count
/// of bytes ever produced (never trimmed — the buffer is, this isn't). The
/// pump thread owns the reader and the child; everything term commands touch
/// lives here.
struct Session {
    profile_id: String,
    label: String,
    master: Box<dyn MasterPty + Send>,
    /// The child's stdin, behind its own lock so a blocking write — a child not
    /// draining its input — stalls only this session, never the registry map:
    /// other tabs' commands and every output pump keep running (model
    /// `ConcurrentSessionsAreIsolated`).
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    buffer: VecDeque<u8>,
    produced: usize,
}

/// The integrated terminal's session registry. `Default` so the app can
/// `.manage(TermRegistry::default())`; a cloneable handle is held by each pump
/// thread for appending to the ring buffer and deregistering on exit.
#[derive(Default)]
pub struct TermRegistry {
    sessions: Arc<Mutex<HashMap<String, Session>>>,
}

/// Append `chunk` to a session's ring buffer, trimming the oldest bytes from the
/// head so the buffer never exceeds `cap` — the model's "ring buffer capped at
/// BUFFER_REPLAY_BYTES" rule. A `VecDeque`, so both the append and the head trim
/// are amortized O(1): the trim advances the head instead of memmoving the
/// retained tail, so sustained bulk output (a build, a log tail) never pays an
/// O(cap) shift per chunk under the registry lock. A chunk larger than `cap`
/// keeps only its tail.
fn append_capped(buffer: &mut VecDeque<u8>, chunk: &[u8], cap: usize) {
    buffer.extend(chunk.iter().copied());
    if buffer.len() > cap {
        let overflow = buffer.len() - cap;
        buffer.drain(..overflow);
    }
}

impl TermRegistry {
    /// Spawn a new session: open a pseudo-terminal of the spec's size, spawn
    /// the command in it, register it, and start pumping its output through
    /// `sink`. Mirrors `lsp.rs`: the session is registered BEFORE the pump
    /// thread starts, so a child that dies instantly can't be reaped (and its
    /// exit delivered) before the entry exists. A command that can't be
    /// spawned registers nothing and returns the error. A duplicate id is a
    /// caller bug and errs rather than silently leaking the old session.
    pub fn spawn(
        &self,
        id: String,
        spec: SpawnSpec,
        sink: impl Fn(TermEvent) + Send + 'static,
    ) -> Result<(), String> {
        // Reject a duplicate id before opening a pseudo-terminal, so a caller
        // bug never spawns a child we'd immediately discard. The authoritative
        // re-check is under the lock below, in case a concurrent spawn races us.
        {
            let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
            if sessions.contains_key(&id) {
                return Err(format!("terminal session '{id}' already exists"));
            }
        }

        let pty = native_pty_system()
            .openpty(PtySize {
                rows: spec.rows,
                cols: spec.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;

        let mut command = CommandBuilder::new(&spec.command);
        command.args(&spec.args);
        if let Some(cwd) = &spec.cwd {
            command.cwd(cwd);
        }
        for var in &spec.env {
            command.env(&var.key, &var.value);
        }

        let mut child = pty
            .slave
            .spawn_command(command)
            .map_err(|e| format!("spawning {}: {e}", spec.command))?;
        // Drop the slave once the child holds it: keeping it open wedges the
        // master reader's EOF when the child exits.
        drop(pty.slave);

        let reader = pty.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pty.master.take_writer().map_err(|e| e.to_string())?;
        let killer = child.clone_killer();

        {
            let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
            if sessions.contains_key(&id) {
                // A concurrent spawn won the race after our pre-check — kill the
                // child we just started rather than leak it on the dropped pty.
                let _ = child.kill();
                return Err(format!("terminal session '{id}' already exists"));
            }
            sessions.insert(
                id.clone(),
                Session {
                    profile_id: spec.profile_id,
                    label: spec.label,
                    master: pty.master,
                    writer: Arc::new(Mutex::new(writer)),
                    killer,
                    buffer: VecDeque::new(),
                    produced: 0,
                },
            );
        }

        let sessions = self.sessions.clone();
        std::thread::spawn(move || pump(reader, &mut *child, &id, &sessions, &sink));
        Ok(())
    }

    /// Forward the developer's keystrokes to a session's pseudo-terminal input
    /// (model `Terminal.Write`). Writing to a gone session is a no-op, never an
    /// error — the tab may be mid-teardown.
    pub fn write(&self, id: &str, bytes: &[u8]) -> Result<(), String> {
        // Take a handle to just this session's writer under a short lock, then
        // release the registry map before the (potentially blocking) write: a
        // child not draining its input must stall only this tab, not freeze the
        // whole terminal (model `ConcurrentSessionsAreIsolated`).
        let writer = {
            let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
            match sessions.get(id) {
                Some(session) => Arc::clone(&session.writer),
                None => return Ok(()),
            }
        };
        let mut writer = writer.lock().map_err(|e| e.to_string())?;
        writer
            .write_all(bytes)
            .and_then(|()| writer.flush())
            .map_err(|e| e.to_string())
    }

    /// Resize a session's pseudo-terminal so the child redraws (model
    /// `Terminal.Resize`). A gone session is a no-op.
    pub fn resize(&self, id: &str, rows: u16, cols: u16) -> Result<(), String> {
        let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        let Some(session) = sessions.get(id) else {
            return Ok(());
        };
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())
    }

    /// Terminate a session and clean up everything it owns — the model's
    /// `Terminal.Kill`: kill the child, close the pseudo-terminal, drop the
    /// replay buffer, and remove it from the registry. Killing the child closes
    /// its slave, which EOFs the pump's reader — the pump then reaps and
    /// delivers the exit; removing the entry drops the master, writer, and
    /// buffer. An already-gone session is a no-op.
    pub fn kill(&self, id: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        if let Some(mut session) = sessions.remove(id) {
            let _ = session.killer.kill();
        }
        Ok(())
    }

    /// The recent output a freshly mounted view replays before live streaming
    /// resumes (model `Terminal.Replay`): the session's ring buffer (never more
    /// than [`BUFFER_REPLAY_BYTES`]) plus the byte offset of its end. Empty,
    /// `seq` 0, for an unknown session.
    pub fn replay(&self, id: &str) -> ReplaySnapshot {
        self.sessions
            .lock()
            .ok()
            .and_then(|sessions| {
                sessions.get(id).map(|session| {
                    // The ring buffer may wrap; flatten its two slices into the
                    // contiguous tail the view replays.
                    let (head, tail) = session.buffer.as_slices();
                    let mut bytes = Vec::with_capacity(head.len() + tail.len());
                    bytes.extend_from_slice(head);
                    bytes.extend_from_slice(tail);
                    ReplaySnapshot {
                        bytes,
                        seq: session.produced,
                    }
                })
            })
            .unwrap_or(ReplaySnapshot {
                bytes: Vec::new(),
                seq: 0,
            })
    }

    /// The live sessions (model `Terminal.List`), for rebuilding the tab strip.
    pub fn list(&self) -> Vec<SessionInfo> {
        let Ok(sessions) = self.sessions.lock() else {
            return Vec::new();
        };
        sessions
            .iter()
            .map(|(id, session)| SessionInfo {
                id: id.clone(),
                profile_id: session.profile_id.clone(),
                label: session.label.clone(),
            })
            .collect()
    }

    /// Kill every live session — wired to window close so no child outlives the
    /// app (Windows has no SIGTERM). Mirrors `lsp::stop_all`.
    pub fn kill_all(&self) {
        let Ok(mut sessions) = self.sessions.lock() else {
            return;
        };
        for (_, mut session) in sessions.drain() {
            let _ = session.killer.kill();
        }
    }
}

/// Pump one session's pseudo-terminal output until its stream ends: append
/// every chunk to the session's ring buffer (trimming past
/// [`BUFFER_REPLAY_BYTES`]), advance its byte counter, and hand the chunk and
/// the new offset to `sink`; when the stream ends (the child exited or was
/// killed), deregister the session and deliver its exit code. Deregistering
/// here is harmless if `kill` already removed the entry.
fn pump(
    mut reader: Box<dyn Read + Send>,
    child: &mut (dyn portable_pty::Child + Send + Sync),
    id: &str,
    sessions: &Arc<Mutex<HashMap<String, Session>>>,
    sink: &(impl Fn(TermEvent) + Send + 'static),
) {
    let mut buf = [0u8; READ_CHUNK_BYTES];
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let chunk = &buf[..n];
                let seq = match sessions.lock() {
                    Ok(mut map) => match map.get_mut(id) {
                        Some(session) => {
                            append_capped(&mut session.buffer, chunk, BUFFER_REPLAY_BYTES);
                            session.produced += n;
                            session.produced
                        }
                        // Killed: the entry is gone — stop pumping.
                        None => break,
                    },
                    Err(_) => break,
                };
                sink(TermEvent::Data {
                    bytes: chunk.to_vec(),
                    seq,
                });
            }
        }
    }

    let code = child.wait().ok().map(|status| status.exit_code() as i32);
    if let Ok(mut map) = sessions.lock() {
        map.remove(id);
    }
    sink(TermEvent::Exit(code));
}

/// The command for the built-in default shell profile (model `ResolveProfile`'s
/// "detected default shell"): prefer `pwsh`, then Windows PowerShell, then
/// `cmd` on Windows; the login shell (`$SHELL`) else `/bin/sh` elsewhere.
/// Returns `(command, args)`.
pub fn default_shell() -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        for candidate in ["pwsh.exe", "powershell.exe", "cmd.exe"] {
            if on_path(candidate) {
                return (candidate.to_string(), Vec::new());
            }
        }
        ("cmd.exe".to_string(), Vec::new())
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        (shell, Vec::new())
    }
}

/// Whether `program` is found on `PATH` — a minimal `which`, used only to pick
/// the default shell on Windows.
#[cfg(windows)]
fn on_path(program: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| dir.join(program).is_file())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::mpsc;
    use std::time::Duration;

    /// Drain `sink` events into a channel so a test can await output and exit.
    fn collector() -> (
        impl Fn(TermEvent) + Send + 'static,
        mpsc::Receiver<TermEvent>,
    ) {
        let (tx, rx) = mpsc::channel();
        (
            move |event| {
                let _ = tx.send(event);
            },
            rx,
        )
    }

    /// Read events until the wanted text shows in the output or the stream
    /// exits — returns all output bytes seen, the last seq, and whether an exit
    /// arrived.
    fn drain(rx: &mpsc::Receiver<TermEvent>, want: &str) -> (Vec<u8>, usize, bool) {
        let mut out = Vec::new();
        let mut last_seq = 0;
        loop {
            match rx.recv_timeout(Duration::from_secs(5)) {
                Ok(TermEvent::Data { bytes, seq }) => {
                    out.extend_from_slice(&bytes);
                    last_seq = seq;
                    if !want.is_empty() && String::from_utf8_lossy(&out).contains(want) {
                        return (out, last_seq, false);
                    }
                }
                Ok(TermEvent::Exit(_)) => return (out, last_seq, true),
                Err(_) => return (out, last_seq, false),
            }
        }
    }

    fn shell(script: &str) -> SpawnSpec {
        SpawnSpec {
            profile_id: "test".into(),
            label: "test".into(),
            command: "/bin/sh".into(),
            args: vec!["-c".into(), script.into()],
            cwd: None,
            env: Vec::new(),
            rows: 24,
            cols: 80,
        }
    }

    #[test]
    fn append_capped_keeps_only_the_tail() {
        let mut buffer = VecDeque::new();
        append_capped(&mut buffer, &[1, 2, 3], 4);
        assert_eq!(buffer, VecDeque::from([1, 2, 3]));
        append_capped(&mut buffer, &[4, 5], 4);
        assert_eq!(
            buffer,
            VecDeque::from([2, 3, 4, 5]),
            "oldest byte trimmed to the cap"
        );
        append_capped(&mut buffer, &[6, 7, 8, 9, 10], 4);
        assert_eq!(
            buffer,
            VecDeque::from([7, 8, 9, 10]),
            "a chunk over the cap keeps its tail"
        );
    }

    #[test]
    #[cfg_attr(not(unix), ignore = "uses /bin/sh")]
    fn output_streams_and_exit_is_delivered_and_deregisters() {
        let registry = TermRegistry::default();
        let (sink, rx) = collector();
        registry
            .spawn("a".into(), shell("printf hello"), sink)
            .expect("spawn");

        let (out, seq, _) = drain(&rx, "hello");
        assert!(
            String::from_utf8_lossy(&out).contains("hello"),
            "saw {out:?}"
        );
        assert!(seq >= 5, "seq advances with bytes produced, got {seq}");
        // The child exits on its own; the pump must deliver an exit and
        // deregister the session (model SpontaneousExitCleansUp).
        loop {
            match rx.recv_timeout(Duration::from_secs(5)) {
                Ok(TermEvent::Exit(_)) => break,
                Ok(TermEvent::Data { .. }) => {}
                Err(_) => panic!("no exit delivered"),
            }
        }
        std::thread::sleep(Duration::from_millis(50));
        assert!(registry.list().is_empty(), "exited session deregistered");
        assert!(
            registry.replay("a").bytes.is_empty(),
            "buffer dropped on exit"
        );
    }

    #[test]
    #[cfg_attr(not(unix), ignore = "uses /bin/cat")]
    fn write_reaches_the_child_and_kill_cleans_up() {
        let registry = TermRegistry::default();
        let (sink, rx) = collector();
        // `cat` echoes its stdin back — a long-lived session to write into.
        registry
            .spawn(
                "c".into(),
                SpawnSpec {
                    command: "/bin/cat".into(),
                    args: Vec::new(),
                    ..shell("")
                },
                sink,
            )
            .expect("spawn");

        registry.write("c", b"ping\n").expect("write");
        let (out, seq, _) = drain(&rx, "ping");
        assert!(
            String::from_utf8_lossy(&out).contains("ping"),
            "saw {out:?}"
        );
        // Replay carries the same byte offset the live chunk did — the splice
        // point a remounting view dedups against.
        assert_eq!(registry.replay("c").seq, seq, "replay seq matches live seq");

        assert_eq!(registry.list().len(), 1, "session live before kill");
        registry.kill("c").expect("kill");
        std::thread::sleep(Duration::from_millis(100));
        // Kill cleans up all three: registry entry, buffer, child (model
        // KillSessionCleansUp).
        assert!(registry.list().is_empty(), "killed session deregistered");
        assert!(
            registry.replay("c").bytes.is_empty(),
            "buffer dropped on kill"
        );
    }

    #[test]
    #[cfg_attr(not(unix), ignore = "uses /bin/cat")]
    fn concurrent_sessions_route_only_their_own_io() {
        // Two `cat` sessions; each echoes only what is written to it (model
        // ConcurrentSessionsAreIsolated): input and output never cross tabs.
        let registry = TermRegistry::default();
        let cat = || SpawnSpec {
            command: "/bin/cat".into(),
            args: Vec::new(),
            ..shell("")
        };
        let (sink_x, rx_x) = collector();
        let (sink_y, rx_y) = collector();
        registry.spawn("x".into(), cat(), sink_x).expect("spawn x");
        registry.spawn("y".into(), cat(), sink_y).expect("spawn y");

        registry.write("x", b"alpha\n").expect("write x");
        registry.write("y", b"beta\n").expect("write y");

        let (out_x, _, _) = drain(&rx_x, "alpha");
        let (out_y, _, _) = drain(&rx_y, "beta");
        let seen_x = String::from_utf8_lossy(&out_x);
        let seen_y = String::from_utf8_lossy(&out_y);
        assert!(
            seen_x.contains("alpha") && !seen_x.contains("beta"),
            "x saw {seen_x:?}"
        );
        assert!(
            seen_y.contains("beta") && !seen_y.contains("alpha"),
            "y saw {seen_y:?}"
        );

        registry.kill_all();
    }

    #[test]
    fn duplicate_id_is_rejected() {
        let registry = TermRegistry::default();
        let (sink_a, _rx_a) = collector();
        registry
            .spawn("dup".into(), shell("sleep 5"), sink_a)
            .expect("first spawn");
        let (sink_b, _rx_b) = collector();
        let err = registry
            .spawn("dup".into(), shell("sleep 5"), sink_b)
            .expect_err("duplicate id must be rejected");
        assert!(err.contains("already exists"), "got {err}");
        registry.kill_all();
    }

    #[test]
    fn unknown_session_write_resize_kill_are_no_ops() {
        let registry = TermRegistry::default();
        // Model Write/Resize/Kill: a gone (or never-known) session is a no-op,
        // never an error.
        registry.write("ghost", b"x").expect("write no-op");
        registry.resize("ghost", 40, 120).expect("resize no-op");
        registry.kill("ghost").expect("kill no-op");
        let snapshot = registry.replay("ghost");
        assert!(snapshot.bytes.is_empty());
        assert_eq!(snapshot.seq, 0);
    }

    #[test]
    fn spawning_a_missing_command_errors() {
        let registry = TermRegistry::default();
        let (sink, _rx) = collector();
        let err = registry
            .spawn(
                "x".into(),
                SpawnSpec {
                    command: "dcs-studio-no-such-binary-xyz".into(),
                    args: Vec::new(),
                    ..shell("")
                },
                sink,
            )
            .expect_err("missing command must surface as a SpawnError");
        assert!(err.contains("spawning"), "got {err}");
        assert!(registry.list().is_empty(), "failed spawn registers nothing");
    }

    #[test]
    fn default_shell_is_resolvable() {
        let (command, _args) = default_shell();
        assert!(
            !command.is_empty(),
            "a default shell command is always chosen"
        );
        #[cfg(not(windows))]
        assert!(
            command.contains('/'),
            "unix shell is an absolute path: {command}"
        );
    }
}
