//! `dcs-studio-cli check` — analyse a workspace, print findings, gate on
//! the exit code (model: `studio::cli::Cli.Check`).

use std::path::Path;

use dcs_lua_lsp_core::workspace::Workspace;
use dcs_lua_syntax::{LineIndex, Severity};

pub struct Report {
    pub rendered: String,
    pub error_count: usize,
}

/// Mount every Lua source under `root` and render its findings as
/// `path:line:col: severity: message [code]`, one per line.
#[must_use]
pub fn run(root: &Path) -> Report {
    use std::fmt::Write as _;

    let files = crate::sources::collect(root);
    let mut workspace = Workspace::new();
    for (path, text) in &files {
        workspace.set_source(path, text);
    }
    let findings = dcs_lua_lsp_core::all_findings(&workspace);

    let mut rendered = String::new();
    let mut error_count = 0;
    for (path, diagnostic) in &findings {
        let severity = match diagnostic.severity {
            Severity::Error => {
                error_count += 1;
                "error"
            }
            Severity::Warning => "warning",
            Severity::Info => "info",
        };
        let (line, col) = workspace.file(path).map_or((1, 1), |entry| {
            LineIndex::new(&entry.source).line_col(diagnostic.span.start)
        });
        let _ = writeln!(
            rendered,
            "{path}:{line}:{col}: {severity}: {} [{}]",
            diagnostic.message, diagnostic.code
        );
    }
    if findings.is_empty() {
        let _ = writeln!(rendered, "{} file(s) checked, no findings", files.len());
    }
    Report {
        rendered,
        error_count,
    }
}
