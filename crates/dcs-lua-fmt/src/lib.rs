//! dcs-lua-fmt — the deterministic Lua 5.1 formatter (SPEC.md §7,
//! decisions/006; model: `fmt::Fmt`).
//!
//! A printer over the `dcs-lua-syntax` lossless front-end — never a second
//! parser. Invariants (enforced here, property-tested over the corpus):
//! deterministic, idempotent, semantic-preserving (the printed text is
//! re-parsed and structurally compared before returning; on any mismatch
//! the input comes back unchanged), comment-preserving. A file that does
//! not parse cleanly returns `Err` with its diagnostics — never
//! half-formatted. WASM-safe: no I/O, threads, or clock.

mod config;
mod printer;
mod range;
mod semantics;
mod strings;

pub use config::{FormatConfig, IndentStyle, QuoteStyle, TrailingComma};
pub use dcs_lua_syntax::Span;

use dcs_lua_syntax::{Diagnostic, Severity};

/// Format whole source text (model: `fmt::Fmt.Format`).
///
/// # Errors
///
/// The parse diagnostics, when the source carries any error-severity
/// finding — the caller keeps the original text.
pub fn format(source: &str, config: &FormatConfig) -> Result<String, Vec<Diagnostic>> {
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
) -> Result<String, Vec<Diagnostic>> {
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
/// bug degrades to "input returned unchanged", never to changed runtime
/// behaviour. Loud under `debug_assertions` so tests catch it.
fn guarded(
    source: &str,
    parsed: &dcs_lua_syntax::Parsed,
    trivia: &[dcs_lua_syntax::SpannedTrivia],
    printed: String,
) -> String {
    if semantics::preserved(parsed, trivia, &printed) {
        printed
    } else {
        debug_assert!(
            false,
            "formatter semantic guard tripped; printed:\n{printed}"
        );
        source.to_string()
    }
}
