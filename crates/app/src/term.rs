//! Integrated terminal commands (model/studio/term.pds, issue #13): thin
//! `#[tauri::command]` wrappers over the tauri-free session registry in
//! `studio_services::term`, plus the bridge from its output pump to the
//! webview.
//!
//! The registry owns the pseudo-terminals and replay buffers; this module
//! only (1) hands `spawn` a `sink` closure that emits each output chunk as
//! `term://data/{id}` and the stream's end as `term://exit/{id}`, and (2) for
//! a harness profile, exposes the IDE's MCP discovery file to the child's
//! environment before launch (the model's `EnsureHarnessMcp`, soft-dep on the
//! MCP server #8 — best-effort, since the harness-side consumer lands there).

use serde::Serialize;
use studio_services::term::{EnvVar, ReplaySnapshot, SessionInfo, SpawnSpec, TermEvent};
use tauri::{AppHandle, Emitter, Manager, State};

pub use studio_services::term::TermRegistry;

/// Environment variable a harness profile's child inherits, pointing at the
/// IDE's MCP discovery file so an agentic CLI can find the tool surface.
const MCP_ENV_VAR: &str = "DCS_STUDIO_MCP";

/// `term://data/{id}` payload — a chunk of raw output and the running byte
/// offset (`seq`) a remounting view splices replay and live output against.
#[derive(Clone, Serialize)]
struct DataPayload {
    bytes: Vec<u8>,
    seq: usize,
}

/// `term://exit/{id}` payload — the child's exit status when one is available.
#[derive(Clone, Serialize)]
struct ExitPayload {
    code: Option<i32>,
}

/// The built-in default shell profile's command + args (model
/// `ResolveProfile`'s "detected default shell").
#[derive(Clone, Serialize)]
pub struct ShellSpec {
    command: String,
    args: Vec<String>,
}

/// Spawn a session from an already-resolved launch spec (the frontend
/// `Terminal` orchestration resolved the profile, the project-root cwd, and
/// the label). For a harness profile, layer the MCP discovery path onto the
/// child's environment first. Then start the registry's pump, bridging each
/// chunk to `term://data/{id}` and the stream's end to `term://exit/{id}`.
#[tauri::command]
pub fn term_spawn(
    app: AppHandle,
    state: State<'_, TermRegistry>,
    id: String,
    mut spec: SpawnSpec,
    harness: bool,
) -> Result<(), String> {
    if harness {
        if let Some(path) = mcp_config_path(&app) {
            spec.env.push(EnvVar {
                key: MCP_ENV_VAR.to_string(),
                value: path,
            });
        }
    }
    let ev_app = app.clone();
    let ev_id = id.clone();
    state.spawn(id, spec, move |event| match event {
        TermEvent::Data { bytes, seq } => {
            let _ = ev_app.emit(&format!("term://data/{ev_id}"), DataPayload { bytes, seq });
        }
        TermEvent::Exit(code) => {
            let _ = ev_app.emit(&format!("term://exit/{ev_id}"), ExitPayload { code });
        }
    })
}

/// Send the developer's keystrokes (xterm's `onData` string) to a session's
/// pseudo-terminal input.
#[tauri::command]
pub fn term_write(state: State<'_, TermRegistry>, id: String, data: String) -> Result<(), String> {
    state.write(&id, data.as_bytes())
}

/// Resize a session's pseudo-terminal to the fitted cell dimensions.
#[tauri::command]
pub fn term_resize(
    state: State<'_, TermRegistry>,
    id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    state.resize(&id, rows, cols)
}

/// Kill a session and clean up its child, pty, and replay buffer.
#[tauri::command]
pub fn term_kill(state: State<'_, TermRegistry>, id: String) -> Result<(), String> {
    state.kill(&id)
}

/// The session's replay buffer + its byte offset — the recent output a freshly
/// mounted view writes before live streaming resumes, and the splice point it
/// dedups live chunks against. Empty for an unknown session.
#[tauri::command]
pub fn term_replay(state: State<'_, TermRegistry>, id: String) -> ReplaySnapshot {
    state.replay(&id)
}

/// The live sessions, for rebuilding the tab strip.
#[tauri::command]
pub fn term_list(state: State<'_, TermRegistry>) -> Vec<SessionInfo> {
    state.list()
}

/// The detected default shell for the built-in shell profile (prefer pwsh,
/// then Windows PowerShell, then cmd; the login shell elsewhere).
#[tauri::command]
pub fn term_default_shell() -> ShellSpec {
    let (command, args) = studio_services::term::default_shell();
    ShellSpec { command, args }
}

/// Kill every live session — wired to window close so no child outlives the
/// app (Windows has no SIGTERM), mirroring `lsp::stop_all`.
pub fn kill_all(app: &AppHandle) {
    if let Some(state) = app.try_state::<TermRegistry>() {
        state.kill_all();
    }
}

/// `<app-config>/mcp.json` as a string, or `None` if the config dir can't be
/// resolved (then a harness simply launches without the MCP env hint).
fn mcp_config_path(app: &AppHandle) -> Option<String> {
    let dir = app.path().app_config_dir().ok()?;
    Some(dir.join(crate::mcp::SESSION_FILE).display().to_string())
}
