// Mission Scripting manager: detects DCS install dirs' Scripts\MissionScripting.lua
// and toggles the sanitization block (sanitizeModule('os'|'io'|'lfs') and
// _G['require'|'loadlib'|'package'] = nil) so mission scripts can use the full
// Lua environment (model/studio/mission.pds). Desanitize = comment the line
// out; re-sanitize = uncomment.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// The six sanitization items, in stock-file order.
const ITEMS: [&str; 6] = ["os", "io", "lfs", "require", "loadlib", "package"];

/// A candidate `<install>\Scripts\MissionScripting.lua`.
#[derive(serde::Serialize)]
pub struct MissionScriptFile {
    variant: String,
    path: String,
    exists: bool,
}

#[derive(serde::Serialize)]
pub struct SanitizeItem {
    name: String,
    /// A matching line (commented or active) exists in the file.
    present: bool,
    /// The matching line is active (uncommented) — DCS will sanitize this item.
    sanitized: bool,
}

#[derive(serde::Serialize)]
pub struct MissionScriptStatus {
    exists: bool,
    writable: bool,
    backup_exists: bool,
    in_program_files: bool,
    items: Vec<SanitizeItem>,
}

/// `true` for the `sanitizeModule('<name>')` items, `false` for the
/// `_G['<name>'] = nil` ones.
fn is_module(name: &str) -> bool {
    matches!(name, "os" | "io" | "lfs")
}

/// Strip `'<name>'` or `"<name>"` from the front of `s`.
fn strip_quoted<'a>(s: &'a str, name: &str) -> Option<&'a str> {
    for q in ['\'', '"'] {
        if let Some(rest) = s.strip_prefix(q) {
            return rest.strip_prefix(name)?.strip_prefix(q);
        }
    }
    None
}

/// Does `code` (a line with indentation and any `--` already stripped) match
/// the sanitization statement for `name`? Tolerates quote style + whitespace.
fn code_matches(code: &str, name: &str) -> bool {
    let code = code.trim();
    if is_module(name) {
        // sanitizeModule ( 'name' )
        (|| {
            let rest = code.strip_prefix("sanitizeModule")?.trim_start();
            let rest = rest.strip_prefix('(')?.trim_start();
            let rest = strip_quoted(rest, name)?.trim_start();
            rest.strip_prefix(')')
        })()
        .is_some()
    } else {
        // _G [ 'name' ] = nil
        (|| {
            let rest = code.strip_prefix("_G")?.trim_start();
            let rest = rest.strip_prefix('[')?.trim_start();
            let rest = strip_quoted(rest, name)?.trim_start();
            let rest = rest.strip_prefix(']')?.trim_start();
            let rest = rest.strip_prefix('=')?.trim_start();
            rest.strip_prefix("nil")
        })()
        .is_some()
    }
}

/// Classify one line against one item: `None` = no match, `Some(active)` where
/// `active` = the line is uncommented (item is sanitized).
fn line_state(line: &str, name: &str) -> Option<bool> {
    let body = line.trim_start();
    if let Some(rest) = body.strip_prefix("--") {
        // Commented-out line: strip the marker (and any space) before matching.
        let rest = rest.strip_prefix(' ').unwrap_or(rest);
        code_matches(rest, name).then_some(false)
    } else {
        code_matches(body, name).then_some(true)
    }
}

/// Toggle one line between sanitized (active) and desanitized (commented out),
/// preserving its indentation. `None` when the line matches none of the
/// requested items, or is already in the desired state.
fn toggled_line(line: &str, desired: &HashMap<String, bool>) -> Option<String> {
    let (&want, active) = desired
        .iter()
        .find_map(|(name, want)| line_state(line, name).map(|active| (want, active)))?;
    if active == want {
        return None;
    }
    let ws_len = line.len() - line.trim_start().len();
    let (indent, body) = line.split_at(ws_len);
    Some(if want {
        // Re-sanitize: strip one leading `--` token and one following space.
        let rest = body.strip_prefix("--").unwrap_or(body);
        let rest = rest.strip_prefix(' ').unwrap_or(rest);
        format!("{indent}{rest}")
    } else {
        // Desanitize: comment the statement out.
        format!("{indent}-- {body}")
    })
}

fn backup_path(path: &str) -> PathBuf {
    PathBuf::from(format!("{path}.dcsstudio.bak"))
}

fn status_for(path: &str) -> MissionScriptStatus {
    let p = Path::new(path);
    let in_program_files = path.to_lowercase().contains("program files");
    let backup_exists = backup_path(path).is_file();

    let Ok(content) = std::fs::read_to_string(p) else {
        return MissionScriptStatus {
            exists: p.is_file(),
            writable: false,
            backup_exists,
            in_program_files,
            items: Vec::new(),
        };
    };

    // Probe writability without truncating: open for write and drop the handle.
    let writable = std::fs::OpenOptions::new()
        .write(true)
        .open(p)
        .map(|_| true)
        .unwrap_or(false);

    let items = ITEMS
        .iter()
        .map(|&name| {
            let state = content.lines().find_map(|l| line_state(l, name));
            SanitizeItem {
                name: name.to_string(),
                present: state.is_some(),
                sanitized: state.unwrap_or(false),
            }
        })
        .collect();

    MissionScriptStatus {
        exists: true,
        writable,
        backup_exists,
        in_program_files,
        items,
    }
}

