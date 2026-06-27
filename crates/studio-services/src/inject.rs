// Injection manager: installs/updates/removes the in-DCS bridge (DLL + Lua
// GameGUI hook) into a DCS Saved Games write dir (model/studio/inject.pds).
// This replaces the manual crates/dcs-bridge/deploy/deploy.ps1 workflow with
// in-app commands and MCP tools.

use std::path::{Path, PathBuf};

/// The GameGUI hook is embedded at compile time so it is always available
/// regardless of cwd or packaging.
const HOOK_SRC: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../dcs-bridge/deploy/Scripts/Hooks/DcsStudio.lua"
));
const HOOK_REL: &str = "Scripts/Hooks/DcsStudio.lua";
const DLL_REL: &str = "Mods/tech/DcsStudio/bin/dcs_studio.dll";
/// Pre-rebrand DLL name (the bridge was `dcs_bridge.dll` before it grew into
/// the full DCS Studio runtime). Removed on inject/eject so a stale artifact
/// is never left loadable beside the current one.
const LEGACY_DLL_REL: &str = "Mods/tech/DcsStudio/bin/dcs_bridge.dll";

/// A candidate DCS write dir under `%USERPROFILE%\Saved Games`.
#[derive(serde::Serialize)]
pub struct DcsInstall {
    name: String,
    write_dir: String,
    valid: bool,
}

impl DcsInstall {
    /// The Saved Games write dir path — for in-crate callers (e.g. the launcher's
    /// crash recovery) that walk detected installs without re-serializing.
    #[must_use]
    pub fn write_dir(&self) -> &str {
        &self.write_dir
    }
}

/// What is (and isn't) installed in a given write dir, relative to the
/// bridge artifacts this build would install.
#[derive(serde::Serialize)]
pub struct InjectionStatus {
    source_available: bool,
    source_version: String,
    dll_installed: bool,
    dll_up_to_date: bool,
    hook_installed: bool,
    hook_up_to_date: bool,
    dll_dest: String,
    hook_dest: String,
}

/// Resolve the bridge DLL. The preferred source is the DLL bundled next to the
/// packaged exe (a Tauri bundle resource — `crates/app/tauri.conf.json`
/// `bundle.resources`, staged by `scripts/prepare-sidecar.mjs`); dev builds fall
/// back to the cargo target-dir layouts.
fn source_dll_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?;
    let candidates = [
        // Packaged app: the bundled resource sits next to the exe.
        exe_dir.join("dcs_studio.dll"),
        // Defensive: some bundler/NSIS layouts nest resources under `resources/`.
        exe_dir.join("resources/dcs_studio.dll"),
        // Dev: app runs from target/debug, DLL built --release.
        exe_dir.join("../release/dcs_studio.dll"),
        // Extra fallbacks for nested target layouts.
        exe_dir.join("../../release/dcs_studio.dll"),
        exe_dir.join("../debug/dcs_studio.dll"),
    ];
    candidates.into_iter().find(|p| p.is_file())
}

/// Build-aware DLL-missing message. A packaged install always ships the bridge
/// DLL bundled next to the exe, so its absence means a broken install — ask the
/// user to reinstall. A dev build instead hints the command that produces the
/// source DLL.
fn dll_missing_message() -> String {
    dll_missing_message_for(cfg!(debug_assertions))
}

fn dll_missing_message_for(is_dev_build: bool) -> String {
    if is_dev_build {
        "DCS Studio bridge DLL not built — run `cargo build -p dcs-bridge --release`".to_string()
    } else {
        "Bridge DLL missing from this install — please reinstall DCS Studio".to_string()
    }
}

/// Normalise CRLF to LF so a checked-out-with-CRLF hook never reads as
/// "outdated" against the embedded (possibly LF) source.
fn normalise_eol(s: &str) -> String {
    s.replace("\r\n", "\n")
}

