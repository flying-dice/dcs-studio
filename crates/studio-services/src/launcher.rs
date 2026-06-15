// Launch manager (model/studio/launcher.pds, issue #41): assert the bridge is
// injected, back up Config/options.lua, replace its graphics block with a fixed
// low-spec windowed profile, spawn DCS.exe, and — once DCS exits — eject the
// bridge and restore the user's config. DCS has no windowed/low-spec launch
// flag, so the window mode and graphics level are driven through options.lua,
// which is edited under a pristine backup (the studio::mission backup/restore
// shape). One launch session at a time, tracked process-wide.

use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::{Mutex, OnceLock, PoisonError};
use std::time::Duration;

use crate::{inject, mission};

/// The fixed low-spec windowed profile written into options.lua's graphics
/// block for a launch session. Restored away when DCS exits.
const PROFILE_WIDTH: u32 = 1280;
const PROFILE_HEIGHT: u32 = 720;

/// How often the watcher polls the spawned child for exit.
const WATCH_INTERVAL: Duration = Duration::from_secs(1);

/// One started DCS this manager owns: the child process plus where to undo the
/// side effects (eject the bridge, restore the config) when it exits.
struct LaunchSession {
    child: Child,
    write_dir: String,
    options_path: String,
}

/// Process-wide launch session, `None` when no DCS is running under the manager.
/// Whoever `take`s the session owns its teardown — so the watcher and an
/// explicit stop can never double-eject or double-restore.
fn state() -> &'static Mutex<Option<LaunchSession>> {
    static STATE: OnceLock<Mutex<Option<LaunchSession>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(None))
}

fn lock() -> std::sync::MutexGuard<'static, Option<LaunchSession>> {
    state().lock().unwrap_or_else(PoisonError::into_inner)
}

/// The result of starting a launch.
#[derive(serde::Serialize)]
pub struct LaunchOutcome {
    running: bool,
    exe_path: String,
    config_backed_up: bool,
}

/// Whether a launched DCS is still alive and whether the low-spec config is
/// currently in place.
#[derive(serde::Serialize)]
pub struct LaunchStatus {
    running: bool,
    config_patched: bool,
}

impl LaunchStatus {
    /// Whether a launched DCS is still alive — for callers that watch the
    /// session (the app's exit poll) without re-serializing.
    #[must_use]
    pub fn is_running(&self) -> bool {
        self.running
    }
}

fn backup_path(options_path: &str) -> PathBuf {
    PathBuf::from(format!("{options_path}.dcs-launcher.bak"))
}

/// `<write_dir>/Config/options.lua`.
fn options_path_for(write_dir: &str) -> String {
    Path::new(write_dir)
        .join("Config")
        .join("options.lua")
        .to_string_lossy()
        .into_owned()
}

/// Assert injection, back up + low-spec the config, then spawn DCS.exe. Fails
/// closed: a locked DLL (DCS already running) aborts before anything is written;
/// a failure after the config is written restores the backup first.
pub fn launch(write_dir: &str) -> Result<LaunchOutcome, String> {
    {
        // One session at a time: a still-alive child blocks a second launch.
        let mut guard = lock();
        if let Some(session) = guard.as_mut() {
            if matches!(session.child.try_wait(), Ok(None)) {
                return Err("a DCS launch is already running".to_string());
            }
        }
    }

    let options_path = options_path_for(write_dir);

    // Assert the bridge is present and current. inject is idempotent; when DCS
    // is already running it holds the DLL and this fails with the locked-file
    // error — exactly the "don't relaunch a live sim" guard.
    inject::inject(write_dir)?;

    backup_config(&options_path)?;

    if let Err(err) = write_low_spec(&options_path) {
        let _ = restore_config(&options_path);
        return Err(err);
    }

    let (exe_path, bin_dir) = match resolve_exe() {
        Ok(pair) => pair,
        Err(err) => {
            let _ = restore_config(&options_path);
            return Err(err);
        }
    };

    let child = match spawn_dcs(&exe_path, &bin_dir) {
        Ok(child) => child,
        Err(err) => {
            let _ = restore_config(&options_path);
            return Err(err);
        }
    };

    *lock() = Some(LaunchSession {
        child,
        write_dir: write_dir.to_string(),
        options_path,
    });
    spawn_watcher();

    Ok(LaunchOutcome {
        running: true,
        exe_path,
        config_backed_up: true,
    })
}

/// Whether a launched DCS is still alive and whether the config is still patched.
pub fn launch_status() -> LaunchStatus {
    let mut guard = lock();
    match guard.as_mut() {
        Some(session) => LaunchStatus {
            running: matches!(session.child.try_wait(), Ok(None)),
            config_patched: true,
        },
        None => LaunchStatus {
            running: false,
            config_patched: false,
        },
    }
}

