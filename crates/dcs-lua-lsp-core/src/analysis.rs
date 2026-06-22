//! Workspace findings — **the single source of the finding set**.
//!
//! Every edge (CLI `check`, MCP `check`, the hosted `lua-analyzer` server,
//! the `dcs-lua-ide` wasm surface) decides "what is a finding for this file" by
//! calling [`findings_by_file`] (or its derivations [`all_findings`] /
//! [`file_findings`]) and then mapping the result to its own wire shape. No
//! edge re-implements the aggregation, so a new finding category — type
//! checks today, resolution/lints tomorrow — is added here once and every
//! transport inherits it. (This module exists because the aggregation used
//! to be copy-pasted per edge and silently drifted: the LSP path published
//! parse errors only while the in-page wasm path also published type errors.)

use std::collections::HashMap;

use dcs_lua_syntax::diagnostic::{Severity, codes};
use dcs_lua_syntax::{Diagnostic, Span};

use crate::check::check_types;
use crate::lints::{LintLevel, Resolver, default_level};
use crate::workspace::Workspace;

/// The finding set per mounted file: each file's parse diagnostics plus the
/// workspace type-checker's lint findings for that file, each list ordered by
/// offset. One `check_types` pass for the whole workspace, so callers that
/// need every file (the LSP boot walk) pay it once.
#[must_use]
pub fn findings_by_file(workspace: &Workspace) -> HashMap<String, Vec<Diagnostic>> {
    let mut by_path: HashMap<String, Vec<Diagnostic>> = workspace
        .files()
        .map(|(path, entry)| (path.to_string(), entry.parsed.diagnostics.clone()))
        .collect();
    for (path, diagnostic) in check_types(workspace) {
        by_path.entry(path).or_default().push(diagnostic);
    }
    // The require half: unresolved / shadowing findings, sharing the bundler's
    // resolution so the editor's verdict matches the bundle's (issue #51). Inert
    // until a host sets the project context (`Workspace::set_resolution`).
    for (path, diagnostic) in crate::requires::check_requires(workspace) {
        by_path.entry(path).or_default().push(diagnostic);
    }
    // Resolve each lint's level per file — inline `---@allow`/`warn`/`deny`/
    // `expect` directives over the project's `[lints.lua]` over the built-in
    // default — dropping `allow`ed findings, re-severitying the rest, and
    // raising `unfulfilled-lint-expectation` for an `expect` that never fired.
    for (path, list) in &mut by_path {
        let Some(entry) = workspace.file(path) else {
            continue;
        };
        apply_levels(&Resolver::parse(entry), workspace.lint_levels(), list);
    }
    for list in by_path.values_mut() {
        list.sort_by_key(|diagnostic| diagnostic.span.start);
    }
    by_path
}

/// Apply lint levels to one file's findings in place.
fn apply_levels(
    resolver: &Resolver,
    project: &HashMap<String, LintLevel>,
    list: &mut Vec<Diagnostic>,
) {
    // An `expect` whose lint never fired this pass reports against its marker.
    let fired: Vec<(u32, &str)> = list.iter().map(|d| (d.span.start, d.code)).collect();
    let unfulfilled = resolver.unfulfilled(&fired);
    drop(fired);
    for (marker, code) in unfulfilled {
        list.push(unfulfilled_expectation(marker, &code));
    }
    list.retain_mut(|diagnostic| {
        // Only levelled lints are governed; parse errors and the expectation
        // diagnostic pass through untouched.
        if default_level(diagnostic.code).is_none() {
            return true;
        }
        match resolver.level(diagnostic.span.start, diagnostic.code, project) {
            LintLevel::Allow => false,
            LintLevel::Warn => {
                diagnostic.severity = Severity::Warning;
                true
            }
            LintLevel::Deny | LintLevel::Forbid => {
                diagnostic.severity = Severity::Error;
                true
            }
        }
    });
}

fn unfulfilled_expectation(marker: Span, code: &str) -> Diagnostic {
    Diagnostic {
        severity: Severity::Warning,
        span: marker,
        code: codes::UNFULFILLED_EXPECTATION,
        code_description: "",
        message: format!("lint `{code}` was expected here but did not fire"),
    }
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

    #[test]
    fn allow_directive_silences_a_finding() {
        let mut ws = Workspace::new();
        // `{} + 1` is operator-type-mismatch, allowed by the directive above it.
        ws.set_source(
            "m.lua",
            "---@allow operator-type-mismatch\nlocal x = {} + 1\n",
        );
        assert!(all_findings(&ws).is_empty(), "{:?}", all_findings(&ws));

        // Without the directive the warning is present.
        ws.set_source("m.lua", "local x = {} + 1\n");
        assert_eq!(all_findings(&ws).len(), 1);
    }

    #[test]
    fn project_lint_level_drops_and_promotes() {
        let mut ws = Workspace::new();
        ws.set_source("m.lua", "local x = {} + 1\n");
        assert_eq!(all_findings(&ws).len(), 1);

        // `allow` silences it workspace-wide…
        ws.set_lint_levels(HashMap::from([(
            "operator-type-mismatch".to_string(),
            LintLevel::Allow,
        )]));
        assert!(all_findings(&ws).is_empty());

        // …and `deny` keeps it but promotes it to an error.
        ws.set_lint_levels(HashMap::from([(
            "operator-type-mismatch".to_string(),
            LintLevel::Deny,
        )]));
        let findings = all_findings(&ws);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].1.severity, Severity::Error);
    }

    #[test]
    fn directive_targets_only_the_named_lint() {
        let mut ws = Workspace::new();
        // Allowing param-usage-mismatch leaves the operator lint in place.
        ws.set_source(
            "m.lua",
            "---@allow param-usage-mismatch\nlocal x = {} + 1\n",
        );
        let findings = all_findings(&ws);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].1.code, "operator-type-mismatch");
    }

    #[test]
    fn warn_directive_downgrades_a_deny_by_default_lint() {
        // `param-type-mismatch` is deny (error) by default; `---@warn` over the
        // call downgrades it to a warning (rustc's `#[warn]` on a deny lint).
        let mut ws = Workspace::new();
        let src = "--- @param n number\nlocal function f(n) end\n---@warn param-type-mismatch\nf('x')\n";
        ws.set_source("m.lua", src);
        let findings = all_findings(&ws);
        assert_eq!(findings.len(), 1, "{findings:?}");
        assert_eq!(findings[0].1.code, "param-type-mismatch");
        assert_eq!(findings[0].1.severity, Severity::Warning);
    }

    #[test]
    fn expect_reports_when_the_lint_does_not_fire() {
        let mut ws = Workspace::new();
        // The statement is clean, so the expectation is unfulfilled.
        ws.set_source("m.lua", "---@expect operator-type-mismatch\nlocal x = 1\n");
        let findings = all_findings(&ws);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].1.code, codes::UNFULFILLED_EXPECTATION);

        // When the lint does fire, the expectation is met and silent.
        ws.set_source("m.lua", "---@expect operator-type-mismatch\nlocal x = {} + 1\n");
        assert!(all_findings(&ws).is_empty(), "{:?}", all_findings(&ws));
    }
}
