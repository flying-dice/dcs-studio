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
}
