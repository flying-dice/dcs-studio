#![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing, clippy::panic, clippy::print_stdout, clippy::print_stderr)] // integration test crate: test code, exempt from the production safety lints

//! The rust-dll template's "generated code compiles" claim, proven by
//! actually compiling it (issue #22): scaffold a project into a temp dir
//! and run a real `cargo check` on it. The unit tests in `templates.rs`
//! only string-assert the rendered sources; this is the type-level gate.
//!
//! `cargo check` type-checks the whole crate graph (mlua included) but
//! never links, so DCS's lua import library — a Windows-only artifact the
//! vendored `lua5.1/lua.lib` + `.cargo/config.toml` pin exists for — is
//! not needed. Link-level proof would require a real liblua and stays out
//! of scope.
//!
//! Opt-in: the check compiles mlua and friends (~30-60s), which would tax
//! every `cargo test -p dcs-studio-project`, so the test fast-skips unless
//! `DCS_TEMPLATE_COMPILE=1` is set. CI's `template-compile` job sets it;
//! run it locally the same way:
//!
//! ```text
//! DCS_TEMPLATE_COMPILE=1 cargo test -p dcs-studio-project --test template_compile
//! ```

use std::fs;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use dcs_studio_project::{quiet_command, scaffold};

/// Kill a process by id: `std::process::Child` can't be killed from a
/// watchdog thread without sharing the handle, but the OS tools can
/// (same pattern as `crates/app/tests/host_ipc.rs`). The ordering matters
/// as much as the mechanism: the watchdog is stood down only after both
/// pipes hit EOF and BEFORE the child is reaped — after `wait()` the PID
/// is free for reuse, so a freed PID is never killed.
fn kill_by_id(id: u32) {
    #[cfg(windows)]
    let _ = Command::new("taskkill")
        .args(["/PID", &id.to_string(), "/T", "/F"])
        .output();
    #[cfg(not(windows))]
    let _ = Command::new("kill").args(["-9", &id.to_string()]).output();
}

#[test]
fn rust_dll_template_passes_cargo_check() {
    if std::env::var("DCS_TEMPLATE_COMPILE").as_deref() != Ok("1") {
        eprintln!(
            "SKIP template_compile: set DCS_TEMPLATE_COMPILE=1 to run the \
             scaffold-and-cargo-check probe (CI's template-compile job does)"
        );
        return;
    }
    let cargo_present = quiet_command("cargo")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success());
    if !cargo_present {
        eprintln!("SKIP template_compile: cargo not on PATH");
        return;
    }

    let parent = std::env::temp_dir().join(format!("dcs-template-compile-{}", std::process::id()));
    let _ = fs::remove_dir_all(&parent);
    fs::create_dir_all(&parent).expect("temp dir");
    // The space in the name is deliberate: the path with a space must
    // survive the whole scaffold-then-check round trip.
    let root = scaffold::init("rust-dll", &parent, "Compile Probe").expect("scaffold succeeds");

    // cwd = the scaffolded root, NOT --manifest-path from here: cargo
    // discovers .cargo/config.toml upward from the cwd, and the template's
    // LUA_LIB pin must be the one in effect, not this workspace's.
    let mut command = quiet_command("cargo");
    command
        .arg("check")
        .current_dir(&root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().expect("spawn cargo check");

    // Watchdog: a wedged cargo (e.g. a stale registry lock) would block
    // the pipe drain below to the job timeout; a kill turns the blocked
    // reads into EOF instead. The budget is generous because a cold cache
    // compiles mlua and its deps from scratch.
    let watchdog_off = Arc::new(AtomicBool::new(false));
    let child_id = child.id();
    {
        let watchdog_off = Arc::clone(&watchdog_off);
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(300));
            if !watchdog_off.load(Ordering::SeqCst) {
                kill_by_id(child_id);
            }
        });
    }

    // Drain BOTH pipes to EOF first — the only phase that can wedge, so
    // the watchdog stays armed through it. stderr drains on its own
    // thread so neither pipe can deadlock the other on a full buffer.
    let mut stderr_pipe = child.stderr.take().expect("stderr piped");
    let stderr_drain = std::thread::spawn(move || {
        let mut stderr = Vec::new();
        let _ = stderr_pipe.read_to_end(&mut stderr);
        stderr
    });
    let mut stdout = Vec::new();
    let _ = child
        .stdout
        .take()
        .expect("stdout piped")
        .read_to_end(&mut stdout);
    let stderr = stderr_drain.join().expect("stderr drain thread");

    // Both pipes are at EOF, so cargo can no longer wedge: stand the
    // watchdog down BEFORE reaping (host_ipc.rs ordering) — after wait()
    // the PID is free for reuse and a late kill would hit an innocent
    // process.
    watchdog_off.store(true, Ordering::SeqCst);
    let status = child.wait().expect("cargo check completes");
    assert!(
        status.success(),
        "cargo check of the scaffolded rust-dll project failed:\n{}",
        String::from_utf8_lossy(&stderr)
    );
    let _ = fs::remove_dir_all(&parent);
}
