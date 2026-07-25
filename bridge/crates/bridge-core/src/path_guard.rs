//! The DCS write-root guard shared by `file` and `sqlite`. [`stays_under`]
//! decides whether a caller-supplied relative path may be joined onto the write
//! root; [`resolve_under_writedir`] layers `lfs.writedir()` resolution on top,
//! so both writers confine to the same root with the same guard and error
//! strings.
//!
//! This is a security boundary, not a convenience check: `rel` arrives from a
//! JSON-RPC caller on the local HTTP surface, and anything that escapes the
//! write root is an arbitrary-file-write primitive inside the user's machine.
//!
//! The rules are spelled out explicitly rather than delegated to
//! `std::path::Component`, because `Path`'s parsing is host-dependent and DCS
//! is Windows-only. On Linux `Path::new(r"C:\Windows")` yields a single
//! `Normal` component — a backslash is an ordinary character there — so a
//! component-based guard silently accepts drive-prefixed and backslash-climbing
//! input off-Windows. Doing the parsing here means the guard behaves the same
//! wherever it is compiled, which is also what makes it testable on Linux CI.
use crate::get_lfs_writedir;
use mlua::Lua;
use std::path::PathBuf;

/// True when `path` is a relative path that stays under its base.
///
/// Rejects, with Windows semantics on every host:
/// - empty input, and input that is only separators or dots;
/// - absolute paths (`/x`, `\x`) and UNC paths (`\\server\share`);
/// - any drive or stream prefix — a `:` anywhere, which also blocks NTFS
///   alternate-data-stream writes such as `notes.txt:hidden`;
/// - any `..` component, on either separator;
/// - reserved-looking empty components from doubled separators (`a//b`).
///
/// A bare `.` component is allowed and normalises away (`./a` == `a`).
pub fn stays_under(path: &str) -> bool {
    if path.is_empty() {
        return false;
    }
    // A colon can only be a drive prefix or an alternate data stream here;
    // neither is a legitimate relative path under the write root.
    if path.contains(':') {
        return false;
    }
    // Leading separator = rooted, on either slash. Also catches UNC's `\\`.
    if path.starts_with('/') || path.starts_with('\\') {
        return false;
    }

    let components: Vec<&str> = path.split(['/', '\\']).collect();
    let mut normal = 0_usize;
    for component in components {
        match component {
            // An empty component is a doubled or trailing separator (`a//b`,
            // `a/`); `..` climbs out. Both are refused rather than normalised,
            // so the guard never has to reason about what a path means after
            // rewriting it.
            "" | ".." => return false,
            // `.` is a no-op segment, not a normal one — `./a` is still `a`.
            "." => {}
            _ => normal += 1,
        }
    }
    // `.` or `./.` names the root itself, not a path under it.
    normal > 0
}

