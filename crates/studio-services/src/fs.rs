// Filesystem service backing the project/file explorer and the MCP
// workspace tools (model/studio/files.pds). Custom logic (rather than the
// Tauri fs plugin) so the IDE can open arbitrary folders without per-path
// scope configuration.
use std::path::Path;

#[derive(serde::Serialize)]
pub struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

/// List the immediate children of `path`, directories first then files,
/// each group sorted case-insensitively by name. Used for lazy tree expansion.
pub fn read_dir(path: &str) -> Result<Vec<DirEntry>, String> {
    let mut entries: Vec<DirEntry> = std::fs::read_dir(path)
        .map_err(|e| format!("Failed to read '{}': {}", path, e))?
        .filter_map(|res| res.ok())
        .map(|entry| {
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            DirEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                path: entry.path().to_string_lossy().into_owned(),
                is_dir,
            }
        })
        .collect();

    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

/// Read a UTF-8 text file's contents.
pub fn read_text_file(path: &str) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| format!("Failed to read '{}': {}", path, e))
}

/// Write `contents` to a text file, creating or truncating it.
pub fn write_text_file(path: &str, contents: &str) -> Result<(), String> {
    std::fs::write(path, contents).map_err(|e| format!("Failed to write '{}': {}", path, e))
}

/// The final path component (folder/file name), used to label the workspace root.
///
/// DCS paths are Windows paths (`C:\Users\...\Saved Games\...`), but this runs
/// on the Linux CI box too, where `Path::file_name` does not treat `\` as a
/// separator — so split on BOTH separators explicitly, cross-platform.
pub fn basename(path: &str) -> String {
    path.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(path)
        .to_string()
}

/// Whether a path currently exists on disk. Used to flag stale recent projects.
pub fn path_exists(path: &str) -> bool {
    Path::new(path).exists()
}

/// Scaffold `<parent>/<name>` from a named template (`blank`, `lua-script`,
/// `rust-dll`) via the shared project kit (model/studio/cli.pds `Init`,
/// issue #6 R1): refuses an existing root, renders the files in Rust.
/// Returns the new root path.
pub fn create_project_from_template(
    parent: &str,
    name: &str,
    template: &str,
) -> Result<String, String> {
    dcs_studio_project::scaffold::init(template, Path::new(parent), name)
        .map(|root| root.to_string_lossy().into_owned())
}

/// Lexically split a path into its meaningful components, resolving `.` and
/// `..` without touching the filesystem (so it works for targets that do not
/// exist yet). Splits on BOTH separators — DCS paths are Windows paths, but
/// this runs on the Linux CI box too where `Path` does not treat `\` as a
/// separator. A leading drive (`C:`) stays as the first component.
fn normalize_components(path: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for segment in path.split(['/', '\\']) {
        match segment {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            seg => out.push(seg.to_string()),
        }
    }
    out
}

/// Whether `path` stays inside `root`: its normalised form is `root` or a
/// descendant, with no `..`/absolute/drive segment escaping it (model
/// `WorkspaceFs.StaysUnderRoot`). Comparison is case-insensitive — Windows
/// paths are. A `..` that climbs above the root collapses to a non-prefixed
/// path and is rejected.
pub fn stays_under_root(root: &str, path: &str) -> bool {
    let root = normalize_components(root);
    let path = normalize_components(path);
    !root.is_empty()
        && path.len() >= root.len()
        && root
            .iter()
            .zip(&path)
            .all(|(a, b)| a.eq_ignore_ascii_case(b))
}

/// Guarded `std::fs::rename` of `src` to `dst`, both inside `root`. Refuses
/// when `dst` already exists — a rename never clobbers (model
/// `WorkspaceFs.RenamePath`).
pub fn rename_path(root: &str, src: &str, dst: &str) -> Result<(), String> {
    if !stays_under_root(root, src) {
        return Err(format!("'{src}' is outside the workspace"));
    }
    if !stays_under_root(root, dst) {
        return Err(format!("'{dst}' is outside the workspace"));
    }
    if path_exists(dst) {
        return Err(format!("'{dst}' already exists"));
    }
    std::fs::rename(src, dst).map_err(|e| format!("Failed to rename '{src}': {e}"))
}

/// Duplicate `path` (inside `root`) beside itself under a derived,
/// non-colliding name; returns the new path (model
/// `WorkspaceFs.DuplicatePath`).
pub fn duplicate_path(root: &str, path: &str) -> Result<String, String> {
    if !stays_under_root(root, path) {
        return Err(format!("'{path}' is outside the workspace"));
    }
    let dest = sibling_copy_name(path)?;
    let src = Path::new(path);
    if src.is_dir() {
        copy_dir_recursive(src, Path::new(&dest))?;
    } else {
        std::fs::copy(src, &dest).map_err(|e| format!("Failed to copy '{path}': {e}"))?;
    }
    Ok(dest)
}

