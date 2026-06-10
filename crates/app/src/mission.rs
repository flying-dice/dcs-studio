// Mission Scripting manager: detects DCS install dirs' Scripts\MissionScripting.lua
// and toggles the sanitization block (sanitizeModule('os'|'io'|'lfs') and
// _G['require'|'loadlib'|'package'] = nil) so mission scripts can use the full
// Lua environment. Desanitize = comment the line out; re-sanitize = uncomment.

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
            let root = PathBuf::from(format!(
                r"{drive}:\Program Files\Eagle Dynamics\{leaf}"
            ));
            found.push((leaf.to_string(), root));
        }
    }
    found
}

/// Find candidate MissionScripting.lua files: registry installs first, then
/// fixed-drive probes; deduped by resolved path. Never errors — a machine with
/// no DCS just yields an empty list.
#[tauri::command]
pub fn dcs_detect_mission_scripts() -> Vec<MissionScriptFile> {
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::new();

    let candidates = registry_installs()
        .into_iter()
        .chain(probe_installs());

    for (variant, root) in candidates {
        if !root.is_dir() {
            continue;
        }
        let lua = root.join("Scripts").join("MissionScripting.lua");
        let key = lua.to_string_lossy().to_lowercase();
        if seen.iter().any(|s| *s == key) {
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
#[tauri::command]
pub fn dcs_mission_script_status(path: String) -> MissionScriptStatus {
    status_for(&path)
}

/// Set the desired sanitized state for the items named in `items`
/// (`{ "lfs": false }` = desanitize lfs). Other lines are untouched; the first
/// modification snapshots a pristine backup at `<path>.dcsstudio.bak`.
#[tauri::command]
pub fn dcs_mission_script_set(
    path: String,
    items: serde_json::Value,
) -> Result<MissionScriptStatus, String> {
    let desired: std::collections::HashMap<String, bool> =
        serde_json::from_value(items).map_err(|e| format!("Bad items map: {e}"))?;

    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read '{path}': {e}"))?;

    // Preserve the file's dominant line ending.
    let eol = if content.contains("\r\n") { "\r\n" } else { "\n" };
    let mut lines: Vec<String> = content
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l).to_string())
        .collect();

    let mut changed = false;
    for line in lines.iter_mut() {
        let Some((&want, active)) = desired
            .iter()
            .find_map(|(name, want)| line_state(line, name).map(|active| (want, active)))
        else {
            continue;
        };
        if active == want {
            continue;
        }
        let ws_len = line.len() - line.trim_start().len();
        let (indent, body) = line.split_at(ws_len);
        let new_line = if want {
            // Re-sanitize: strip one leading `--` token and one following space.
            let rest = body.strip_prefix("--").unwrap_or(body);
            let rest = rest.strip_prefix(' ').unwrap_or(rest);
            format!("{indent}{rest}")
        } else {
            // Desanitize: comment the statement out.
            format!("{indent}-- {body}")
        };
        *line = new_line;
        changed = true;
    }

    if changed {
        let bak = backup_path(&path);
        if !bak.exists() {
            std::fs::copy(&path, &bak)
                .map_err(|e| format!("Failed to back up to '{}': {e}", bak.display()))?;
        }
        std::fs::write(&path, lines.join(eol)).map_err(|e| {
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

    Ok(status_for(&path))
}

/// Copy the pristine `<path>.dcsstudio.bak` back over the live file.
#[tauri::command]
pub fn dcs_mission_script_restore(path: String) -> Result<MissionScriptStatus, String> {
    let bak = backup_path(&path);
    if !bak.is_file() {
        return Err("No backup found".to_string());
    }
    std::fs::copy(&bak, &path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::PermissionDenied {
            format!(
                "Access denied writing {path}. MissionScripting.lua is under Program \
                 Files — restart DCS Studio as administrator, or edit it manually."
            )
        } else {
            format!("Failed to restore '{path}': {e}")
        }
    })?;
    Ok(status_for(&path))
}
