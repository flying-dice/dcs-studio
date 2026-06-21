//! The `check` tool — analyse a workspace, render findings, count the
//! error-severity ones the caller gates on (model: `studio::mcp::McpServer.Check`).

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

    // No extra roots: `check` deliberately does not index vendored
    // `.lua-cargo/deps` — dep code carries its own lint noise. Editor
    // intelligence (lua-analyzer) opts those roots in; the CLI/MCP gate does not.
    let files = dcs_studio_project::sources::collect(root, &[]);
    let mut workspace = Workspace::new();
    for (path, text) in &files {
        workspace.set_source(path, text);
    }
    // Honour the project's `[lints.lua]` levels (absent/invalid manifest →
    // defaults); inline `---@allow`/`deny`/… directives apply regardless.
    workspace.set_lint_levels(dcs_lua_lsp_core::lints::levels_from_strings(
        &dcs_studio_project::manifest::lua_lint_levels(root),
    ));
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

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_project(toml: &str, lua: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("cli-check-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        std::fs::write(dir.join("dcs-studio.toml"), toml).expect("manifest");
        std::fs::write(dir.join("checks.lua"), lua).expect("lua");
        dir
    }

    #[test]
    fn lints_lua_level_silences_the_code() {
        // `{} + 1` is operator-type-mismatch; `[lints.lua]` allows it away.
        let lua = "local x = {} + 1\n";
        let with = temp_project(
            "[project]\nname = \"x\"\n\n[lints.lua]\noperator-type-mismatch = \"allow\"\n",
            lua,
        );
        assert!(run(&with).rendered.contains("no findings"), "{}", run(&with).rendered);
        let _ = std::fs::remove_dir_all(&with);

        // Without the [lints] section the warning is reported.
        let without = temp_project("[project]\nname = \"x\"\n", lua);
        assert!(
            run(&without).rendered.contains("operator-type-mismatch"),
            "{}",
            run(&without).rendered
        );
        let _ = std::fs::remove_dir_all(&without);
    }
}
