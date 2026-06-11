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
