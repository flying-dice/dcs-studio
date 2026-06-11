//! Rust toolchain detection (model: `studio::build::Builder.DetectToolchain`).
//! Absence is data, never an error.

use std::process::Stdio;

/// First `--version` line of each tool, or `None` when it is not runnable.
#[derive(Debug, serde::Serialize)]
pub struct ToolchainStatus {
    pub cargo: Option<String>,
    pub rustup: Option<String>,
}

/// Probe `cargo` and `rustup` on `PATH`.
#[must_use]
pub fn detect() -> ToolchainStatus {
    ToolchainStatus {
        cargo: version_of("cargo"),
        rustup: version_of("rustup"),
    }
}

/// Locate a runnable `rust-analyzer` (model: `studio::lang::RustAnalyzer`
/// detection): the binary on `PATH` first, else the rustup-managed
/// component via `rustup which`. `None` when neither answers — absence is
/// data here too.
#[must_use]
pub fn rust_analyzer() -> Option<String> {
    if version_of("rust-analyzer").is_some() {
        return Some("rust-analyzer".to_string());
    }
    let output = crate::process::quiet_command("rustup")
        .args(["which", "rust-analyzer"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!path.is_empty() && std::path::Path::new(&path).exists()).then_some(path)
}

fn version_of(tool: &str) -> Option<String> {
    let output = crate::process::quiet_command(tool)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_never_panics() {
        // What's installed is environment-dependent; the contract is only
        // that probing is total.
        let status = detect();
        let _ = (status.cargo, status.rustup);
    }

    #[test]
    fn rust_analyzer_probe_never_panics() {
        // Whether rust-analyzer is installed is machine-dependent; the
        // contract is only that the probe is total.
        let _ = rust_analyzer();
    }
}