/// Read DCS install roots from the registry under `<root>\..\Eagle Dynamics`.
#[cfg(windows)]
fn registry_installs() -> Vec<(String, PathBuf)> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    let mut found = Vec::new();
    for (hive, subpath) in [
        (HKEY_CURRENT_USER, r"Software\Eagle Dynamics"),
        (HKEY_LOCAL_MACHINE, r"SOFTWARE\Eagle Dynamics"),
    ] {
        let Ok(key) = RegKey::predef(hive).open_subkey(subpath) else {
            continue; // missing key = no results, not an error
        };
        for name in key.enum_keys().flatten() {
            let Ok(sub) = key.open_subkey(&name) else {
                continue;
            };
            let Ok(install) = sub.get_value::<String, _>("Path") else {
                continue; // keys without a Path are not installs
            };
            found.push((name, PathBuf::from(install)));
        }
    }
    found
}

#[cfg(not(windows))]
fn registry_installs() -> Vec<(String, PathBuf)> {
    Vec::new()
}

/// Common Program Files locations probed in addition to the registry.
fn probe_installs() -> Vec<(String, PathBuf)> {
    let mut found = Vec::new();
    for drive in ['C', 'D', 'E'] {
        for leaf in ["DCS World", "DCS World OpenBeta", "DCS World Server"] {
            let root = PathBuf::from(format!(r"{drive}:\Program Files\Eagle Dynamics\{leaf}"));
            found.push((leaf.to_string(), root));
        }
    }
    found
}

/// First existing DCS game install root (registry first, then fixed-drive
/// probes): the `{GameInstall}` root for manifest installs.
pub fn default_game_install() -> Option<PathBuf> {
    registry_installs()
        .into_iter()
        .chain(probe_installs())
        .map(|(_, root)| root)
        .find(|root| root.is_dir())
}

/// Find candidate MissionScripting.lua files: registry installs first, then
/// fixed-drive probes; deduped by resolved path. Never errors — a machine with
/// no DCS just yields an empty list.
pub fn detect_mission_scripts() -> Vec<MissionScriptFile> {
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::new();

    let candidates = registry_installs().into_iter().chain(probe_installs());

    for (variant, root) in candidates {
        if !root.is_dir() {
            continue;
        }
        let lua = root.join("Scripts").join("MissionScripting.lua");
        let key = lua.to_string_lossy().to_lowercase();
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        out.push(MissionScriptFile {
            variant,
            exists: lua.is_file(),
            path: lua.to_string_lossy().into_owned(),
        });
    }
    out
}

/// Snapshot of a MissionScripting.lua's sanitization state.
pub fn mission_script_status(path: &str) -> MissionScriptStatus {
    status_for(path)
}

/// Set the desired sanitized state for the items named in `items`
/// (`{ "lfs": false }` = desanitize lfs). Other lines are untouched; the first
/// modification snapshots a pristine backup at `<path>.dcsstudio.bak`.
pub fn set_items(
    path: &str,
    desired: &HashMap<String, bool>,
) -> Result<MissionScriptStatus, String> {
    let content =
        std::fs::read_to_string(path).map_err(|e| format!("Failed to read '{path}': {e}"))?;

    // Preserve the file's dominant line ending.
    let eol = if content.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut lines: Vec<String> = content
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l).to_string())
        .collect();

    let mut changed = false;
    for line in lines.iter_mut() {
        if let Some(new_line) = toggled_line(line, desired) {
            *line = new_line;
            changed = true;
        }
    }

    if changed {
        let bak = backup_path(path);
        if !bak.exists() {
            std::fs::copy(path, &bak)
                .map_err(|e| format!("Failed to back up to '{}': {e}", bak.display()))?;
        }
        std::fs::write(path, lines.join(eol)).map_err(|e| {
            if e.kind() == std::io::ErrorKind::PermissionDenied {
                format!(
                    "Access denied writing {path}. MissionScripting.lua is under Program \
                     Files — restart DCS Studio as administrator, or edit it manually."
                )
            } else {
                format!("Failed to write '{path}': {e}")
            }
        })?;
    }

    Ok(status_for(path))
}

