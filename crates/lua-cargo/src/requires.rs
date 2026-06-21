//! The require scanner (model `studio::cargolua`). Lexes Lua with
//! `dcs-lua-syntax` and walks the trivia-free token stream for module
//! references in any of Lua's `require` call forms:
//!
//! - `require("x")` / `require('x')`
//! - `require "x"` / `require 'x'` (parens-free string-literal call)
//! - `require[[x]]` / `require[=[x]=]` (long-bracket string)
//!
//! A `require` is only a module reference when it is a bare `Name` — a token
//! sequence `obj.require(...)` / `obj:require(...)` (preceded by `.`/`:`) is a
//! method call on something else and is skipped. Comments and strings can never
//! false-match: comments are trivia (never in the token stream) and a `require`
//! *inside* a string literal is a single `Str` token, not a `Name`.

use dcs_lua_syntax::lexer::lex;
use dcs_lua_syntax::token::{Token, TokenKind};

/// Scan `src` for the module names it `require`s, in source order, deduplicated
/// (first occurrence wins).
#[must_use]
pub fn scan_requires(src: &str) -> Vec<String> {
    let lexed = lex(src);
    let tokens = &lexed.tokens;
    let mut found: Vec<String> = Vec::new();

    for (i, token) in tokens.iter().enumerate() {
        if token.kind != TokenKind::Name {
            continue;
        }
        if lexeme(src, token) != "require" {
            continue;
        }
        // A method/field access (`obj.require` / `obj:require`) is not the
        // global `require`.
        if i > 0 {
            // Indexing guarded by `i > 0`.
            #[allow(clippy::indexing_slicing)]
            let prev = tokens[i - 1].kind;
            if prev == TokenKind::Dot || prev == TokenKind::Colon {
                continue;
            }
        }

        // The argument is the next significant token, with an optional opening
        // paren in between: `require("x")` vs `require "x"` / `require[[x]]`.
        let mut j = i + 1;
        if tokens.get(j).map(|t| t.kind) == Some(TokenKind::LParen) {
            j += 1;
        }
        let Some(arg) = tokens.get(j) else { continue };
        if arg.kind != TokenKind::Str {
            continue;
        }
        if let Some(name) = decode_string(lexeme(src, arg)) {
            // A require of "" is never a real module (it also catches an
            // unterminated/empty long bracket the lexer recovered) — drop it so
            // it doesn't become a spurious unresolved-require warning.
            if !name.is_empty() && !found.iter().any(|m| m == &name) {
                found.push(name);
            }
        }
    }

    found
}

/// The source slice a token spans.
fn lexeme<'a>(src: &'a str, token: &Token) -> &'a str {
    let start = token.span.start as usize;
    let end = token.span.end as usize;
    src.get(start..end).unwrap_or_default()
}

/// Decode a Lua string *literal* lexeme to its textual value, for the simple
/// module-name case (no escapes needed — module names are bare identifiers and
/// dotted paths). Handles `'..'`, `".."`, and `[[..]]` / `[=*[..]=*]` long
/// brackets. Returns `None` for anything that does not look like a closed
/// string literal.
fn decode_string(lexeme: &str) -> Option<String> {
    let bytes = lexeme.as_bytes();
    let &first = bytes.first()?;

    // Quoted: matching ' or " at both ends.
    if first == b'\'' || first == b'"' {
        if bytes.len() >= 2 && bytes.last() == Some(&first) {
            return Some(lexeme[1..lexeme.len() - 1].to_string());
        }
        return None;
    }

    // Long bracket: `[` `=`* `[` ... `]` `=`* `]`.
    if first == b'[' {
        let level = bytes
            .get(1..)
            .unwrap_or_default()
            .iter()
            .take_while(|&&b| b == b'=')
            .count();
        let open = 2 + level; // `[` + `=`*level + `[`
        if bytes.get(level + 1) != Some(&b'[') {
            return None;
        }
        let close = open + 1; // need at least the closing `]=*]`
        if bytes.len() < close + level {
            return None;
        }
        let inner_end = bytes.len() - (level + 2);
        if inner_end < open {
            return None;
        }
        let mut inner = &lexeme[open..inner_end];
        // Lua skips a first newline immediately after the opening long bracket.
        if let Some(stripped) = inner.strip_prefix('\n') {
            inner = stripped;
        } else if let Some(stripped) = inner.strip_prefix("\r\n") {
            inner = stripped;
        }
        return Some(inner.to_string());
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paren_double_quote_form() {
        assert_eq!(scan_requires(r#"local m = require("util")"#), vec!["util"]);
    }

    #[test]
    fn paren_single_quote_form() {
        assert_eq!(scan_requires("local m = require('util.sub')"), vec!["util.sub"]);
    }

    #[test]
    fn parenless_string_form() {
        assert_eq!(scan_requires("require 'util'"), vec!["util"]);
        assert_eq!(scan_requires(r#"require "util""#), vec!["util"]);
    }

    #[test]
    fn empty_or_malformed_module_name_is_dropped() {
        // An empty or unterminated long-bracket require is never a real module —
        // it must not become a spurious unresolved-require warning.
        assert!(scan_requires(r#"require("")"#).is_empty());
        assert!(scan_requires("require([[]])").is_empty());
        assert!(scan_requires("require([[a]").is_empty(), "unterminated long bracket");
    }

    #[test]
    fn long_bracket_form() {
        assert_eq!(scan_requires("require[[util]]"), vec!["util"]);
        assert_eq!(scan_requires("require[==[util.sub]==]"), vec!["util.sub"]);
    }

    #[test]
    fn method_and_field_require_are_ignored() {
        assert_eq!(scan_requires(r#"obj.require("y")"#), Vec::<String>::new());
        assert_eq!(scan_requires(r#"obj:require("y")"#), Vec::<String>::new());
        assert_eq!(scan_requires(r#"package.require("y")"#), Vec::<String>::new());
    }

    #[test]
    fn require_in_comment_is_ignored() {
        assert_eq!(
            scan_requires("-- require(\"y\")\nlocal x = 1"),
            Vec::<String>::new()
        );
        assert_eq!(
            scan_requires("--[[ require(\"y\") ]]\nlocal x = 1"),
            Vec::<String>::new()
        );
    }

    #[test]
    fn require_inside_a_string_is_ignored() {
        assert_eq!(
            scan_requires(r#"local s = "require('y')""#),
            Vec::<String>::new()
        );
    }

    #[test]
    fn multiple_requires_dedup_in_order() {
        let src = r#"
local a = require("a")
local b = require("b")
local a2 = require("a")
"#;
        assert_eq!(scan_requires(src), vec!["a", "b"]);
    }
}
