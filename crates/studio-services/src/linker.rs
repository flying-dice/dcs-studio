//! Filesystem linker for Marketplace install (model studio::market `Library`,
//! issue #10/#12): place a destination as a LINK into the content store, never a
//! copy — so installed mods stay a single source of truth and uninstall just
//! drops the link. Strategy (mirrors the project's proven NodeJS linker):
//!
//! - directory target → **junction** (Windows) / symlink (Unix) — no elevation;
//! - file target, same volume → **hard link** — no elevation;
//! - file target, cross-volume → **symbolic link** (may need Developer Mode /
//!   elevation on Windows).
//!
//! Junctions + hard links cover the common DCS case (Saved Games on the same
//! drive as the store) without any privilege prompt.

use std::io;
use std::path::Path;

use studio_archive::extended_path;

/// Windows file-lock error codes: a path held open by another process surfaces as
/// one of these — the common cause being a running DCS holding installed mod files.
/// ERROR_ACCESS_DENIED (5), ERROR_SHARING_VIOLATION (32), ERROR_LOCK_VIOLATION (33).
/// Pure → unit-tested on every platform.
fn is_lock_code(code: i32) -> bool {
    matches!(code, 5 | 32 | 33)
}

/// Whether `e` looks like a path locked by another process — Windows only (Unix
/// has no mandatory lock that blocks an unlink/replace this way, so the hint would
/// mislead).
fn looks_locked(e: &io::Error) -> bool {
    cfg!(windows) && e.raw_os_error().is_some_and(is_lock_code)
}

/// The "is DCS running?" tail appended to a filesystem error when the OS reports
/// the path is locked. Pure → unit-tested.
fn lock_hint(locked: bool) -> &'static str {
    if locked {
        " — is DCS running? Close it and retry."
    } else {
        ""
    }
}

/// Format a filesystem error for `path`, appending the locked-by-DCS hint when the
/// OS reports the path is held open by another process (issue #62 hardening).
fn fs_err(context: &str, path: &Path, e: &io::Error) -> String {
    format!("{context} {}: {e}{}", path.display(), lock_hint(looks_locked(e)))
}

/// Create a link at `link_path` pointing to `target`. Creates parent dirs.
/// Refuses if `link_path` already exists (never clobbers the user's files).
pub fn link(link_path: &Path, target: &Path) -> Result<(), String> {
    if extended_path(link_path).symlink_metadata().is_ok() {
        return Err(format!("destination already exists: {}", link_path.display()));
    }
    if let Some(parent) = link_path.parent() {
        std::fs::create_dir_all(extended_path(parent)).map_err(|e| fs_err("create", parent, &e))?;
    }
    let meta = std::fs::metadata(extended_path(target)).map_err(|e| fs_err("link target", target, &e))?;
    if meta.is_dir() {
        link_dir(link_path, target)
    } else {
        link_file(link_path, target)
    }
}

/// Remove a previously placed link WITHOUT following it into the target — so the
/// user's real files (the link's target) are never touched. A no-op if gone.
pub fn unlink(link_path: &Path) -> Result<(), String> {
    let Ok(meta) = extended_path(link_path).symlink_metadata() else {
        return Ok(());
    };
    // A junction / dir-symlink reports as a dir; `remove_dir` drops the link
    // itself (it does not recurse into the target). A file link → remove_file.
    let result = if meta.is_dir() {
        std::fs::remove_dir(extended_path(link_path))
    } else {
        std::fs::remove_file(extended_path(link_path))
    };
    result.map_err(|e| fs_err("remove link", link_path, &e))
}

// The directory case is a junction — a single reparse point at the (shallow) DCS
// dest. The deep tree that risks MAX_PATH lives INSIDE the extracted store, which
// `studio_archive::extract` writes via extended-length paths; DCS resolves through
// the reparse point without the junction itself needing the `\\?\` form, so the
// PowerShell `New-Item` path below is left as-is.
#[cfg(windows)]
fn link_dir(link_path: &Path, target: &Path) -> Result<(), String> {
    junction(link_path, target)
}

