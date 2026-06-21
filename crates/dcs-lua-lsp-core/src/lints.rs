//! Lint levels and inline level directives — the rustc/clippy idiom in Lua.
//!
//! Each type lint (`operator-type-mismatch`, …) carries a level —
//! `allow`/`warn`/`deny`/`forbid`, exactly like rustc. A level is resolved
//! three ways, innermost winning: an inline directive (`---@allow`, `---@warn`,
//! `---@deny`, `---@expect`) covering the following statement — the analog of a
//! Rust attribute on an item — then the project's `[lints.lua]` table, then the
//! lint's built-in default. A `forbid` set in the project cannot be downgraded
//! inline. `---@expect` silences the lint but, when it never fires in the
//! covered statement, raises `unfulfilled-lint-expectation` — rustc's
//! self-cleaning expectation. Lua has no attribute syntax, so the directive is
//! a `---` doc comment placed above the statement it governs.

use std::collections::HashMap;
use std::hash::BuildHasher;

use dcs_lua_syntax::ast::Ast;
use dcs_lua_syntax::diagnostic::codes;
use dcs_lua_syntax::span::Span;
use dcs_lua_syntax::token::Trivia;

use crate::workspace::FileEntry;

/// A lint level — rustc's ladder.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LintLevel {
    Allow,
    Warn,
    Deny,
    Forbid,
}

impl LintLevel {
    /// Parse a `[lints.lua]` / directive level word.
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "allow" => Some(Self::Allow),
            "warn" => Some(Self::Warn),
            "deny" => Some(Self::Deny),
            "forbid" => Some(Self::Forbid),
            _ => None,
        }
    }
}

/// Every levelled lint and its built-in default. The type lints plus the
/// require-resolution lints — both `unresolved-require` and `require-shadowing`
/// default to `warn`: a host/DCS built-in legitimately resolves to nothing, so
/// they must never hard-error unless a project opts in (`deny`/`forbid`).
const LINTS: &[(&str, LintLevel)] = &[
    (codes::ARGUMENT_TYPE_MISMATCH, LintLevel::Deny),
    (codes::OPERATOR_TYPE_MISMATCH, LintLevel::Warn),
    (codes::ARGUMENT_USAGE_MISMATCH, LintLevel::Warn),
    (codes::UNRESOLVED_REQUIRE, LintLevel::Warn),
    (codes::REQUIRE_SHADOWING, LintLevel::Warn),
];

/// Parse a `[lints.lua]` string map (`name -> "level"`) into resolved levels,
/// dropping entries whose level word is unrecognised.
#[must_use]
pub fn levels_from_strings<S: BuildHasher>(
    map: &HashMap<String, String, S>,
) -> HashMap<String, LintLevel> {
    map.iter()
        .filter_map(|(name, level)| LintLevel::parse(level).map(|level| (name.clone(), level)))
        .collect()
}

/// The built-in default level for `code`, or `None` when it is not a levelled
/// lint (parse errors, the expectation diagnostic itself).
#[must_use]
pub fn default_level(code: &str) -> Option<LintLevel> {
    LINTS
        .iter()
        .find(|(name, _)| *name == code)
        .map(|(_, level)| *level)
}

enum DirectiveKind {
    Level(LintLevel),
    Expect,
}

struct Directive {
    /// The statement span the directive governs (its Rust-attribute scope).
    scope: Span,
    /// The directive comment's own span — where an unfulfilled `expect` reports.
    marker: Span,
    kind: DirectiveKind,
    codes: Vec<String>,
}

impl Directive {
    fn covers(&self, offset: u32, code: &str) -> bool {
        self.scope.start <= offset
            && offset < self.scope.end
            && self.codes.iter().any(|c| c == code)
    }
}

/// The inline level directives of one file, resolved against a project's
/// `[lints.lua]` levels.
pub struct Resolver {
    directives: Vec<Directive>,
}

impl Resolver {
    /// Parse every `---@allow`/`warn`/`deny`/`forbid`/`expect` directive in
    /// `entry`, attaching each to the statement that follows it.
    #[must_use]
    pub fn parse(entry: &FileEntry) -> Self {
        let ast = &entry.parsed.ast;
        let mut directives = Vec::new();
        for spanned in &entry.trivia {
            let Trivia::DocComment { text } = &spanned.trivia else {
                continue;
            };
            let Some((kind, codes)) = parse_directive(text) else {
                continue;
            };
            // The governed statement is the next one to begin after the comment
            // (a function's whole body, an assignment's line — its full span).
            let Some(scope) = next_statement_span(ast, spanned.span.end) else {
                continue;
            };
            directives.push(Directive { scope, marker: spanned.span, kind, codes });
        }
        Self { directives }
    }

