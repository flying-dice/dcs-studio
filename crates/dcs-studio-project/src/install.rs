//! Apply a manifest's `[[install]]` rules to this machine
//! (model: `studio::installer::Installer.InstallProject`).

use std::fs;
use std::path::{Component, Path, PathBuf};

use walkdir::WalkDir;

/// Per-machine resolution of the named destination roots.
#[derive(Debug)]
pub struct RootMap {
    pub saved_games: PathBuf,
    pub game_install: Option<PathBuf>,
}

/// What an install pass did.
#[derive(Debug, serde::Serialize)]
pub struct InstallReport {
    pub copied: usize,
}

/// Apply every `[[install]]` rule of the project at `root`, rule by rule.
/// A file source copies into the `dest` directory; a directory source
/// copies recursively under it. Destination directories are created.
///
/// # Errors
///
/// The manifest fails to load or declares no rules, a `dest` references an
/// unconfigured `{GameInstall}` (or no named root at all), a `source` does
/// not exist, or any copy fails.
pub fn install(root: &Path, roots: &RootMap) -> Result<InstallReport, String> {
    let manifest = crate::manifest::load(root)?;
    if manifest.install.is_empty() {
        return Err("dcs-studio.toml declares no [[install]] rules — nothing to install".into());
    }
    let mut copied = 0usize;
    for rule in &manifest.install {
        if !stays_under(&rule.source) {
            return Err(format!(
                "install rule source '{}' escapes the project root",
                rule.source
            ));
        }
        let dest = resolve_dest(&rule.dest, roots)?;
        let source = root.join(rule.source.trim_end_matches(['/', '\\']));
        if !source.exists() {
            let hint = if Path::new(&rule.source).starts_with("target") {
                " — build the project first (cargo build --release)"
            } else {
                ""
            };
            return Err(format!(
                "install rule source '{}' not found{hint}",
                rule.source
            ));
        }
        if source.is_dir() {
            copied += copy_tree(&source, &dest)?;
        } else {
            let file_name = source
                .file_name()
                .ok_or_else(|| format!("install rule source '{}' has no file name", rule.source))?;
            copy_file(&source, &dest.join(file_name))?;
            copied += 1;
        }
    }
    Ok(InstallReport { copied })
}

/// Every component is a plain name — no `..`, no `.`, no absolute or
/// drive-prefixed segments — so joining `path` under a root cannot escape
/// it. Mirrors the scaffold guard (`scaffold::init`).
fn stays_under(path: &str) -> bool {
    Path::new(path)
        .components()
        .all(|component| matches!(component, Component::Normal(_)))
}

/// The dest remainder after its named root, rejected unless it stays under
/// that root.
fn contained_rest<'a>(dest: &str, rest: &'a str) -> Result<&'a str, String> {
    let rest = rest.trim_start_matches(['/', '\\']);
    if stays_under(rest) {
        Ok(rest)
    } else {
        Err(format!("install rule dest '{dest}' escapes its named root"))
    }
}

/// Swap the leading named root for its per-machine path.
fn resolve_dest(dest: &str, roots: &RootMap) -> Result<PathBuf, String> {
    if let Some(rest) = dest.strip_prefix("{SavedGames}") {
        Ok(roots.saved_games.join(contained_rest(dest, rest)?))
    } else if let Some(rest) = dest.strip_prefix("{GameInstall}") {
        let base = roots.game_install.as_ref().ok_or_else(|| {
            format!(
                "install rule dest '{dest}' references {{GameInstall}}, which is not configured (pass --game-install)"
            )
        })?;
        Ok(base.join(contained_rest(dest, rest)?))
    } else {
        Err(format!(
            "install rule dest '{dest}' must start with a named root ({{SavedGames}} or {{GameInstall}})"
        ))
    }
}

