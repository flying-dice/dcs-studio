//! The analysed workspace: every mounted file with its parse.
//!
//! Per-file memoisation falls out of the shape: `set_source` re-parses
//! exactly one file; queries read the cached [`Parsed`].

use std::collections::HashMap;

use dcs_lua_syntax::ast::Parsed;

use crate::lints::LintLevel;
use dcs_lua_syntax::token::SpannedTrivia;
use dcs_lua_syntax::{lexer, parser};

/// One mounted file: its text, cached parse, and cached trivia (comments,
/// doc runs, blank-line gaps) — one lex per edit, never per query.
#[derive(Debug)]
pub struct FileEntry {
    pub source: String,
    pub parsed: Parsed,
    pub trivia: Vec<SpannedTrivia>,
}

/// A DCS Lua environment profile rule: files matching `glob` belong to
/// `profile` (SPEC.md §5). Held for the Phase-2 global graph; carried from
/// mount time so re-mounts are not needed when resolution lands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileRule {
    pub glob: String,
    pub profile: String,
}

/// Every mounted file, keyed by workspace-relative path.
#[derive(Debug, Default)]
pub struct Workspace {
    files: HashMap<String, FileEntry>,
    profile_rules: Vec<ProfileRule>,
    /// Per-lint levels set workspace-wide (the project's `[lints.lua]` table),
    /// resolved against inline directives when aggregating findings.
    lint_levels: HashMap<String, LintLevel>,
}

impl Workspace {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_profile_rules(&mut self, rules: Vec<ProfileRule>) {
        self.profile_rules = rules;
    }

    #[must_use]
    pub fn profile_rules(&self) -> &[ProfileRule] {
        &self.profile_rules
    }

    /// Set the workspace-wide lint levels (the `[lints.lua]` table); carried
    /// from mount, like the profile rules.
    pub fn set_lint_levels(&mut self, levels: HashMap<String, LintLevel>) {
        self.lint_levels = levels;
    }

    /// The workspace-wide lint levels, resolved against inline directives.
    #[must_use]
    pub fn lint_levels(&self) -> &HashMap<String, LintLevel> {
        &self.lint_levels
    }

    /// Create or replace one file; a content-identical update is a no-op.
    pub fn set_source(&mut self, path: &str, text: &str) {
        if self
            .files
            .get(path)
            .is_some_and(|entry| entry.source == text)
        {
            return;
        }
        let lexed = lexer::lex(text);
        let trivia = lexed.trivia.clone();
        let parsed = parser::parse_lexed(text, lexed);
        self.files.insert(
            path.to_string(),
            FileEntry {
                source: text.to_string(),
                parsed,
                trivia,
            },
        );
    }

    pub fn remove_source(&mut self, path: &str) {
        self.files.remove(path);
    }

    #[must_use]
    pub fn file(&self, path: &str) -> Option<&FileEntry> {
        self.files.get(path)
    }

    /// All mounted files, in arbitrary order.
    pub fn files(&self) -> impl Iterator<Item = (&str, &FileEntry)> {
        self.files
            .iter()
            .map(|(path, entry)| (path.as_str(), entry))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_source_parses_and_identical_update_is_noop() {
        let mut ws = Workspace::new();
        ws.set_source("main.lua", "local x = 1");
        let first = std::ptr::from_ref(ws.file("main.lua").unwrap());
        ws.set_source("main.lua", "local x = 1");
        assert_eq!(first, std::ptr::from_ref(ws.file("main.lua").unwrap()));
        ws.set_source("main.lua", "local x = 2");
        assert!(ws.file("main.lua").unwrap().parsed.diagnostics.is_empty());
        ws.remove_source("main.lua");
        assert!(ws.file("main.lua").is_none());
    }
}
