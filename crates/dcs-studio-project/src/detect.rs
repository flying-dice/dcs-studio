//! DCS install detection shared by the CLI's `install` default and the
//! app's `{SavedGames}` root resolution (model: `studio::installer`).

use std::path::PathBuf;

/// First existing DCS write dir under `%USERPROFILE%\Saved Games`:
/// `DCS` is preferred, then `DCS.openbeta`, then any other `DCS.*`
/// variant (alphabetically, for determinism). `None` when nothing
/// is found — absence is data, never an error.
#[must_use]
pub fn default_saved_games() -> Option<PathBuf> {
    let saved = PathBuf::from(std::env::var_os("USERPROFILE")?).join("Saved Games");
    if let Some(preferred) = ["DCS", "DCS.openbeta"]
        .into_iter()
        .map(|name| saved.join(name))
        .find(|path| path.is_dir())
    {
        return Some(preferred);
    }
    let mut variants: Vec<PathBuf> = std::fs::read_dir(&saved)
        .ok()?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().starts_with("DCS."))
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    variants.sort();
    variants.into_iter().next()
}

/// The detected DCS write dir for installs: the preferred `Saved Games\DCS`
/// ([`default_saved_games`]) kept only when it's a genuine write dir — it has a
/// `Config` subdir (the validity marker the Injection Manager uses). The single
/// source for "where installs go"; the `DCS_SAVED_GAMES` override and the
/// `{GameInstall}` root are layered on in [`resolve_roots`].
#[must_use]
pub fn write_dir() -> Option<PathBuf> {
    default_saved_games().filter(|dir| dir.join("Config").is_dir())
}

/// Resolve the install roots (model `ResolveRoots`): the Saved Games write dir —
/// the `DCS_SAVED_GAMES` override (trusted as-is, for a non-standard layout and
/// the e2e's temp-roots seam), else the detected [`write_dir`] — plus the
/// caller-chosen `{GameInstall}` root. Pass `None` to leave `{GameInstall}`
/// unconfigured so a `{GameInstall}` rule fails the root guard rather than
/// installing to the wrong place (the Marketplace passes `None`; a project
/// install passes the detected game install).
///
/// Every install path — project, package, and Marketplace — resolves roots
/// through here, so `DCS_SAVED_GAMES` applies uniformly. This is a deliberate
/// convergence: before the install-kit was unified (issue #6 R1), the project
/// path resolved its write dir directly and ignored the override; now it honours
/// it exactly as the package path always has.
///
/// # Errors
/// Returns `Err` when no Saved Games write dir can be resolved.
pub fn resolve_roots(game_install: Option<PathBuf>) -> Result<crate::RootMap, String> {
    let saved_games = std::env::var_os("DCS_SAVED_GAMES")
        .map(PathBuf::from)
        .or_else(write_dir)
        .ok_or_else(|| {
            "No DCS Saved Games write dir found — run DCS once so it creates \
             Saved Games\\DCS, then try again"
                .to_string()
        })?;
    Ok(crate::RootMap {
        saved_games,
        game_install,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detection_is_total() {
        // What's installed is environment-dependent; the contract is only
        // that scanning never panics, whatever the machine looks like.
        let _ = default_saved_games();
    }
}