/// Resolve `rel` under `lfs.writedir()`, refusing any path that escapes the
/// write root. Shared by `file` and `sqlite`.
///
/// # Errors
///
/// Returns an error string when `rel` escapes the write root (absolute,
/// drive-prefixed, or climbing out with `..`), or when `lfs.writedir()` is
/// unavailable in `lua`.
pub fn resolve_under_writedir(lua: &Lua, rel: &str) -> Result<PathBuf, String> {
    if !stays_under(rel) {
        return Err(format!("path escapes the write root: {rel}"));
    }
    let writedir = get_lfs_writedir(lua).map_err(|e| format!("lfs.writedir() unavailable: {e}"))?;
    Ok(PathBuf::from(writedir).join(rel))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // idiomatic in tests
mod tests {
    use super::{resolve_under_writedir, stays_under};
    use mlua::Lua;

    #[test]
    fn accepts_ordinary_relative_paths() {
        assert!(stays_under("dcs.log"));
        assert!(stays_under("Logs/dcs.log"));
        assert!(stays_under(r"Logs\dcs.log"));
        assert!(stays_under("a/b/c/d.json"));
        // A `.` segment is a no-op, not an escape.
        assert!(stays_under("./dcs.log"));
        assert!(stays_under("a/./b"));
    }

    #[test]
    fn rejects_parent_traversal_on_either_separator() {
        assert!(!stays_under(".."));
        assert!(!stays_under("../secrets"));
        assert!(!stays_under(r"..\secrets"));
        assert!(!stays_under("Logs/../../secrets"));
        assert!(!stays_under(r"Logs\..\..\secrets"));
        // Buried in the middle, after legitimate-looking segments.
        assert!(!stays_under("a/b/../../../../etc/passwd"));
    }

    #[test]
    fn rejects_absolute_and_unc_paths() {
        assert!(!stays_under("/etc/passwd"));
        assert!(!stays_under(r"\Windows\System32"));
        assert!(!stays_under(r"\\server\share\x"));
        assert!(!stays_under("//server/share/x"));
    }

    #[test]
    fn rejects_drive_prefixes_and_data_streams_on_every_host() {
        // The case a Component-based guard gets wrong off-Windows: on Linux
        // these parse as one Normal component and would be accepted.
        assert!(!stays_under(r"C:\Windows\System32\drivers\etc\hosts"));
        assert!(!stays_under("C:/Windows"));
        assert!(!stays_under("C:relative"));
        // NTFS alternate data stream — writes hidden content beside a file.
        assert!(!stays_under("notes.txt:hidden"));
        assert!(!stays_under("a/b.txt:$DATA"));
    }

    #[test]
    fn rejects_empty_and_separator_only_input() {
        assert!(!stays_under(""));
        assert!(!stays_under("."));
        assert!(!stays_under("./."));
        assert!(!stays_under("/"));
        assert!(!stays_under(r"\"));
        // Doubled separators are refused rather than silently collapsed.
        assert!(!stays_under("a//b"));
        assert!(!stays_under("a/"));
    }

    /// Windows-ignored like the rest of the crate's mlua tests: there it needs
    /// DCS's `lua.dll` on the runtime path (`-- --include-ignored` next to
    /// one); on non-Windows the build.rs links PUC liblua5.1 so Linux CI runs
    /// it as an ordinary test (issue #28).
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn resolves_a_contained_path_under_the_write_dir() {
        let lua = Lua::new();
        lua.load(r#"lfs = { writedir = function() return "C:\\SG\\DCS\\" end }"#)
            .exec()
            .expect("seed lfs");

        let resolved = resolve_under_writedir(&lua, "Logs/dcs.log").expect("contained path");
        // Normalised to one separator before asserting: the host's separator is
        // not the subject — the join is (issue #28 runs this on Linux).
        let shown = resolved.to_string_lossy().replace('/', "\\");
        assert!(shown.ends_with(r"Logs\dcs.log"), "{shown}");
        assert!(shown.starts_with(r"C:\SG\DCS"), "{shown}");
    }

    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn falls_back_to_the_writedir_global_when_lfs_is_absent() {
        let lua = Lua::new();
        lua.load(r#"__DCS_STUDIO_WRITEDIR = "C:\\SG\\DCS""#)
            .exec()
            .expect("seed global");

        let resolved = resolve_under_writedir(&lua, "a.json").expect("contained path");
        assert!(resolved.to_string_lossy().contains("a.json"));
    }

    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn refuses_an_escaping_path_before_touching_lua() {
        // No lfs and no writedir global: an escaping path must still fail with
        // the escape error, proving the guard runs before resolution and never
        // leaks the write root's location into the message.
        let lua = Lua::new();
        let err = resolve_under_writedir(&lua, "../../secrets").expect_err("must refuse");
        assert!(err.contains("path escapes the write root"), "{err}");
        assert!(!err.contains("writedir() unavailable"), "{err}");
    }

    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn reports_an_unavailable_writedir_for_a_contained_path() {
        let lua = Lua::new();
        let err = resolve_under_writedir(&lua, "a.json").expect_err("no writedir seeded");
        assert!(err.contains("lfs.writedir() unavailable"), "{err}");
    }
}
