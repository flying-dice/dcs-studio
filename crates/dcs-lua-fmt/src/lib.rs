//! dcs-lua-fmt — the deterministic Lua 5.1 formatter (SPEC.md §7,
//! decisions/006; model: `fmt::Fmt`).
//!
//! A printer over the `dcs-lua-syntax` lossless front-end — never a second
//! parser. Invariants (enforced here, property-tested over the corpus):
//! deterministic, idempotent, semantic-preserving (the printed text is
//! re-parsed and structurally compared before returning; on any mismatch
//! the input comes back unchanged with [`Formatted::guard_tripped`]
//! raised — signalled, never aborted), comment-preserving. A file that
//! does not parse cleanly returns `Err` with its diagnostics — never
//! half-formatted. WASM-safe: no I/O, threads, or clock.

mod config;
mod printer;
mod range;
mod semantics;
mod strings;

pub use config::{FormatConfig, IndentStyle, MIN_WIDTH, QuoteStyle, TrailingComma};
pub use dcs_lua_syntax::Span;

use dcs_lua_syntax::{Diagnostic, Severity};

/// A successful formatting outcome (model: `fmt::Formatted`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Formatted {
    /// The text to use: the formatted output — or the input returned
    /// unchanged when the semantic guard tripped.
    pub text: String,
    /// Raised when the semantic guard (model: `fmt::Fmt.PreservesSemantics`)
    /// rejected the printed text and `text` is the input unchanged. Always
    /// a formatter bug — callers should surface it loudly, but must keep
    /// going: a guard trip degrades to "file left unchanged", never to an
    /// abort (decisions/006).
    pub guard_tripped: bool,
}

/// Format whole source text (model: `fmt::Fmt.Format`).
///
/// # Errors
///
/// The parse diagnostics, when the source carries any error-severity
/// finding — the caller keeps the original text.
pub fn format(source: &str, config: &FormatConfig) -> Result<Formatted, Vec<Diagnostic>> {
    let lexed = dcs_lua_syntax::lexer::lex(source);
    let trivia = lexed.trivia.clone();
    let parsed = dcs_lua_syntax::parser::parse_lexed(source, lexed);
    if has_errors(&parsed.diagnostics) {
        return Err(parsed.diagnostics);
    }
    let printed = printer::print(source, &parsed, &trivia, config);
    Ok(guarded(source, &parsed, &trivia, printed))
}

/// Format the smallest run of whole statements enclosing `range`, leaving
/// every byte outside the run untouched (model: `fmt::Fmt.FormatRange`).
///
/// # Errors
///
/// The parse diagnostics, when the source carries any error-severity
/// finding — the caller keeps the original text.
pub fn format_range(
    source: &str,
    range: Span,
    config: &FormatConfig,
) -> Result<Formatted, Vec<Diagnostic>> {
    let lexed = dcs_lua_syntax::lexer::lex(source);
    let trivia = lexed.trivia.clone();
    let parsed = dcs_lua_syntax::parser::parse_lexed(source, lexed);
    if has_errors(&parsed.diagnostics) {
        return Err(parsed.diagnostics);
    }
    let printed = range::format_range(source, &parsed, &trivia, range, config);
    Ok(guarded(source, &parsed, &trivia, printed))
}

fn has_errors(diagnostics: &[Diagnostic]) -> bool {
    diagnostics.iter().any(|d| d.severity == Severity::Error)
}

/// The semantic guard (model: `fmt::Fmt.PreservesSemantics`): a printer
/// bug degrades to "input returned unchanged" with `guard_tripped` raised
/// — never to changed runtime behaviour, and never to an abort
/// (decisions/006; the corpus property tests assert the flag stays false).
fn guarded(
    source: &str,
    parsed: &dcs_lua_syntax::Parsed,
    trivia: &[dcs_lua_syntax::SpannedTrivia],
    printed: String,
) -> Formatted {
    if semantics::preserved(parsed, trivia, &printed) {
        Formatted {
            text: printed,
            guard_tripped: false,
        }
    } else {
        Formatted {
            text: source.to_string(),
            guard_tripped: true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn guard(source: &str, printed: &str) -> Formatted {
        let lexed = dcs_lua_syntax::lexer::lex(source);
        let trivia = lexed.trivia.clone();
        let parsed = dcs_lua_syntax::parser::parse_lexed(source, lexed);
        guarded(source, &parsed, &trivia, printed.to_string())
    }

    #[test]
    fn guard_trip_returns_input_and_signals() {
        let out = guard("local a = 1\n", "local a = 2\n");
        assert!(out.guard_tripped, "changed tree must trip the guard");
        assert_eq!(out.text, "local a = 1\n", "input must come back unchanged");
    }

    #[test]
    fn guard_pins_comment_texts_not_just_count() {
        // Same comment count, different text: the multiset comparison
        // must trip where a bare count would pass.
        let out = guard("-- alpha\nlocal a = 1\n", "-- beta\nlocal a = 1\n");
        assert!(out.guard_tripped, "mutated comment text must trip the guard");
        assert_eq!(out.text, "-- alpha\nlocal a = 1\n");
    }

    #[test]
    fn faithful_print_does_not_trip() {
        let out = guard("-- note\nlocal a = 1\n", "-- note\nlocal a = 1\n");
        assert!(!out.guard_tripped);
        assert_eq!(out.text, "-- note\nlocal a = 1\n");
    }
}