/// Scan `%USERPROFILE%\Saved Games` for DCS write dirs (`DCS` or `DCS.*`).
/// `valid` = the dir contains a `Config` subdir (DCS write-dir marker).
/// Returns `DCS` first, then the variants; empty vec when nothing is found.
pub fn detect_installs() -> Vec<DcsInstall> {
    let Ok(profile) = std::env::var("USERPROFILE") else {
        return Vec::new();
    };
    let saved_games = Path::new(&profile).join("Saved Games");
    let Ok(entries) = std::fs::read_dir(&saved_games) else {
        return Vec::new();
    };

    let mut installs: Vec<DcsInstall> = entries
        .filter_map(|res| res.ok())
        .filter(|e| e.path().is_dir())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if name != "DCS" && !name.starts_with("DCS.") {
                return None;
            }
            let path = e.path();
            Some(DcsInstall {
                valid: path.join("Config").is_dir(),
                write_dir: path.to_string_lossy().into_owned(),
                name,
            })
        })
        .collect();

    // Stable order: plain `DCS` first, then the rest alphabetically.
    installs.sort_by(|a, b| {
        (a.name != "DCS")
            .cmp(&(b.name != "DCS"))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    installs
}

/// The `{SavedGames}` root for manifest installs: the shared scan's pick
/// (plain `DCS` preferred, then `DCS.openbeta`, then other variants),
/// kept only if it looks like a genuine write dir (has a `Config` subdir
/// — the same validity marker `detect_installs` uses).
pub fn default_write_dir() -> Option<PathBuf> {
    dcs_studio_project::detect::write_dir()
}

fn status_for(write_dir: &str) -> InjectionStatus {
    let dll_dest = Path::new(write_dir).join(DLL_REL);
    let hook_dest = Path::new(write_dir).join(HOOK_REL);

    let source_dll = source_dll_path();
    let source_available = source_dll.is_some();

    let dll_installed = dll_dest.is_file();
    // Up to date = exact byte equality with the source DLL we would install.
    let dll_up_to_date = dll_installed
        && source_dll
            .and_then(|src| {
                let a = std::fs::read(&src).ok()?;
                let b = std::fs::read(&dll_dest).ok()?;
                Some(a == b)
            })
            .unwrap_or(false);

    let installed_hook = std::fs::read_to_string(&hook_dest).ok();
    let hook_installed = installed_hook.is_some() || hook_dest.is_file();
    let hook_up_to_date = installed_hook
        .map(|s| normalise_eol(&s) == normalise_eol(HOOK_SRC))
        .unwrap_or(false);

    InjectionStatus {
        source_available,
        source_version: env!("CARGO_PKG_VERSION").to_string(),
        dll_installed,
        dll_up_to_date,
        hook_installed,
        hook_up_to_date,
        dll_dest: dll_dest.to_string_lossy().into_owned(),
        hook_dest: hook_dest.to_string_lossy().into_owned(),
    }
}

/// Snapshot of what's installed in `write_dir` vs what this build would install.
pub fn injection_status(write_dir: &str) -> InjectionStatus {
    status_for(write_dir)
}

/// Install (or update) the bridge DLL + hook into `write_dir`.
pub fn inject(write_dir: &str) -> Result<InjectionStatus, String> {
    let source_dll = source_dll_path().ok_or_else(dll_missing_message)?;

    let dll_dest = Path::new(write_dir).join(DLL_REL);
    let hook_dest = Path::new(write_dir).join(HOOK_REL);

    for dest in [&dll_dest, &hook_dest] {
        if let Some(dir) = dest.parent() {
            std::fs::create_dir_all(dir)
                .map_err(|e| format!("Failed to create '{}': {}", dir.display(), e))?;
        }
    }

    // A locked DLL (DCS running with the bridge loaded) fails here — surface it.
    std::fs::copy(&source_dll, &dll_dest).map_err(|e| {
        format!(
            "Failed to copy '{}' -> '{}': {}",
            source_dll.display(),
            dll_dest.display(),
            e
        )
    })?;

    std::fs::write(&hook_dest, HOOK_SRC)
        .map_err(|e| format!("Failed to write '{}': {}", hook_dest.display(), e))?;

    // Drop a pre-rebrand dcs_bridge.dll left beside the new artifact, so the
    // hook never has a stale module to load. Best-effort: absence is fine.
    let _ = std::fs::remove_file(Path::new(write_dir).join(LEGACY_DLL_REL));

    Ok(status_for(write_dir))
}

/// Remove the bridge DLL + hook from `write_dir` (missing files are fine).
pub fn eject(write_dir: &str) -> Result<InjectionStatus, String> {
    let dll_dest = Path::new(write_dir).join(DLL_REL);
    let hook_dest = Path::new(write_dir).join(HOOK_REL);

    let legacy_dll = Path::new(write_dir).join(LEGACY_DLL_REL);
    for dest in [&dll_dest, &hook_dest, &legacy_dll] {
        if let Err(e) = std::fs::remove_file(dest) {
            if e.kind() != std::io::ErrorKind::NotFound {
                return Err(format!("Failed to remove '{}': {}", dest.display(), e));
            }
        }
    }

    // Best-effort tidy: drop the now-empty Mods/tech/DcsStudio tree.
    let _ = std::fs::remove_dir(Path::new(write_dir).join("Mods/tech/DcsStudio/bin"));
    let _ = std::fs::remove_dir(Path::new(write_dir).join("Mods/tech/DcsStudio"));

    Ok(status_for(write_dir))
}

#[cfg(test)]
mod tests {
    use super::{dll_missing_message_for, normalise_eol, DLL_REL, LEGACY_DLL_REL};

    #[test]
    fn eol_normalisation_makes_crlf_and_lf_hooks_compare_equal() {
        assert_eq!(
            normalise_eol("line one\r\nline two\r\n"),
            normalise_eol("line one\nline two\n")
        );
        assert_ne!(normalise_eol("a\nb"), normalise_eol("a\nc"));
    }

    #[test]
    fn dll_missing_message_is_build_aware() {
        let dev = dll_missing_message_for(true);
        assert!(dev.contains("cargo build -p dcs-bridge --release"));

        let packaged = dll_missing_message_for(false);
        assert!(packaged.to_lowercase().contains("reinstall"));
        // The dev-only build hint must never leak into the packaged message.
        assert!(!packaged.contains("cargo build"));
    }

    #[test]
    fn installs_the_rebranded_dll_and_cleans_up_the_legacy_one() {
        // The artifact rebranded dcs_bridge.dll -> dcs_studio.dll; the install
        // dest and the legacy-cleanup target must track that rename.
        assert!(DLL_REL.ends_with("dcs_studio.dll"));
        assert!(LEGACY_DLL_REL.ends_with("dcs_bridge.dll"));
        // Both live under the same Mods/tech/DcsStudio/bin folder.
        assert!(DLL_REL.starts_with("Mods/tech/DcsStudio/bin/"));
        assert!(LEGACY_DLL_REL.starts_with("Mods/tech/DcsStudio/bin/"));
    }
}