/// Copy the pristine `<path>.dcsstudio.bak` back over the live file.
pub fn restore(path: &str) -> Result<MissionScriptStatus, String> {
    let bak = backup_path(path);
    if !bak.is_file() {
        return Err("No backup found".to_string());
    }
    std::fs::copy(&bak, path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::PermissionDenied {
            format!(
                "Access denied writing {path}. MissionScripting.lua is under Program \
                 Files — restart DCS Studio as administrator, or edit it manually."
            )
        } else {
            format!("Failed to restore '{path}': {e}")
        }
    })?;
    Ok(status_for(path))
}

#[cfg(test)]
mod tests {
    use super::{restore, set_items, toggled_line};
    use std::collections::HashMap;

    fn desire(name: &str, sanitized: bool) -> HashMap<String, bool> {
        HashMap::from([(name.to_string(), sanitized)])
    }

    #[test]
    fn desanitize_comments_the_line_out_preserving_indent() {
        let toggled = toggled_line("\tsanitizeModule('lfs')", &desire("lfs", false));
        assert_eq!(toggled.as_deref(), Some("\t-- sanitizeModule('lfs')"));
    }

    #[test]
    fn resanitize_strips_one_comment_marker() {
        let toggled = toggled_line("\t-- sanitizeModule('os')", &desire("os", true));
        assert_eq!(toggled.as_deref(), Some("\tsanitizeModule('os')"));
    }

    #[test]
    fn lines_already_in_the_desired_state_are_untouched() {
        assert_eq!(
            toggled_line("\tsanitizeModule('io')", &desire("io", true)),
            None
        );
        assert_eq!(
            toggled_line("\t-- _G['require'] = nil", &desire("require", false)),
            None
        );
    }

    #[test]
    fn unrelated_lines_are_untouched() {
        assert_eq!(toggled_line("local x = 1", &desire("lfs", false)), None);
        assert_eq!(
            toggled_line("\tsanitizeModule('os')", &desire("lfs", false)),
            None
        );
    }

    #[test]
    fn global_nil_assignments_toggle_too() {
        let toggled = toggled_line("\t_G['package'] = nil", &desire("package", false));
        assert_eq!(toggled.as_deref(), Some("\t-- _G['package'] = nil"));
    }

    const STOCK: &str = "do\n\tsanitizeModule('os')\n\tsanitizeModule('io')\n\
                         \tsanitizeModule('lfs')\n\t_G['require'] = nil\n\
                         \t_G['loadlib'] = nil\n\t_G['package'] = nil\nend\n";

    fn temp_script(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "studio-services-mission-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        let file = dir.join("MissionScripting.lua");
        std::fs::write(&file, STOCK).expect("seed script");
        file
    }

    #[test]
    fn first_edit_snapshots_a_pristine_backup_and_only_toggles_the_item() {
        let file = temp_script("backup");
        let path = file.to_string_lossy().into_owned();

        let status = set_items(&path, &desire("lfs", false)).expect("set");
        assert!(status.backup_exists);

        let backup = std::fs::read_to_string(format!("{path}.dcsstudio.bak")).expect("backup");
        assert_eq!(backup, STOCK, "backup must be the pristine file");

        let edited = std::fs::read_to_string(&path).expect("edited");
        assert!(edited.contains("\t-- sanitizeModule('lfs')"));
        assert!(edited.contains("\tsanitizeModule('os')"), "os untouched");
        let _ = std::fs::remove_dir_all(file.parent().unwrap());
    }

    #[test]
    fn restore_copies_the_pristine_backup_back() {
        let file = temp_script("restore");
        let path = file.to_string_lossy().into_owned();

        set_items(&path, &desire("io", false)).expect("set");
        assert_ne!(std::fs::read_to_string(&path).expect("edited"), STOCK);

        let status = restore(&path).expect("restore");
        assert_eq!(std::fs::read_to_string(&path).expect("restored"), STOCK);
        assert!(status.items.iter().all(|i| i.present && i.sanitized));
        let _ = std::fs::remove_dir_all(file.parent().unwrap());
    }

    #[test]
    fn unknown_items_are_ignored_and_leave_the_file_untouched() {
        // Recorded behavior: set_items only toggles lines matching known
        // sanitizeModule/_G items; unknown keys match nothing, so the file
        // is not rewritten and no backup is taken.
        let file = temp_script("unknown-item");
        let path = file.to_string_lossy().into_owned();

        let status = set_items(&path, &desire("frobnicate", false)).expect("set");
        assert!(!status.backup_exists, "no change, so no backup");
        assert_eq!(std::fs::read_to_string(&path).expect("read"), STOCK);
        let _ = std::fs::remove_dir_all(file.parent().unwrap());
    }

    #[test]
    fn restore_without_a_backup_is_the_disclosed_error() {
        let file = temp_script("no-backup");
        let path = file.to_string_lossy().into_owned();
        let Err(err) = restore(&path) else {
            panic!("restore without a backup must fail");
        };
        assert_eq!(err, "No backup found");
        let _ = std::fs::remove_dir_all(file.parent().unwrap());
    }
}
