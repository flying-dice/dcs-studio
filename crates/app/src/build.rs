// Build service (model/studio/build.pds `Builder.RunBuild`, issue #6 R1):
// Rust projects spawn `cargo build --release` with stdout/stderr streamed
// line-by-line to the Output panel as `build://output` events; everything
// else builds as an immediate no-op. The model's guard order is normative:
// IsRustProject -> DetectToolchain -> SpawnCargo.

use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::Stdio;
use std::sync::{Mutex, PoisonError};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// One build at a time per app: `true` while a cargo build is running.
#[derive(Default)]
pub struct BuildState(Mutex<bool>);

/// `build://done` payload (model `BuildOutcome` + the no-op marker).
#[derive(Clone, Serialize)]
struct BuildDone {
    succeeded: bool,
    exit_code: i32,
    no_op: bool,
}

/// Probe the Rust toolchain (model `Builder.DetectToolchain`); absence is
/// data, never an error.
#[tauri::command]
pub fn toolchain_status() -> dcs_studio_project::ToolchainStatus {
    dcs_studio_project::toolchain::detect()
}

/// Locate rust-analyzer for the second hosted language server (issue #6
/// R2, model `studio::lang::RustAnalyzer`): `PATH` first, then the
/// rustup-managed component. A miss carries install guidance — the
/// webview provider treats it as non-fatal.
#[tauri::command]
pub fn rust_analyzer_path() -> Result<String, String> {
    dcs_studio_project::toolchain::rust_analyzer().ok_or_else(|| {
        "rust-analyzer not found — install it with `rustup component add rust-analyzer`".to_string()
    })
}

/// Run a build of the project at `root` (model `Builder.RunBuild`).
/// Returns as soon as cargo is spawned; output and completion arrive as
/// `build://output` / `build://done` events.
#[tauri::command]
pub fn build_project(
    app: AppHandle,
    state: State<'_, BuildState>,
    root: String,
) -> Result<(), String> {
    // Guard 1 (model): not a Rust project -> succeed as a no-op.
    if !Path::new(&root).join("Cargo.toml").is_file() {
        emit_done(&app, &state, true, 0, true);
        return Ok(());
    }

    // Guard 2 (model): a missing cargo fails with install guidance.
    let toolchain = dcs_studio_project::toolchain::detect();
    if toolchain.cargo.is_none() {
        return Err("cargo not found — install Rust via https://rustup.rs".to_string());
    }

    // One build at a time: check-and-set under the lock. Poison-tolerant
    // (like the clear sites) so a panicked build thread never wedges
    // future builds.
    {
        let mut busy = state.0.lock().unwrap_or_else(PoisonError::into_inner);
        if *busy {
            return Err("a build is already running".to_string());
        }
        *busy = true;
    }

    match spawn_cargo(&root) {
        Ok(child) => {
            stream_build(app, child);
            Ok(())
        }
        Err(e) => {
            clear_busy(&app);
            Err(e)
        }
    }
}

/// Spawn `cargo build --release` in `root` with piped output and no
/// console window (model `Builder.SpawnCargo`).
fn spawn_cargo(root: &str) -> Result<std::process::Child, String> {
    dcs_studio_project::quiet_command("cargo")
        .args(["build", "--release"])
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawning cargo: {e}"))
}

/// Pump both output streams as `build://output` lines, then report the
/// exit as `build://done` and release the busy flag.
fn stream_build(app: AppHandle, mut child: std::process::Child) {
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    std::thread::spawn(move || {
        let stderr_pump = stderr.map(|stderr| {
            let stderr_app = app.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    let _ = stderr_app.emit("build://output", line);
                }
            })
        });
        if let Some(stdout) = stdout {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let _ = app.emit("build://output", line);
            }
        }
        if let Some(pump) = stderr_pump {
            let _ = pump.join();
        }

        let (succeeded, exit_code) = match child.wait() {
            Ok(status) => (status.success(), status.code().unwrap_or(-1)),
            Err(_) => (false, -1),
        };
        clear_busy(&app);
        let _ = app.emit(
            "build://done",
            BuildDone {
                succeeded,
                exit_code,
                no_op: false,
            },
        );
    });
}

fn emit_done(
    app: &AppHandle,
    state: &State<'_, BuildState>,
    succeeded: bool,
    code: i32,
    no_op: bool,
) {
    // The no-op path never set the busy flag, but keep the invariant simple:
    // done always leaves the state idle.
    *state.0.lock().unwrap_or_else(PoisonError::into_inner) = false;
    let _ = app.emit(
        "build://done",
        BuildDone {
            succeeded,
            exit_code: code,
            no_op,
        },
    );
}

fn clear_busy(app: &AppHandle) {
    use tauri::Manager as _;
    if let Some(state) = app.try_state::<BuildState>() {
        // Poison-tolerant: even if the build thread panicked mid-stream,
        // the busy flag must come down or no build ever runs again.
        *state.0.lock().unwrap_or_else(PoisonError::into_inner) = false;
    }
}
