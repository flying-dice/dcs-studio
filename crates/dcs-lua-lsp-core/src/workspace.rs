//! The analysed workspace: every mounted file with its parse.
//!
//! Per-file memoisation falls out of the shape: `set_source` re-parses
//! exactly one file; queries read the cached [`Parsed`].

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;

use dcs_lua_syntax::ast::Parsed;

use crate::lints::LintLevel;
use dcs_lua_syntax::token::SpannedTrivia;
use dcs_lua_syntax::{lexer, parser};

/// One mounted file: its text, cached parse, and cached trivia (comments,
/// doc runs, blank-line gaps) — one lex per edit, never per query.
#[derive(Debug)]
pub struct FileEntry {
    /// The path EXACTLY as the host mounted it (native separators). Files are
    /// looked up separator-insensitively (see [`normalize_key`]), but this
    /// original spelling is what's returned to callers — diagnostics, go-to-def,
    /// `files()` — so the LSP-wire path/URI identity the host round-trips is
    /// preserved unchanged.
    pub path: String,
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

/// The project context `require("mod")` resolves against: the project root and
/// the vendored dependency checkouts (name → `.lua-cargo/deps/<name>`), carried
/// from mount like the profile rules and lint levels. When absent (a bare
/// workspace with no project, e.g. a unit test or the in-page lab harness),
/// require resolution and its diagnostics stay dormant — there are no search
/// roots to resolve against.
#[derive(Debug, Clone, Default)]
pub struct Resolution {
    pub root: PathBuf,
    pub vendored: BTreeMap<String, PathBuf>,
}

/// The internal LOOKUP key for a mounted file: separators canonicalised to `/`,
/// so a `require` candidate built with `/` (`module.replace('.', "/")`) matches
/// a `\`-spelled mounted path on Windows — without this a DOTTED require
/// under-resolves editor-side (issue #51 path-sep parity). This is only the
/// lookup key; the original spelling is preserved in [`FileEntry::path`] and
/// returned to callers, so the host's path/URI identity is never altered.
fn normalize_key(path: &str) -> String {
    path.replace('\\', "/")
}

/// Every mounted file, keyed by workspace-relative path.
#[derive(Debug, Default)]
pub struct Workspace {
    files: HashMap<String, FileEntry>,
    profile_rules: Vec<ProfileRule>,
    /// Per-lint levels set workspace-wide (the project's `[lints.lua]` table),
    /// resolved against inline directives when aggregating findings.
    lint_levels: HashMap<String, LintLevel>,
    /// The project context require-resolution reads (root + vendored deps);
    /// `None` until a host with a project sets it.
    resolution: Option<Resolution>,
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

    /// Set the project context require-resolution reads — the project root and
    /// the vendored dependency checkouts, carried from mount like the profile
    /// rules. The host computes these (`lua_cargo::resolve::vendored_roots`).
    pub fn set_resolution(&mut self, root: PathBuf, vendored: BTreeMap<String, PathBuf>) {
        self.resolution = Some(Resolution { root, vendored });
    }

    /// The project context for require-resolution, or `None` for a workspace
    /// with no project — where require resolution and its diagnostics are inert.
    #[must_use]
    pub fn resolution(&self) -> Option<&Resolution> {
        self.resolution.as_ref()
    }

    /// Create or replace one file; a content-identical update is a no-op.
    pub fn set_source(&mut self, path: &str, text: &str) {
        let key = normalize_key(path);
        if self
            .files
            .get(&key)
            .is_some_and(|entry| entry.source == text)
        {
            return;
        }
        let lexed = lexer::lex(text);
        let trivia = lexed.trivia.clone();
        let parsed = parser::parse_lexed(text, lexed);
        self.files.insert(
            key,
            FileEntry {
                path: path.to_string(),
                source: text.to_string(),
                parsed,
                trivia,
            },
        );
    }

    pub fn remove_source(&mut self, path: &str) {
        self.files.remove(&normalize_key(path));
    }

    #[must_use]
    pub fn file(&self, path: &str) -> Option<&FileEntry> {
        self.files.get(&normalize_key(path))
    }

    /// The ORIGINAL mounted path for a file, looked up separator-insensitively —
    /// lets a caller turn a constructed resolution candidate back into the real
    /// workspace key (preserving the host's spelling) instead of a `/`-built one.
    #[must_use]
    pub fn file_key(&self, path: &str) -> Option<&str> {
        self.files.get(&normalize_key(path)).map(|e| e.path.as_str())
    }

    /// All mounted files (their original paths), in arbitrary order.
    pub fn files(&self) -> impl Iterator<Item = (&str, &FileEntry)> {
        self.files.values().map(|entry| (entry.path.as_str(), entry))
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

    #[test]
    fn keys_are_path_separator_insensitive_but_original_spelling_is_preserved() {
        // A file mounted with backslashes (as Windows sources::collect produces)
        // is found by a forward-slash query and vice-versa — so a `/`-built
        // require candidate matches a `\`-spelled mounted key (issue #51)…
        let mut ws = Workspace::new();
        ws.set_source(r"C:\proj\src\a.lua", "local x = 1");
        assert!(ws.file("C:/proj/src/a.lua").is_some(), "found via forward slashes");
        assert!(ws.file(r"C:\proj\src\a.lua").is_some(), "found via backslashes");
        // …yet the ORIGINAL spelling is what callers get back, so the host's
        // LSP-wire path/URI identity is never rewritten.
        assert_eq!(ws.file_key("C:/proj/src/a.lua"), Some(r"C:\proj\src\a.lua"));
        assert_eq!(ws.files().next().map(|(p, _)| p), Some(r"C:\proj\src\a.lua"));
        // The same logical file across separators is one entry, not two.
        ws.set_source("C:/proj/src/a.lua", "local x = 2");
        assert_eq!(ws.files().count(), 1, "one logical file, not two");
        assert!(ws.file(r"C:\proj\src\a.lua").unwrap().parsed.diagnostics.is_empty());
    }
}
