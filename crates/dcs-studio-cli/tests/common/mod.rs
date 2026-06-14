//! Shared helpers for the CLI integration tests.

use std::path::{Path, PathBuf};

/// The built dcs-lua-runner, or `None` (callers skip via the `host_ipc`
/// pattern). `DCS_LUA_RUNNER` wins; otherwise the runner's own debug
/// target next to the manifest.
pub fn runner_binary() -> Option<PathBuf> {
    if let Some(pinned) = std::env::var_os("DCS_LUA_RUNNER") {
        let path = PathBuf::from(pinned);
        return path.is_file().then_some(path);
    }
    let name = if cfg!(windows) {
        "dcs-lua-runner.exe"
    } else {
        "dcs-lua-runner"
    };
    let local = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tools/lua-runner/target/debug")
        .join(name);
    local.is_file().then_some(local)
}

/// Create a fresh temp directory with a `dcs-studio.toml` and the given
/// extra files. `tag` distinguishes directories so parallel tests do not
/// collide. The caller is responsible for cleanup (`remove_dir_all`).
pub fn temp_project(prefix: &str, tag: &str, manifest: &str, files: &[(&str, &str)]) -> PathBuf {
    let root = std::env::temp_dir().join(format!("{prefix}-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("temp root");
    std::fs::write(root.join("dcs-studio.toml"), manifest).expect("manifest");
    for (path, contents) in files {
        let full = root.join(path);
        std::fs::create_dir_all(full.parent().expect("parent")).expect("dirs");
        std::fs::write(full, contents).expect("file");
    }
    root
}
