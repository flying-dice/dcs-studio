//! Workspace findings — **the single source of the finding set**.
//!
//! Every edge (CLI `check`, MCP `check`, the hosted LSP server, the wasm
//! `IdeSession` Problems panel) decides "what is a finding for this file" by
//! calling [`findings_by_file`] (or its derivations [`all_findings`] /
//! [`file_findings`]) and then mapping the result to its own wire shape. No
//! edge re-implements the aggregation, so a new finding category — type
//! checks today, resolution/lints tomorrow — is added here once and every
//! transport inherits it. (This module exists because the aggregation used
//! to be copy-pasted per edge and silently drifted: the LSP path published
//! parse errors only while the wasm path also published type errors.)

use std::collections::HashMap;

use dcs_lua_syntax::Diagnostic;

use crate::check::check_types;
use crate::workspace::Workspace;

/// The finding set per mounted file: each file's parse diagnostics plus the
/// workspace type-checker's `LUA-Txxx` findings for that file, each list
/// ordered by offset. One `check_types` pass for the whole workspace, so
/// callers that need every file (the LSP boot walk) pay it once.
#[must_use]
pub fn findings_by_file(workspace: &Workspace) -> HashMap<String, Vec<Diagnostic>> {
    let mut by_path: HashMap<String, Vec<Diagnostic>> = workspace
        .files()
        .map(|(path, entry)| (path.to_string(), entry.parsed.diagnostics.clone()))
        .collect();
    for (path, diagnostic) in check_types(workspace) {
        by_path.entry(path).or_default().push(diagnostic);
    }
    for list in by_path.values_mut() {
        list.sort_by_key(|diagnostic| diagnostic.span.start);
    }
    by_path
}

/// Every finding for one file (empty if unmounted), ordered by offset — the
/// per-file slice of [`findings_by_file`].
#[must_use]
pub fn file_findings(workspace: &Workspace, path: &str) -> Vec<Diagnostic> {
    findings_by_file(workspace).remove(path).unwrap_or_default()
}

/// Every finding across the mounted workspace, paired with its file path,
/// ordered by path then offset.
#[must_use]
pub fn all_findings(workspace: &Workspace) -> Vec<(String, Diagnostic)> {
    let mut all: Vec<(String, Diagnostic)> = findings_by_file(workspace)
        .into_iter()
        .flat_map(|(path, list)| list.into_iter().map(move |d| (path.clone(), d)))
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