#[cfg(not(windows))]
fn link_dir(link_path: &Path, target: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(target, link_path).map_err(|e| format!("symlink dir: {e}"))
}

#[cfg(windows)]
fn link_file(link_path: &Path, target: &Path) -> Result<(), String> {
    // Same volume → hard link (no elevation). Extended-length paths so a deep
    // store target / dest survives MAX_PATH (issue #62).
    if same_volume(link_path, target)
        && std::fs::hard_link(extended_path(target), extended_path(link_path)).is_ok()
    {
        return Ok(());
    }
    // Cross-volume (or a failed hard link) → file symlink. Try unprivileged first
    // — works when Windows Developer Mode is on — then fall back to a one-shot
    // elevated `mklink` (a single UAC prompt), mirroring the original NodeJS
    // linker's createSymlinkElevated. The common same-drive case never reaches here.
    if std::os::windows::fs::symlink_file(extended_path(target), extended_path(link_path)).is_ok() {
        return Ok(());
    }
    symlink_file_elevated(link_path, target)
}

/// Create a file symlink through ELEVATED PowerShell (one UAC prompt) — the
/// cross-volume fallback when Developer Mode is off.
#[cfg(windows)]
fn symlink_file_elevated(link_path: &Path, target: &Path) -> Result<(), String> {
    let command = elevated_symlink_command(
        &link_path.display().to_string(),
        &target.display().to_string(),
    );
    std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &command])
        .output()
        .map_err(|e| format!("symlink elevation could not launch: {e}"))?;
    // Authoritative success check: the link exists AND resolves to the intended
    // target. read_link (vs a bare existence check) defeats a false success from
    // a foreign/redirected link — and from any elevated command that created a
    // DIFFERENT link than asked. A wrong link is removed, never adopted as ours.
    match std::fs::read_link(link_path) {
        Ok(got) if same_file(&got, target) => Ok(()),
        Ok(other) => {
            let _ = std::fs::remove_file(link_path);
            Err(format!(
                "elevated symlink pointed at {} not {} — removed",
                other.display(),
                target.display()
            ))
        }
        Err(e) => Err(format!(
            "cross-volume symlink needs privilege; the UAC elevation was declined or failed ({e}). Enable Windows Developer Mode to link without a prompt."
        )),
    }
}

/// Whether a symlink's recorded target resolves to the same file as `target`.
#[cfg(windows)]
fn same_file(link_target: &Path, target: &Path) -> bool {
    match (std::fs::canonicalize(link_target), std::fs::canonicalize(target)) {
        (Ok(a), Ok(b)) => a == b,
        _ => link_target == target,
    }
}

/// Base64 (UTF-16LE) of a `New-Item -ItemType <kind> -Path … -Target …` script
/// for PowerShell `-EncodedCommand`. Because the script is base64-encoded,
/// NOTHING in the paths reaches a shell parser — no `cmd` `%VAR%` expansion, no
/// PowerShell `$`/quote expansion, no quoting breakout. Inside the script the
/// paths are single-quoted PS literals (only `'` doubled). Pure → unit-tested.
#[cfg_attr(not(windows), allow(dead_code))]
fn encoded_new_item(kind: &str, link: &str, target: &str) -> String {
    use base64::Engine as _;
    let lit = |s: &str| format!("'{}'", s.replace('\'', "''"));
    let script = format!(
        "New-Item -ItemType {kind} -Path {} -Target {} -ErrorAction Stop | Out-Null",
        lit(link),
        lit(target),
    );
    let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64::engine::general_purpose::STANDARD.encode(utf16)
}

