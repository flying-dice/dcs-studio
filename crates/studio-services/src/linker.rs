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

use std::path::Path;

/// Create a link at `link_path` pointing to `target`. Creates parent dirs.
/// Refuses if `link_path` already exists (never clobbers the user's files).
pub fn link(link_path: &Path, target: &Path) -> Result<(), String> {
    if link_path.symlink_metadata().is_ok() {
        return Err(format!("destination already exists: {}", link_path.display()));
    }
    if let Some(parent) = link_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let meta =
        std::fs::metadata(target).map_err(|e| format!("link target {}: {e}", target.display()))?;
    if meta.is_dir() {
        link_dir(link_path, target)
    } else {
        link_file(link_path, target)
    }
}

/// Remove a previously placed link WITHOUT following it into the target — so the
/// user's real files (the link's target) are never touched. A no-op if gone.
pub fn unlink(link_path: &Path) -> Result<(), String> {
    let Ok(meta) = link_path.symlink_metadata() else {
        return Ok(());
    };
    // A junction / dir-symlink reports as a dir; `remove_dir` drops the link
    // itself (it does not recurse into the target). A file link → remove_file.
    let result = if meta.is_dir() {
        std::fs::remove_dir(link_path)
    } else {
        std::fs::remove_file(link_path)
    };
    result.map_err(|e| format!("remove link {}: {e}", link_path.display()))
}

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
    // Same volume → hard link (no elevation).
    if same_volume(link_path, target) && std::fs::hard_link(target, link_path).is_ok() {
        return Ok(());
    }
    // Cross-volume (or a failed hard link) → file symlink. Try unprivileged first
    // — works when Windows Developer Mode is on — then fall back to a one-shot
    // elevated `mklink` (a single UAC prompt), mirroring the original NodeJS
    // linker's createSymlinkElevated. The common same-drive case never reaches here.
    if std::os::windows::fs::symlink_file(target, link_path).is_ok() {
        return Ok(());
    }
    symlink_file_elevated(link_path, target)
}

/// Create a file symlink through an ELEVATED `mklink` (one UAC prompt) — the
/// cross-volume fallback when Developer Mode is off.
#[cfg(windows)]
fn symlink_file_elevated(link_path: &Path, target: &Path) -> Result<(), String> {
    let command = elevated_mklink_command(
        &link_path.display().to_string(),
        &target.display().to_string(),
    )?;
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &command])
        .output()
        .map_err(|e| format!("symlink elevation could not launch: {e}"))?;
    // The link's creation is the sole, authoritative success check — elevated
    // exit codes are unreliable across the UAC boundary. It cannot false-positive:
    // `link()` (the only path here) verified the destination was absent on entry,
    // so any link present now was made by this mklink.
    if link_path.symlink_metadata().is_ok() {
        return Ok(());
    }
    Err(format!(
        "cross-volume symlink needs privilege; the UAC elevation was declined or mklink failed ({}). Enable Windows Developer Mode to link without a prompt.",
        String::from_utf8_lossy(&out.stderr).trim()
    ))
}

/// The PowerShell command that creates a file symlink with one UAC prompt:
/// `Start-Process cmd /C mklink` elevated (`-Verb RunAs`), waiting for it. Pure
/// (no IO) so the quoting/escaping is unit-tested without actually elevating.
/// Returns Err for a path containing `"` (illegal in a Windows filename anyway),
/// which would break out of cmd's quoting — the content-store path is influenced
/// by the downloaded `.zip`'s entry names, so reject it rather than escape it.
#[cfg_attr(not(windows), allow(dead_code))]
fn elevated_mklink_command(link: &str, target: &str) -> Result<String, String> {
    if link.contains('"') || target.contains('"') {
        return Err("refusing to link a path containing a double-quote".to_string());
    }
    // `mklink "<link>" "<target>"` (no flag = a FILE symlink). The paths are
    // double-quoted for cmd; the whole arg string is single-quoted for
    // PowerShell, so any `'` in a path is doubled to stay inside that string.
    let inner = format!("/C mklink \"{link}\" \"{target}\"").replace('\'', "''");
    Ok(format!(
        "Start-Process -FilePath cmd.exe -ArgumentList '{inner}' -Verb RunAs -Wait -WindowStyle Hidden"
    ))
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

/// Create a directory junction via `mklink /J` (a `cmd` builtin) — junctions to
/// local dirs need no elevation, unlike `symlink_dir`.
#[cfg(windows)]
fn junction(link_path: &Path, target: &Path) -> Result<(), String> {
    let out = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link_path)
        .arg(target)
        .output()
        .map_err(|e| format!("mklink: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "junction failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

// The elevated-mklink command construction is pure, so it is tested on every
// platform (the actual UAC elevation is not unit-testable).
#[cfg(test)]
mod cmd_tests {
    use super::elevated_mklink_command;

    #[test]
    fn elevated_mklink_command_quotes_paths_and_elevates() {
        let cmd = elevated_mklink_command(r"C:\a b\link.lua", r"D:\store\real.lua").expect("ok");
        assert!(cmd.contains("-Verb RunAs"), "elevates via UAC: {cmd}");
        assert!(cmd.contains("-Wait"), "waits for the elevated process: {cmd}");
        assert!(
            cmd.contains(r#"mklink "C:\a b\link.lua" "D:\store\real.lua""#),
            "mklink with double-quoted paths (handles spaces): {cmd}"
        );
    }

    #[test]
    fn elevated_mklink_command_escapes_single_quotes_for_powershell() {
        // A `'` in a path must not break out of the PowerShell single-quoted arg.
        let cmd = elevated_mklink_command(r"C:\o'brien\l.lua", r"D:\t.lua").expect("ok");
        assert!(cmd.contains("o''brien"), "single quote doubled: {cmd}");
    }

    #[test]
    fn elevated_mklink_command_rejects_a_double_quote_in_a_path() {
        // A `"` would close cmd's quoting and inject — reject rather than escape.
        assert!(
            elevated_mklink_command("C:\\a\"b\\l.lua", r"D:\t.lua").is_err(),
            "double-quote path rejected"
        );
        assert!(elevated_mklink_command(r"C:\l.lua", "D:\\t\"x.lua").is_err());
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
