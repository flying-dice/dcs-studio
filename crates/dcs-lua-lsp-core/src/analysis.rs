//! Workspace-wide findings — the one aggregation every edge shares
//! (CLI `check`, MCP `check` tool, LSP publish, IDE Problems panel).

use dcs_lua_syntax::Diagnostic;

use crate::workspace::Workspace;

/// Every finding across the mounted workspace, paired with its file path,
/// ordered by path then offset.
#[must_use]
pub fn all_findings(workspace: &Workspace) -> Vec<(String, Diagnostic)> {
    let mut all: Vec<(String, Diagnostic)> = workspace
        .files()
        .flat_map(|(path, entry)| {
            entry
                .parsed
                .diagnostics
                .iter()
                .cloned()
                .map(move |diagnostic| (path.to_string(), diagnostic))
        })
        .collect();
    all.sort_by(|a, b| (a.0.as_str(), a.1.span.start).cmp(&(b.0.as_str(), b.1.span.start)));
    all
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn findings_pair_paths_and_sort() {
        let mut ws = Workspace::new();
        ws.set_source("b.lua", "function f(");
        ws.set_source("a.lua", "local x = 1");
        let findings = all_findings(&ws);
        assert!(!findings.is_empty());
        assert!(findings.iter().all(|(path, _)| path == "b.lua"));
    }
}