/// Create an empty file `<parent>/<name>` inside `root`; returns its path.
/// Refuses when the target already exists (model `WorkspaceFs.CreateFile`).
pub fn create_file(root: &str, parent: &str, name: &str) -> Result<String, String> {
    if !stays_under_root(root, parent) {
        return Err(format!("'{parent}' is outside the workspace"));
    }
    let target = Path::new(parent).join(name);
    let target = target.to_string_lossy().into_owned();
    if path_exists(&target) {
        return Err(format!("'{target}' already exists"));
    }
    std::fs::write(&target, "").map_err(|e| format!("Failed to create '{target}': {e}"))?;
    Ok(target)
}

/// Create a directory `<parent>/<name>` inside `root`; returns its path.
/// Refuses when the target already exists (model `WorkspaceFs.CreateDir`).
pub fn create_dir(root: &str, parent: &str, name: &str) -> Result<String, String> {
    if !stays_under_root(root, parent) {
        return Err(format!("'{parent}' is outside the workspace"));
    }
    let target = Path::new(parent).join(name);
    let target = target.to_string_lossy().into_owned();
    if path_exists(&target) {
        return Err(format!("'{target}' already exists"));
    }
    std::fs::create_dir(&target).map_err(|e| format!("Failed to create '{target}': {e}"))?;
    Ok(target)
}

/// Delete `path` (inside `root`) to the OS Recycle Bin — never a hard delete,
/// so a misclick is always recoverable (model `WorkspaceFs.DeleteToTrash`).
pub fn delete_to_trash(root: &str, path: &str) -> Result<(), String> {
    if !stays_under_root(root, path) {
        return Err(format!("'{path}' is outside the workspace"));
    }
    trash::delete(path).map_err(|e| format!("Failed to delete '{path}': {e}"))
}

/// The first non-colliding `<stem> copy[.ext]`, `<stem> copy 2`, … beside
/// `path`. Preserves the extension; folders get the suffix on the whole name.
fn sibling_copy_name(path: &str) -> Result<String, String> {
    let p = Path::new(path);
    let parent = p.parent().unwrap_or_else(|| Path::new(""));
    let (stem, ext) = if p.is_dir() {
        (
            p.file_name().map(|s| s.to_string_lossy().into_owned()),
            None,
        )
    } else {
        (
            p.file_stem().map(|s| s.to_string_lossy().into_owned()),
            p.extension().map(|s| s.to_string_lossy().into_owned()),
        )
    };
    let stem = stem.ok_or_else(|| format!("'{path}' has no file name"))?;
    for n in 1..10_000 {
        let base = if n == 1 {
            format!("{stem} copy")
        } else {
            format!("{stem} copy {n}")
        };
        let name = match &ext {
            Some(ext) => format!("{base}.{ext}"),
            None => base,
        };
        let candidate = parent.join(&name);
        if !candidate.exists() {
            return Ok(candidate.to_string_lossy().into_owned());
        }
    }
    Err(format!("could not derive a free copy name for '{path}'"))
}