/// Stop the launched DCS (if any), then run the same teardown its natural exit
/// would: eject the bridge and restore the config for `write_dir`. A no-op
/// (clean status) when nothing is running.
pub fn stop(write_dir: &str) -> Result<LaunchStatus, String> {
    let session = lock().take();
    if let Some(mut session) = session {
        let _ = session.child.kill();
        let _ = session.child.wait();
    }
    teardown(write_dir, &options_path_for(write_dir))?;
    Ok(LaunchStatus {
        running: false,
        config_patched: false,
    })
}

/// Copy options.lua to its `.dcs-launcher.bak` pristine snapshot (once).
fn backup_config(options_path: &str) -> Result<(), String> {
    if !Path::new(options_path).is_file() {
        return Err(format!(
            "DCS graphics config not found at '{options_path}' — launch DCS once so it writes Config/options.lua"
        ));
    }
    let bak = backup_path(options_path);
    if !bak.exists() {
        std::fs::copy(options_path, &bak)
            .map_err(|e| format!("Failed to back up to '{}': {e}", bak.display()))?;
    }
    Ok(())
}

/// Replace the options.graphics block with the low-spec windowed profile.
fn write_low_spec(options_path: &str) -> Result<(), String> {
    let content = std::fs::read_to_string(options_path)
        .map_err(|e| format!("Failed to read '{options_path}': {e}"))?;
    let eol = if content.contains("\r\n") { "\r\n" } else { "\n" };
    let patched = replace_graphics_block(&content, eol)?;
    std::fs::write(options_path, patched)
        .map_err(|e| format!("Failed to write '{options_path}': {e}"))
}

/// Copy the pristine backup back over options.lua and drop the backup, so the
/// next launch snapshots the user's then-current settings afresh. A no-op when
/// no backup exists (the config was never patched).
fn restore_config(options_path: &str) -> Result<(), String> {
    let bak = backup_path(options_path);
    if !bak.is_file() {
        return Ok(());
    }
    std::fs::copy(&bak, options_path)
        .map_err(|e| format!("Failed to restore '{options_path}': {e}"))?;
    let _ = std::fs::remove_file(&bak);
    Ok(())
}

/// Eject the bridge (best-effort — a failed eject must not block restoring the
/// user's config), then restore options.lua.
fn teardown(write_dir: &str, options_path: &str) -> Result<(), String> {
    let _ = inject::eject(write_dir);
    restore_config(options_path)
}

/// Resolve `(DCS.exe, bin dir)` under the detected game install.
fn resolve_exe() -> Result<(String, PathBuf), String> {
    let root = mission::default_game_install()
        .ok_or_else(|| "No DCS install found (registry + Program Files probes)".to_string())?;
    let bin_dir = root.join("bin");
    let exe = bin_dir.join("DCS.exe");
    if !exe.is_file() {
        return Err(format!("DCS.exe not found at '{}'", exe.display()));
    }
    Ok((exe.to_string_lossy().into_owned(), bin_dir))
}

/// Spawn DCS.exe detached (no piped IO, no console window), with its bin dir as
/// the working directory.
fn spawn_dcs(exe_path: &str, bin_dir: &Path) -> Result<Child, String> {
    dcs_studio_project::quiet_command(exe_path)
        .current_dir(bin_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("spawning DCS.exe: {e}"))
}

/// Poll the tracked child; once it exits, the first observer takes the session
/// and runs teardown exactly once.
fn spawn_watcher() {
    std::thread::spawn(|| {
        loop {
            {
                let mut guard = lock();
                let Some(session) = guard.as_mut() else {
                    return; // an explicit stop already took and tore down the session
                };
                let exited = !matches!(session.child.try_wait(), Ok(None));
                if exited {
                    let session = guard.take().expect("session present under the same lock");
                    drop(guard);
                    let _ = teardown(&session.write_dir, &session.options_path);
                    return;
                }
            }
            std::thread::sleep(WATCH_INTERVAL);
        }
    });
}

/// One `["key"] = value` line of the generated graphics table.
fn graphics_entries() -> Vec<(&'static str, String)> {
    let aspect = f64::from(PROFILE_WIDTH) / f64::from(PROFILE_HEIGHT);
    vec![
        ("fullScreen", "false".to_string()),
        ("width", PROFILE_WIDTH.to_string()),
        ("height", PROFILE_HEIGHT.to_string()),
        ("aspect", format!("{aspect}")),
        ("multiMonitorSetup", "\"1camera\"".to_string()),
        ("textures", "0".to_string()),
        ("terrainTextures", "\"min\"".to_string()),
        ("shadows", "0".to_string()),
        ("shadowTree", "false".to_string()),
        ("secondaryShadows", "0".to_string()),
        ("MSAA", "0".to_string()),
        ("SSAA", "0".to_string()),
        ("AF", "0".to_string()),
        ("water", "0".to_string()),
        ("visibRange", "\"Low\"".to_string()),
        ("heatBlr", "0".to_string()),
        ("LODmult", "0.5".to_string()),
        ("clutterMaxDistance", "0".to_string()),
        ("forestDetailsFactor", "0.5".to_string()),
        ("forestDistanceFactor", "0.5".to_string()),
        ("DOF", "0".to_string()),
        ("motionBlur", "0".to_string()),
        ("lights", "0".to_string()),
        ("effects", "0".to_string()),
    ]
}