/// Copy every file under `source` to the same relative path under `dest`.
fn copy_tree(source: &Path, dest: &Path) -> Result<usize, String> {
    let mut copied = 0usize;
    for entry in WalkDir::new(source) {
        let entry = entry.map_err(|e| format!("walking {}: {e}", source.display()))?;
        if !entry.file_type().is_file() {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(source)
            .map_err(|e| format!("resolving {}: {e}", entry.path().display()))?;
        copy_file(entry.path(), &dest.join(relative))?;
        copied += 1;
    }
    Ok(copied)
}

fn copy_file(source: &Path, dest: &Path) -> Result<(), String> {
    if let Some(dir) = dest.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;
    }
    fs::copy(source, dest)
        .map_err(|e| format!("copying {} to {}: {e}", source.display(), dest.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("dcs-install-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    fn write_manifest(root: &Path, rules: &str) {
        let manifest = format!("[project]\nname = \"Test\"\n\n{rules}");
        fs::write(root.join("dcs-studio.toml"), manifest).expect("manifest written");
    }

    #[test]
    fn file_rule_copies_into_dest_directory() {
        let base = temp_root("file-rule");
        let (project, saved) = (base.join("project"), base.join("saved"));
        fs::create_dir_all(project.join("out")).expect("dirs");
        fs::write(project.join("out/mod.dll"), b"dll bytes").expect("source file");
        write_manifest(
            &project,
            "[[install]]\nsource = \"out/mod.dll\"\ndest = \"{SavedGames}/Mods/tech/x/bin\"\n",
        );
        let roots = RootMap {
            saved_games: saved.clone(),
            game_install: None,
        };
        let report = install(&project, &roots).expect("install succeeds");
        assert_eq!(report.copied, 1);
        assert!(saved.join("Mods/tech/x/bin/mod.dll").is_file());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn directory_rule_copies_recursively() {
        let base = temp_root("dir-rule");
        let (project, saved) = (base.join("project"), base.join("saved"));
        fs::create_dir_all(project.join("Scripts/x/sub")).expect("dirs");
        fs::write(project.join("Scripts/x/main.lua"), "return 1\n").expect("file");
        fs::write(project.join("Scripts/x/sub/util.lua"), "return 2\n").expect("file");
        write_manifest(
            &project,
            "[[install]]\nsource = \"Scripts/x/\"\ndest = \"{SavedGames}/Scripts/x\"\n",
        );
        let roots = RootMap {
            saved_games: saved.clone(),
            game_install: None,
        };
        let report = install(&project, &roots).expect("install succeeds");
        assert_eq!(report.copied, 2);
        assert!(saved.join("Scripts/x/main.lua").is_file());
        assert!(saved.join("Scripts/x/sub/util.lua").is_file());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn missing_target_source_hints_at_building_first() {
        let base = temp_root("missing-source");
        let project = base.join("project");
        fs::create_dir_all(&project).expect("dirs");
        write_manifest(
            &project,
            "[[install]]\nsource = \"target/release/x.dll\"\ndest = \"{SavedGames}/Mods/x\"\n",
        );
        let roots = RootMap {
            saved_games: base.join("saved"),
            game_install: None,
        };
        let error = install(&project, &roots).expect_err("missing source must fail");
        assert!(
            error.contains("target/release/x.dll"),
            "names the rule: {error}"
        );
        assert!(error.contains("build the project first"), "hints: {error}");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn dest_escaping_the_named_root_is_rejected() {
        let base = temp_root("dest-escape");
        let (project, saved) = (base.join("project"), base.join("saved"));
        fs::create_dir_all(&project).expect("dirs");
        fs::create_dir_all(&saved).expect("saved root");
        fs::write(project.join("mod.dll"), b"dll bytes").expect("source file");
        write_manifest(
            &project,
            "[[install]]\nsource = \"mod.dll\"\ndest = \"{SavedGames}/../escaped/bin\"\n",
        );
        let roots = RootMap {
            saved_games: saved.clone(),
            game_install: None,
        };
        let error = install(&project, &roots).expect_err("escaping dest must fail");
        assert!(
            error.contains("{SavedGames}/../escaped/bin"),
            "names the rule: {error}"
        );
        assert!(
            !base.join("escaped").exists(),
            "nothing lands outside the named root"
        );
        assert_eq!(
            fs::read_dir(&saved).expect("saved listable").count(),
            0,
            "nothing copied at all"
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn source_escaping_the_project_root_is_rejected() {
        let base = temp_root("source-escape");
        let project = base.join("project");
        fs::create_dir_all(&project).expect("dirs");
        fs::write(base.join("outside.txt"), b"secret").expect("outside file");
        write_manifest(
            &project,
            "[[install]]\nsource = \"../outside.txt\"\ndest = \"{SavedGames}/Scripts\"\n",
        );
        let roots = RootMap {
            saved_games: base.join("saved"),
            game_install: None,
        };
        let error = install(&project, &roots).expect_err("escaping source must fail");
        assert!(error.contains("../outside.txt"), "names the rule: {error}");
        assert!(!base.join("saved").exists(), "nothing copied");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn game_install_reference_without_root_is_an_error() {
        let base = temp_root("no-game-install");
        let project = base.join("project");
        fs::create_dir_all(&project).expect("dirs");
        fs::write(project.join("a.lua"), "return 0\n").expect("source file");
        write_manifest(
            &project,
            "[[install]]\nsource = \"a.lua\"\ndest = \"{GameInstall}/Scripts\"\n",
        );
        let roots = RootMap {
            saved_games: base.join("saved"),
            game_install: None,
        };
        let error = install(&project, &roots).expect_err("unresolved root must fail");
        assert!(error.contains("{GameInstall}"), "names the root: {error}");
        let _ = fs::remove_dir_all(&base);
    }
}