/// The PowerShell command that creates a file symlink with one UAC prompt: an
/// elevated `Start-Process` running the base64 `New-Item` script. The outer
/// (un-elevated) command embeds only the base64 blob (alphanumeric + `/ + =` —
/// no quote/expansion hazards). Pure → unit-tested without elevating.
#[cfg_attr(not(windows), allow(dead_code))]
fn elevated_symlink_command(link: &str, target: &str) -> String {
    let encoded = encoded_new_item("SymbolicLink", link, target);
    format!(
        "Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','{encoded}' -Verb RunAs -Wait -WindowStyle Hidden"
    )
}

#[cfg(not(windows))]
fn link_file(link_path: &Path, target: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(target, link_path).map_err(|e| format!("symlink file: {e}"))
}

/// The drive-prefix (e.g. `c:`) of a path, lowercased — `None` for rootless.
#[cfg(windows)]
fn drive_of(path: &Path) -> Option<String> {
    path.components().find_map(|c| match c {
        std::path::Component::Prefix(p) => Some(p.as_os_str().to_string_lossy().to_lowercase()),
        _ => None,
    })
}

/// Whether the link's location and the target sit on the same drive (so a hard
/// link is possible). The link doesn't exist yet, so use its parent.
#[cfg(windows)]
fn same_volume(link_path: &Path, target: &Path) -> bool {
    let link_anchor = link_path.parent().unwrap_or(link_path);
    match (drive_of(link_anchor), drive_of(target)) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

/// Create a directory junction via PowerShell `New-Item -ItemType Junction`
/// (no elevation needed for a junction) — NOT `cmd mklink`, so a `%VAR%` in a
/// manifest-derived path can never be expanded/injected by the shell.
#[cfg(windows)]
fn junction(link_path: &Path, target: &Path) -> Result<(), String> {
    let encoded = encoded_new_item(
        "Junction",
        &link_path.display().to_string(),
        &target.display().to_string(),
    );
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded])
        .output()
        .map_err(|e| format!("junction launch failed: {e}"))?;
    // Success = the junction resolves to the intended target (not a redirected
    // or foreign link). link() verified the dest was absent on entry.
    if same_file(link_path, target) {
        return Ok(());
    }
    Err(format!(
        "junction failed: {}",
        String::from_utf8_lossy(&out.stderr).trim()
    ))
}

// The command construction is pure, so it is tested on every platform (the
// actual UAC elevation is not unit-testable).
#[cfg(test)]
mod cmd_tests {
    use super::{elevated_symlink_command, encoded_new_item};
    use base64::Engine as _;

    fn decode(b64: &str) -> String {
        let bytes = base64::engine::general_purpose::STANDARD.decode(b64).expect("base64");
        let utf16: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        String::from_utf16(&utf16).expect("utf16")
    }

    #[test]
    fn encoded_new_item_keeps_shell_metachars_out_of_any_parser() {
        // Paths with cmd/PS expansion hazards must NOT survive as live syntax:
        // the whole New-Item is base64-encoded, and inside it the paths are
        // single-quoted PS literals (so %VAR%, $env, ", & are all inert data).
        let b64 = encoded_new_item("SymbolicLink", r"C:\a %APPDATA% & $env\l.lua", r"D:\t.lua");
        // base64 itself carries none of the dangerous characters.
        for bad in ["%APPDATA%", "$env", "&", "\""] {
            assert!(!b64.contains(bad), "encoded blob leaks {bad:?}: {b64}");
        }
        let script = decode(&b64);
        assert!(script.contains("New-Item -ItemType SymbolicLink"));
        // The path is present only as a single-quoted literal, verbatim.
        assert!(
            script.contains(r"'C:\a %APPDATA% & $env\l.lua'"),
            "literal single-quoted path: {script}"
        );
    }

    #[test]
    fn encoded_new_item_doubles_single_quotes() {
        let script = decode(&encoded_new_item("Junction", r"C:\o'brien\d", r"D:\s"));
        assert!(script.contains("o''brien"), "single quote doubled: {script}");
    }