/// Render the `{ … }` graphics table, indented under `indent`.
fn graphics_block(indent: &str, eol: &str) -> String {
    let inner = format!("{indent}\t");
    let mut out = String::from("{");
    out.push_str(eol);
    for (key, value) in graphics_entries() {
        out.push_str(&format!("{inner}[\"{key}\"] = {value},{eol}"));
    }
    out.push_str(indent);
    out.push('}');
    out
}

/// Replace the `["graphics"] = { … }` block in options.lua with the low-spec
/// table, preserving every other section. Brace-depth scan from the block's
/// opening `{` to its matching `}` (the DCS graphics block carries no braces
/// inside string values, so plain brace counting is sufficient).
fn replace_graphics_block(content: &str, eol: &str) -> Result<String, String> {
    let key = content
        .find("[\"graphics\"]")
        .ok_or_else(|| "no [\"graphics\"] block in options.lua".to_string())?;
    let open = key
        + content[key..]
            .find('{')
            .ok_or_else(|| "malformed [\"graphics\"] block (no '{')".to_string())?;

    let bytes = content.as_bytes();
    let mut depth = 0i32;
    let mut close = None;
    for (i, &b) in bytes.iter().enumerate().skip(open) {
        match b {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    close = Some(i);
                    break;
                }
            }
            _ => {}
        }
    }
    let close = close.ok_or_else(|| "unterminated [\"graphics\"] block".to_string())?;

    let line_start = content[..key].rfind('\n').map_or(0, |n| n + 1);
    let indent = &content[line_start..key];
    let block = graphics_block(indent, eol);

    Ok(format!("{}{}{}", &content[..open], block, &content[close + 1..]))
}

#[cfg(test)]
mod tests {
    use super::{backup_config, replace_graphics_block, restore_config, write_low_spec};

    const OPTIONS: &str = "options = {\n\t[\"VR\"] = {\n\t\t[\"enable\"] = false,\n\t},\n\t[\"graphics\"] = {\n\t\t[\"fullScreen\"] = true,\n\t\t[\"width\"] = 2560,\n\t\t[\"height\"] = 1440,\n\t\t[\"shadows\"] = 5,\n\t},\n\t[\"plugins\"] = {\n\t\t[\"foo\"] = 1,\n\t},\n}\n";

    #[test]
    fn replace_graphics_block_sets_low_spec_and_preserves_other_sections() {
        let patched = replace_graphics_block(OPTIONS, "\n").expect("patch");
        assert!(patched.contains("[\"fullScreen\"] = false,"));
        assert!(patched.contains("[\"width\"] = 1280,"));
        assert!(patched.contains("[\"height\"] = 720,"));
        // Untouched sections survive verbatim.
        assert!(patched.contains("[\"VR\"] = {"));
        assert!(patched.contains("[\"plugins\"] = {"));
        assert!(patched.contains("[\"foo\"] = 1,"));
        // The old fullscreen high-res values are gone.
        assert!(!patched.contains("[\"width\"] = 2560,"));
        assert!(!patched.contains("[\"fullScreen\"] = true,"));
    }

    #[test]
    fn replace_graphics_block_errors_when_absent() {
        let err = replace_graphics_block("options = {\n}\n", "\n").expect_err("no graphics");
        assert!(err.contains("no [\"graphics\"] block"));
    }

    fn temp_options(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("studio-launcher-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        let file = dir.join("options.lua");
        std::fs::write(&file, OPTIONS).expect("seed options");
        file
    }

    #[test]
    fn backup_patch_then_restore_round_trips_to_the_original_and_drops_the_backup() {
        let file = temp_options("roundtrip");
        let path = file.to_string_lossy().into_owned();

        backup_config(&path).expect("backup");
        let bak = format!("{path}.dcs-launcher.bak");
        assert_eq!(std::fs::read_to_string(&bak).expect("bak"), OPTIONS);

        write_low_spec(&path).expect("patch");
        assert!(std::fs::read_to_string(&path).expect("patched").contains("[\"width\"] = 1280,"));

        restore_config(&path).expect("restore");
        assert_eq!(std::fs::read_to_string(&path).expect("restored"), OPTIONS);
        assert!(!std::path::Path::new(&bak).exists(), "backup dropped after restore");

        let _ = std::fs::remove_dir_all(file.parent().unwrap());
    }

    #[test]
    fn restore_without_a_backup_is_a_clean_no_op() {
        let file = temp_options("no-backup");
        let path = file.to_string_lossy().into_owned();
        restore_config(&path).expect("no-op restore");
        assert_eq!(std::fs::read_to_string(&path).expect("unchanged"), OPTIONS);
        let _ = std::fs::remove_dir_all(file.parent().unwrap());
    }
}