    /// The effective level for a finding of `code` at byte `offset`:
    /// `forbid` from the project pins it, else the innermost inline directive,
    /// else the project level, else the built-in default.
    #[must_use]
    pub fn level(&self, offset: u32, code: &str, project: &HashMap<String, LintLevel>) -> LintLevel {
        if project.get(code) == Some(&LintLevel::Forbid) {
            return LintLevel::Forbid;
        }
        if let Some(level) = self.inline_level(offset, code) {
            return level;
        }
        project
            .get(code)
            .copied()
            .or_else(|| default_level(code))
            .unwrap_or(LintLevel::Warn)
    }

    /// The innermost inline directive covering `offset` for `code` (an
    /// `expect` reads as `allow`). Smallest scope wins, so a directive on an
    /// inner statement overrides one on the enclosing function.
    fn inline_level(&self, offset: u32, code: &str) -> Option<LintLevel> {
        self.directives
            .iter()
            .filter(|directive| directive.covers(offset, code))
            .min_by_key(|directive| directive.scope.end - directive.scope.start)
            .map(|directive| match directive.kind {
                DirectiveKind::Level(level) => level,
                DirectiveKind::Expect => LintLevel::Allow,
            })
    }

    /// For every `---@expect` whose named lint did not fire in its scope, the
    /// directive's marker span and the unfulfilled lint name. `fired` is the
    /// `(offset, code)` of the findings that actually exist this pass.
    #[must_use]
    pub fn unfulfilled(&self, fired: &[(u32, &str)]) -> Vec<(Span, String)> {
        let mut out = Vec::new();
        for directive in &self.directives {
            if !matches!(directive.kind, DirectiveKind::Expect) {
                continue;
            }
            for code in &directive.codes {
                let fired_here = fired.iter().any(|(offset, fired_code)| {
                    fired_code == code
                        && directive.scope.start <= *offset
                        && *offset < directive.scope.end
                });
                if !fired_here {
                    out.push((directive.marker, code.clone()));
                }
            }
        }
        out
    }
}

/// Parse one doc-comment's text (marker stripped) into a level directive.
fn parse_directive(text: &str) -> Option<(DirectiveKind, Vec<String>)> {
    let rest = text.trim_start().strip_prefix('@')?;
    let (verb, args) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
    let kind = match verb {
        "allow" => DirectiveKind::Level(LintLevel::Allow),
        "warn" => DirectiveKind::Level(LintLevel::Warn),
        "deny" => DirectiveKind::Level(LintLevel::Deny),
        "forbid" => DirectiveKind::Level(LintLevel::Forbid),
        "expect" => DirectiveKind::Expect,
        _ => return None,
    };
    // Lint names, comma- or whitespace-separated (`---@allow a, b`). Rust
    // requires at least one name; a bare verb is not a directive.
    let codes: Vec<String> = args
        .split([',', ' ', '\t'])
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .collect();
    (!codes.is_empty()).then_some((kind, codes))
}