    #[test]
    fn elevated_symlink_command_wraps_the_encoded_script_in_a_uac_start_process() {
        let cmd = elevated_symlink_command(r"C:\l.lua", r"D:\t.lua");
        assert!(cmd.contains("-Verb RunAs"), "elevates via UAC: {cmd}");
        assert!(cmd.contains("-Wait"), "waits for the elevated process: {cmd}");
        assert!(cmd.contains("-EncodedCommand"), "passes the script base64-encoded: {cmd}");
        // No `cmd`, no `mklink`, no `%` — the whole injection surface is gone.
        assert!(!cmd.contains("mklink") && !cmd.contains('%'), "no cmd/mklink/%: {cmd}");
    }
}

// The locked-target classification is pure, so it is tested on every platform
// (provoking a real ERROR_SHARING_VIOLATION would need a second process holding
// the file open).
#[cfg(test)]
mod lock_tests {
    use super::{fs_err, is_lock_code, lock_hint, looks_locked};
    use std::io;
    use std::path::Path;

    #[test]
    fn lock_codes_match_only_the_windows_lock_family() {
        for code in [5, 32, 33] {
            assert!(is_lock_code(code), "{code} is a lock code");
        }
        for code in [0, 2, 3, 13, 31, 34, 999] {
            assert!(!is_lock_code(code), "{code} is not a lock code");
        }
    }

    #[test]
    fn lock_hint_only_speaks_when_locked() {
        assert!(lock_hint(true).contains("DCS"), "the hint names DCS");
        assert_eq!(lock_hint(false), "", "no hint when not locked");
    }

    #[test]
    fn fs_err_carries_context_path_and_error() {
        let e = io::Error::from_raw_os_error(32);
        let msg = fs_err("remove link", Path::new("/x/y"), &e);
        assert!(msg.starts_with("remove link /x/y: "), "context + path: {msg}");
    }

    #[cfg(windows)]
    #[test]
    fn a_sharing_violation_is_flagged_as_locked() {
        let e = io::Error::from_raw_os_error(32);
        assert!(looks_locked(&e), "ERROR_SHARING_VIOLATION reads as locked");
        assert!(fs_err("create", Path::new(r"C:\x"), &e).contains("DCS"));
    }

    #[cfg(not(windows))]
    #[test]
    fn unix_never_flags_a_lock() {
        // Unix has no mandatory lock that blocks unlink/replace — never mislead.
        let e = io::Error::from_raw_os_error(32);
        assert!(!looks_locked(&e), "no lock hint on Unix");
    }
}

// Real symlink round-trips on the OS that always permits it (Unix CI). This
// module is cfg'd off on Windows — file symlinks need Developer Mode and
// junctions need a child process, neither of which belongs in a unit test.
#[cfg(all(test, not(windows)))]
mod tests {
    use super::*;

    #[test]
    fn link_then_unlink_a_file_leaves_the_target_intact() {
        let base = std::env::temp_dir().join(format!("dcs-linker-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let target = base.join("real.txt");
        std::fs::write(&target, b"hi").unwrap();
        let link_path = base.join("sub").join("link.txt");

        link(&link_path, &target).expect("link");
        assert_eq!(std::fs::read(&link_path).unwrap(), b"hi", "link resolves to target");

        unlink(&link_path).expect("unlink");
        assert!(!link_path.exists(), "link is gone");
        assert!(target.exists(), "target survives the unlink");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn link_refuses_to_clobber_an_existing_destination() {
        let base = std::env::temp_dir().join(format!("dcs-linker-test2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let target = base.join("t.txt");
        std::fs::write(&target, b"x").unwrap();
        let occupied = base.join("taken.txt");
        std::fs::write(&occupied, b"keep").unwrap();

        assert!(link(&occupied, &target).is_err(), "won't overwrite");
        assert_eq!(std::fs::read(&occupied).unwrap(), b"keep", "existing file untouched");
        let _ = std::fs::remove_dir_all(&base);
    }
}
