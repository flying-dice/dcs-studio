//! Shelling out to the installed `git` (model `studio::cargolua::Git`). One
//! mechanism, no embedded git — gix has no production push and the resolver only
//! reads. Every spawn goes through [`quiet_command`] so a windowed host (the
//! IDE) never flashes a console; on a non-zero exit the captured `stderr` rides
//! along in the returned [`CargoError`].

use std::path::Path;
use std::process::Command;

use crate::CargoError;

/// A [`Command`] that never flashes a console window: on Windows the child is
/// created with `CREATE_NO_WINDOW` (vital under a windowed app like the IDE,
/// where each bare spawn pops a console); elsewhere it is a plain `Command`.
///
/// Copied from `dcs-studio-project::process` to keep lua-cargo lean (no
/// dependency on the project crate).
#[must_use]
pub fn quiet_command(program: &str) -> Command {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// Whether `git --version` succeeds — used to fail resolve closed and to gate
/// the git-backed tests.
#[must_use]
pub fn git_available() -> bool {
    quiet_command("git")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Run `git <args>` in `dir`, mapping a spawn failure or non-zero exit to
/// `err(stderr)`. The closure lets each call name its own error variant.
fn run_git<F>(dir: Option<&Path>, args: &[&str], err: F) -> Result<std::process::Output, CargoError>
where
    F: FnOnce(String) -> CargoError,
{
    let mut cmd = quiet_command("git");
    if let Some(dir) = dir {
        cmd.current_dir(dir);
    }
    cmd.args(args);
    let output = cmd
        .output()
        .map_err(|e| CargoError::Git(format!("spawning git: {e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(err(stderr));
    }
    Ok(output)
}

/// `git clone <url> <dir>`.
///
/// # Errors
///
/// The clone fails (network, auth, bad repo) — [`CargoError::CloneFailed`].
pub fn clone(url: &str, dir: &Path) -> Result<(), CargoError> {
    let dir_str = dir.to_string_lossy();
    // `--` ends option parsing so a manifest-supplied url that begins with `-`
    // can't be read as a git option (args go via a slice — no shell — so this
    // is option-injection defence, not shell-injection).
    run_git(
        None,
        &["clone", "--", url, dir_str.as_ref()],
        |stderr| CargoError::CloneFailed(format!("cloning {url}: {stderr}")),
    )?;
    Ok(())
}

/// `git fetch --tags --force` in an existing checkout.
///
/// # Errors
///
/// The fetch fails — [`CargoError::CloneFailed`] (a fetch is the re-resolve
/// counterpart of a clone).
pub fn fetch(dir: &Path) -> Result<(), CargoError> {
    run_git(
        Some(dir),
        &["fetch", "--tags", "--force", "origin"],
        |stderr| CargoError::CloneFailed(format!("fetching: {stderr}")),
    )?;
    Ok(())
}

/// `git checkout <refname>` (a branch, tag, or rev).
///
/// # Errors
///
/// The ref does not exist — [`CargoError::RefNotFound`].
pub fn checkout(dir: &Path, refname: &str) -> Result<(), CargoError> {
    // A ref starting with `-` would be read as a git option (and `checkout`
    // can't use `--` here — that turns the arg into a PATHSPEC, not a
    // commit-ish). Reject it outright; a real branch/tag/sha never starts `-`.
    if refname.starts_with('-') {
        return Err(CargoError::RefNotFound(format!(
            "invalid ref {refname:?} (must not start with '-')"
        )));
    }
    run_git(Some(dir), &["checkout", "--detach", refname], |stderr| {
        CargoError::RefNotFound(format!("checking out {refname}: {stderr}"))
    })?;
    Ok(())
}

/// `git rev-parse HEAD` — the resolved SHA captured into the lockfile.
///
/// # Errors
///
/// The invocation fails — [`CargoError::Git`].
pub fn rev_parse_head(dir: &Path) -> Result<String, CargoError> {
    let output = run_git(Some(dir), &["rev-parse", "HEAD"], CargoError::Git)?;
    let sha = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if sha.is_empty() {
        return Err(CargoError::Git("rev-parse HEAD returned nothing".into()));
    }
    Ok(sha)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_available_does_not_panic() {
        // Result depends on the host; we only assert it runs.
        let _ = git_available();
    }

    #[test]
    fn checkout_of_missing_ref_is_ref_not_found() {
        if !git_available() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("lua-cargo-git-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("mkdir");
        // An empty (non-repo) dir: checkout fails; we only assert the variant.
        let err = checkout(&dir, "nope").unwrap_err();
        assert!(matches!(err, CargoError::RefNotFound(_)), "{err:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
