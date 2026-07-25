//! Golden-file checking for the per-cdylib generated documents.
//!
//! Each bridge crate pins a checked-in file — `types/<module>.d.lua` and
//! `openrpc/<module>.openrpc.json` — against what the live surface generates,
//! so the facade and the `OpenRPC` document cannot drift from what the DLL
//! actually registers.
//!
//! Regenerating is the same operation as checking; it just writes instead of
//! comparing. Keeping both in one function, behind one flag, means there is no
//! `#[ignore]`d twin of every check to remember and run by hand — and no
//! version of the suite that quietly rewrites the golden it is supposed to be
//! guarding.
//!
//! This lives in the shared crate rather than in either cdylib's test module
//! because both crates' tests need it and neither can see the other's.

use std::path::Path;

/// Setting this environment variable turns the golden checks into
/// regenerations: `DCS_STUDIO_REGENERATE_GOLDENS=1 cargo test --workspace`.
pub const REGENERATE_ENV: &str = "DCS_STUDIO_REGENERATE_GOLDENS";

/// Whether the caller asked for goldens to be rewritten rather than checked.
#[must_use]
pub fn regenerating() -> bool {
    std::env::var_os(REGENERATE_ENV).is_some()
}

/// Compare `actual` against the golden stored at `path`, or rewrite the golden
/// from `actual` when `regenerate`.
///
/// Line endings are normalised on both sides so a CRLF checkout does not read
/// as drift — the generators always emit `\n`, but git may not.
///
/// # Errors
///
/// Returns a human-readable message when the golden is missing or unreadable,
/// when it has drifted from `actual`, or when a rewrite fails.
pub fn check_or_regenerate(path: &Path, actual: &str, regenerate: bool) -> Result<(), String> {
    let actual = actual.replace("\r\n", "\n");
    if regenerate {
        return write_atomically(path, &actual);
    }

    let stored = std::fs::read_to_string(path)
        .map_err(|e| format!("cannot read the golden {}: {e}", path.display()))?
        .replace("\r\n", "\n");

    if stored == actual {
        return Ok(());
    }
    Err(format!(
        "{} drifted from the live surface ({} stored bytes vs {} generated)",
        path.display(),
        stored.len(),
        actual.len()
    ))
}

/// Temp-write then rename, so a reader of the same golden — the check test in
/// the sibling crate, running in parallel — can never see a half-written file.
fn write_atomically(path: &Path, contents: &str) -> Result<(), String> {
    let tmp = path.with_extension("regen-tmp");
    std::fs::write(&tmp, contents).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("cannot replace {}: {e}", path.display()))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // idiomatic in tests
mod tests {
    use super::{check_or_regenerate, regenerating, REGENERATE_ENV};
    use std::path::PathBuf;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dcs-studio-golden-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    /// A golden that matches passes; one that has drifted fails with both
    /// sizes, so a reviewer can tell a whitespace change from a whole missing
    /// namespace at a glance.
    #[test]
    fn a_matching_golden_passes_and_a_drifted_one_names_the_difference() {
        let dir = scratch("check");
        let golden = dir.join("surface.d.lua");
        std::fs::write(&golden, "---@meta m\nlocal m = {}\n").expect("seed");

        check_or_regenerate(&golden, "---@meta m\nlocal m = {}\n", false).expect("in sync");

        let err = check_or_regenerate(&golden, "---@meta m\n", false).expect_err("drifted");
        assert!(err.contains("drifted"), "{err}");
        assert!(err.contains("surface.d.lua"), "{err}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A CRLF checkout is not drift. The generators emit `\n`, but git's
    /// autocrlf rewrites the checked-in file on Windows — where this suite also
    /// runs against DCS's own lua.dll.
    #[test]
    fn a_crlf_checkout_of_the_golden_is_not_drift() {
        let dir = scratch("crlf");
        let golden = dir.join("surface.d.lua");
        std::fs::write(&golden, "---@meta m\r\nlocal m = {}\r\n").expect("seed");

        check_or_regenerate(&golden, "---@meta m\nlocal m = {}\n", false)
            .expect("line endings are not surface changes");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A missing golden is reported by name rather than silently regenerated —
    /// a check run must never create the file it is supposed to be checking.
    #[test]
    fn a_missing_golden_is_reported_rather_than_created() {
        let dir = scratch("missing");
        let golden = dir.join("absent.d.lua");

        let err = check_or_regenerate(&golden, "anything", false).expect_err("no golden");
        assert!(err.contains("cannot read the golden"), "{err}");
        assert!(!golden.exists(), "a check must not create the golden");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Regenerating writes the file — creating it if absent, replacing it if
    /// not — and the result then passes its own check.
    #[test]
    fn regenerating_writes_the_golden_and_the_result_checks_clean() {
        let dir = scratch("regen");
        let golden = dir.join("surface.d.lua");

        check_or_regenerate(&golden, "first\n", true).expect("create");
        assert_eq!(std::fs::read_to_string(&golden).expect("read"), "first\n");

        check_or_regenerate(&golden, "second\n", true).expect("replace");
        assert_eq!(std::fs::read_to_string(&golden).expect("read"), "second\n");
        check_or_regenerate(&golden, "second\n", false).expect("in sync after a regen");

        // The temp file the swap goes through does not survive it.
        assert!(!golden.with_extension("regen-tmp").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A regeneration that cannot write says so instead of leaving the caller
    /// believing the golden was refreshed — both halves of the swap, since a
    /// failed rename is the one that would leave a stray temp file behind.
    #[test]
    fn a_regeneration_that_cannot_write_reports_which_step_failed() {
        let dir = scratch("regenfail");

        // The temp write fails: nothing can be created under a path whose
        // parent does not exist.
        let nowhere = dir.join("no-such-dir").join("surface.d.lua");
        let err = check_or_regenerate(&nowhere, "x", true).expect_err("no parent");
        assert!(err.contains("cannot write"), "{err}");

        // The rename fails: the destination is a non-empty directory.
        let occupied = dir.join("surface.d.lua");
        std::fs::create_dir_all(occupied.join("in-the-way")).expect("occupy");
        let err = check_or_regenerate(&occupied, "x", true).expect_err("cannot replace a dir");
        assert!(err.contains("cannot replace"), "{err}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The suite checks by default. Regeneration is opt-in precisely because a
    /// run that rewrote the golden would pass the drift check it just erased.
    #[test]
    fn regeneration_is_off_unless_the_environment_asks_for_it() {
        assert_eq!(
            regenerating(),
            std::env::var_os(REGENERATE_ENV).is_some(),
            "the flag is exactly the environment variable"
        );
    }
}