/// The span of the first statement to begin at or after `offset` — the
/// statement an attribute-style directive above it governs.
fn next_statement_span(ast: &Ast, offset: u32) -> Option<Span> {
    ast.stats
        .iter()
        .filter(|stat| stat.span.start >= offset)
        .min_by_key(|stat| stat.span.start)
        .map(|stat| stat.span)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::Workspace;

    fn resolver(src: &str) -> (Workspace, Resolver) {
        let mut ws = Workspace::new();
        ws.set_source("m.lua", src);
        let resolver = Resolver::parse(ws.file("m.lua").unwrap());
        (ws, resolver)
    }

    fn empty() -> HashMap<String, LintLevel> {
        HashMap::new()
    }

    /// The byte offset of `needle` in `src` (the finding's span start).
    fn at(src: &str, needle: &str) -> u32 {
        src.find(needle).expect("needle present") as u32
    }

    #[test]
    fn default_levels_match_built_ins() {
        assert_eq!(default_level("param-type-mismatch"), Some(LintLevel::Deny));
        assert_eq!(default_level("operator-type-mismatch"), Some(LintLevel::Warn));
        assert_eq!(default_level("LUA-E101"), None);
    }

    #[test]
    fn allow_directive_governs_the_next_statement() {
        let src = "---@allow operator-type-mismatch\nlocal x = {} + 1\n";
        let (_ws, resolver) = resolver(src);
        let offset = at(src, "{}");
        assert_eq!(
            resolver.level(offset, "operator-type-mismatch", &empty()),
            LintLevel::Allow
        );
        // A different lint at that offset keeps its default.
        assert_eq!(
            resolver.level(offset, "param-usage-mismatch", &empty()),
            LintLevel::Warn
        );
    }

    #[test]
    fn allow_on_a_function_covers_its_whole_body() {
        let src = "---@allow operator-type-mismatch\nlocal function f()\n  return {} + 1\nend\n";
        let (_ws, resolver) = resolver(src);
        // The `{} + 1` is deep in the function body, still covered.
        let offset = at(src, "{}");
        assert_eq!(
            resolver.level(offset, "operator-type-mismatch", &empty()),
            LintLevel::Allow
        );
    }

    #[test]
    fn deny_directive_promotes_to_error_level() {
        let src = "---@deny operator-type-mismatch\nlocal x = {} + 1\n";
        let (_ws, resolver) = resolver(src);
        assert_eq!(
            resolver.level(at(src, "{}"), "operator-type-mismatch", &empty()),
            LintLevel::Deny
        );
    }

    #[test]
    fn project_level_applies_without_a_directive() {
        let src = "local x = {} + 1\n";
        let (_ws, resolver) = resolver(src);
        let project = HashMap::from([("operator-type-mismatch".to_string(), LintLevel::Allow)]);
        assert_eq!(
            resolver.level(at(src, "{}"), "operator-type-mismatch", &project),
            LintLevel::Allow
        );
    }

    #[test]
    fn project_forbid_cannot_be_downgraded_inline() {
        let src = "---@allow operator-type-mismatch\nlocal x = {} + 1\n";
        let (_ws, resolver) = resolver(src);
        let project = HashMap::from([("operator-type-mismatch".to_string(), LintLevel::Forbid)]);
        assert_eq!(
            resolver.level(at(src, "{}"), "operator-type-mismatch", &project),
            LintLevel::Forbid
        );
    }

    #[test]
    fn inline_directive_overrides_project_level() {
        let src = "---@deny operator-type-mismatch\nlocal x = {} + 1\n";
        let (_ws, resolver) = resolver(src);
        let project = HashMap::from([("operator-type-mismatch".to_string(), LintLevel::Allow)]);
        assert_eq!(
            resolver.level(at(src, "{}"), "operator-type-mismatch", &project),
            LintLevel::Deny
        );
    }

    #[test]
    fn expect_reads_as_allow_and_tracks_fulfillment() {
        let src = "---@expect operator-type-mismatch\nlocal x = {} + 1\n";
        let (_ws, resolver) = resolver(src);
        let offset = at(src, "{}");
        assert_eq!(
            resolver.level(offset, "operator-type-mismatch", &empty()),
            LintLevel::Allow
        );
        // Fired → fulfilled (no unfulfilled report).
        assert!(resolver.unfulfilled(&[(offset, "operator-type-mismatch")]).is_empty());
        // Not fired → one unfulfilled report.
        let unfulfilled = resolver.unfulfilled(&[]);
        assert_eq!(unfulfilled.len(), 1);
        assert_eq!(unfulfilled[0].1, "operator-type-mismatch");
    }

    #[test]
    fn non_directive_doc_comments_are_ignored() {
        let (_ws, resolver) = resolver("--- @param x number\nlocal x = 1\n");
        assert!(resolver.directives.is_empty());
    }

    #[test]
    fn multiple_codes_in_one_directive() {
        let src = "---@allow operator-type-mismatch, param-usage-mismatch\nlocal x = 1\n";
        let (_ws, resolver) = resolver(src);
        let offset = at(src, "local x");
        assert_eq!(resolver.level(offset, "operator-type-mismatch", &empty()), LintLevel::Allow);
        assert_eq!(resolver.level(offset, "param-usage-mismatch", &empty()), LintLevel::Allow);
    }
}
