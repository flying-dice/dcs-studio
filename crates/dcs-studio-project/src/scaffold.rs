//! Materialise a template on disk (model: `studio::cli::Cli.Init`).

use std::fs;
use std::path::{Component, Path, PathBuf};

/// Scaffold `<parent>/<name>` from `template`. Refuses an existing target
/// and any template path that could escape the new root.
///
/// # Errors
///
/// Unknown template id, an already-existing target folder, a template path
/// that escapes the project root, or any filesystem failure.
pub fn init(template: &str, parent: &Path, name: &str) -> Result<PathBuf, String> {
    let files = crate::templates::render(template, name).ok_or_else(|| {
        format!("unknown template '{template}' (try: lua-script, rust-dll, blank)")
    })?;
    let root = parent.join(name);
    if root.exists() {
        return Err(format!("'{}' already exists", root.display()));
    }
    for file in &files {
        let relative = Path::new(&file.path);
        let safe = relative
            .components()
            .all(|component| matches!(component, Component::Normal(_)));
        if !safe {
            return Err(format!(
                "template path '{}' escapes the project root",
                file.path
            ));
        }
        let destination = root.join(relative);
        if let Some(dir) = destination.parent() {
            fs::create_dir_all(dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;
        }
        fs::write(&destination, file.contents.as_bytes())
            .map_err(|e| format!("writing {}: {e}", destination.display()))?;
    }
    Ok(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("dcs-project-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn init_scaffolds_and_refuses_overwrite() {
        let parent = temp_root("init");
        let root = init("lua-script", &parent, "Test Mod").expect("scaffold succeeds");
        assert!(root.join("dcs-studio.toml").is_file());
        assert!(root.join("Scripts/test-mod/main.lua").is_file());
        let again = init("lua-script", &parent, "Test Mod");
        assert!(again.is_err(), "must refuse an existing root");
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn init_writes_rust_dll_binary_ingredients() {
        let parent = temp_root("init-rust");
        let root = init("rust-dll", &parent, "Native Mod").expect("scaffold succeeds");
        assert!(root.join("Cargo.toml").is_file());
        assert!(root.join(".cargo/config.toml").is_file());
        let lib = fs::read(root.join("lua5.1/lua.lib")).expect("lua.lib written");
        assert!(lib.starts_with(b"!<arch>"), "binary written verbatim");
        let _ = fs::remove_dir_all(&parent);
    }
}