/// Recursively copy `src` dir to `dst`.
fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst)
        .map_err(|e| format!("Failed to create '{}': {e}", dst.display()))?;
    for entry in
        std::fs::read_dir(src).map_err(|e| format!("Failed to read '{}': {e}", src.display()))?
    {
        let entry = entry.map_err(|e| format!("Failed to read entry: {e}"))?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)
                .map_err(|e| format!("Failed to copy '{}': {e}", from.display()))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("studio-services-fs-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn read_dir_lists_directories_first_then_files_case_insensitively() {
        // The fixture must discriminate case-insensitive from byte order:
        // byte order would yield Gamma < beta (dirs) and Echo.lua < b.lua
        // (files); case-insensitive order does not.
        let root = temp_dir("read-dir");
        std::fs::create_dir(root.join("zeta")).expect("dir");
        std::fs::create_dir(root.join("Alpha")).expect("dir");
        std::fs::create_dir(root.join("beta")).expect("dir");
        std::fs::create_dir(root.join("Gamma")).expect("dir");
        std::fs::write(root.join("b.lua"), "").expect("file");
        std::fs::write(root.join("A.lua"), "").expect("file");
        std::fs::write(root.join("Echo.lua"), "").expect("file");

        let entries = read_dir(&root.to_string_lossy()).expect("listing");
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["Alpha", "beta", "Gamma", "zeta", "A.lua", "b.lua", "Echo.lua"]
        );
        assert!(entries[..4].iter().all(|e| e.is_dir));
        assert!(entries[4..].iter().all(|e| !e.is_dir));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn write_into_a_missing_parent_reports_the_path() {
        let root = temp_dir("write-missing-parent");
        let path = root.join("no-such-dir").join("note.txt");
        let Err(err) = write_text_file(&path.to_string_lossy(), "x") else {
            panic!("writing under a missing parent must fail");
        };
        assert!(err.contains("Failed to write"), "err was: {err}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn read_dir_on_a_missing_path_reports_the_path() {
        let Err(err) = read_dir(r"Z:\definitely\not\here") else {
            panic!("a missing path must not list");
        };
        assert!(err.contains("Failed to read"), "err was: {err}");
    }

    #[test]
    fn text_round_trip_and_existence() {
        let root = temp_dir("round-trip");
        let file = root.join("note.txt");
        let path = file.to_string_lossy();
        assert!(!path_exists(&path));
        write_text_file(&path, "hello agent").expect("write");
        assert!(path_exists(&path));
        assert_eq!(read_text_file(&path).expect("read"), "hello agent");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn basename_takes_the_final_component_or_echoes_the_input() {
        assert_eq!(basename(r"C:\projects\My Mod"), "My Mod");
        assert_eq!(basename(""), "");
    }

    #[test]
    fn stays_under_root_accepts_descendants_and_rejects_escapes() {
        let root = r"C:\proj";
        assert!(stays_under_root(root, r"C:\proj"));
        assert!(stays_under_root(root, r"C:\proj\sub\a.lua"));
        // Case-insensitive (Windows paths are).
        assert!(stays_under_root(root, r"c:\PROJ\a.lua"));
        // A `..` that climbs above the root collapses to a non-prefixed path.
        assert!(!stays_under_root(root, r"C:\proj\..\other\a.lua"));
        // A sibling directory sharing a name prefix is not inside the root.
        assert!(!stays_under_root(root, r"C:\proj-evil\a.lua"));
        // A wholly different root.
        assert!(!stays_under_root(root, r"D:\elsewhere\a.lua"));
        // Forward slashes normalise the same way (CI is Linux).
        assert!(stays_under_root("/home/proj", "/home/proj/sub/a.lua"));
        assert!(!stays_under_root("/home/proj", "/home/proj/../etc"));
    }

    #[test]
    fn rename_refuses_a_collision_and_leaves_both_files() {
        let root = temp_dir("rename-collision");
        let a = root.join("a.lua");
        let b = root.join("b.lua");
        std::fs::write(&a, "aaa").expect("a");
        std::fs::write(&b, "bbb").expect("b");
        let root_s = root.to_string_lossy();
        let err = rename_path(&root_s, &a.to_string_lossy(), &b.to_string_lossy())
            .expect_err("renaming onto an existing file must be refused");
        assert!(err.contains("already exists"), "err was: {err}");
        // Both files keep their original contents.
        assert_eq!(read_text_file(&a.to_string_lossy()).expect("a"), "aaa");
        assert_eq!(read_text_file(&b.to_string_lossy()).expect("b"), "bbb");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rename_moves_when_the_target_is_free() {
        let root = temp_dir("rename-move");
        let a = root.join("a.lua");
        let c = root.join("c.lua");
        std::fs::write(&a, "aaa").expect("a");
        let root_s = root.to_string_lossy();
        rename_path(&root_s, &a.to_string_lossy(), &c.to_string_lossy()).expect("rename");
        assert!(!path_exists(&a.to_string_lossy()));
        assert_eq!(read_text_file(&c.to_string_lossy()).expect("c"), "aaa");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rename_refuses_a_destination_outside_the_root() {
        let root = temp_dir("rename-escape");
        let a = root.join("a.lua");
        std::fs::write(&a, "aaa").expect("a");
        let root_s = root.to_string_lossy();
        let escape = root.join("..").join("escaped.lua");
        let err = rename_path(&root_s, &a.to_string_lossy(), &escape.to_string_lossy())
            .expect_err("an escaping destination must be refused");
        assert!(err.contains("outside the workspace"), "err was: {err}");
        assert!(path_exists(&a.to_string_lossy()));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn create_file_and_dir_refuse_existing_targets() {
        let root = temp_dir("create");
        let root_s = root.to_string_lossy().into_owned();
        let path = create_file(&root_s, &root_s, "new.lua").expect("create file");
        assert_eq!(read_text_file(&path).expect("read"), "");
        let err = create_file(&root_s, &root_s, "new.lua").expect_err("must refuse a collision");
        assert!(err.contains("already exists"), "err was: {err}");

        create_dir(&root_s, &root_s, "pkg").expect("create dir");
        let err = create_dir(&root_s, &root_s, "pkg").expect_err("must refuse a collision");
        assert!(err.contains("already exists"), "err was: {err}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn duplicate_derives_a_non_colliding_copy_name() {
        let root = temp_dir("duplicate");
        let a = root.join("note.lua");
        std::fs::write(&a, "body").expect("a");
        let root_s = root.to_string_lossy().into_owned();
        let first = duplicate_path(&root_s, &a.to_string_lossy()).expect("dup 1");
        assert!(first.ends_with("note copy.lua"), "first was: {first}");
        assert_eq!(read_text_file(&first).expect("copy"), "body");
        // A second duplicate of the original must not collide with the first.
        let second = duplicate_path(&root_s, &a.to_string_lossy()).expect("dup 2");
        assert!(second.ends_with("note copy 2.lua"), "second was: {second}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn delete_to_trash_refuses_a_path_outside_the_root() {
        let root = temp_dir("trash-escape");
        let root_s = root.to_string_lossy();
        let outside = root.join("..").join("victim.lua");
        let err = delete_to_trash(&root_s, &outside.to_string_lossy())
            .expect_err("a path outside the workspace must be refused");
        assert!(err.contains("outside the workspace"), "err was: {err}");
        let _ = std::fs::remove_dir_all(&root);
    }
}
