//! Formatter property gates (SPEC.md §7): across the conformance corpus,
//! the real-world `testdata/` corpus (MIST + TSTL), and a set of
//! adversarial inputs, formatting must be idempotent, semantic-preserving
//! (enforced by the in-crate guard, whose trip is signalled via
//! `Formatted::guard_tripped` and asserted false here), and
//! comment-preserving — inside a time budget, like the parser's corpus
//! gate.

use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use dcs_lua_fmt::FormatConfig;
use dcs_lua_syntax::Trivia;

/// Generous for debug builds; catches hangs and quadratic blowups.
const BUDGET: Duration = Duration::from_secs(30);

fn repo_dir(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../").join(name)
}

fn corpus_sources() -> Vec<(String, String)> {
    let mut sources = Vec::new();
    for dir in [repo_dir("testdata"), repo_dir("CONFORMANCE/format")] {
        for entry in fs::read_dir(&dir).unwrap_or_else(|e| panic!("{}: {e}", dir.display())) {
            let path = entry.expect("dir entry").path();
            if path.extension().is_none_or(|e| e != "lua") {
                continue;
            }
            let text = fs::read_to_string(&path).expect("corpus file is UTF-8");
            sources.push((path.display().to_string(), text));
        }
    }
    assert!(sources.len() > 2, "corpus missing");
    sources
}

fn comment_texts(source: &str) -> Vec<String> {
    dcs_lua_syntax::lexer::lex(source)
        .trivia
        .into_iter()
        .filter_map(|t| match t.trivia {
            Trivia::LineComment { text }
            | Trivia::LongComment { text }
            | Trivia::DocComment { text } => Some(text),
            Trivia::BlankLines { .. } => None,
        })
        .collect()
}

#[test]
fn corpus_formats_idempotently_within_budget() {
    let config = FormatConfig::default();
    for (path, source) in corpus_sources() {
        let started = Instant::now();
        let once = dcs_lua_fmt::format(&source, &config)
            .unwrap_or_else(|d| panic!("{path}: corpus file must format: {d:?}"));
        assert!(!once.guard_tripped, "{path}: semantic guard tripped");
        let twice = dcs_lua_fmt::format(&once.text, &config)
            .unwrap_or_else(|d| panic!("{path}: formatted output must re-format: {d:?}"));
        assert!(!twice.guard_tripped, "{path}: guard tripped on re-format");
        let elapsed = started.elapsed();
        assert!(
            elapsed < BUDGET,
            "{path} took {elapsed:?} (budget {BUDGET:?})"
        );
        assert_eq!(once.text, twice.text, "{path}: formatting is not idempotent");
    }
}

/// Comment survival, stated independently of the in-crate guard: every
/// comment's text reappears in the output's trivia. (Two line comments
/// can merge when one moves to a line's end, so multiset equality is the
/// strongest portable claim — the in-crate guard pins the same multiset.)
#[test]
fn corpus_preserves_comment_texts() {
    let config = FormatConfig::default();
    for (path, source) in corpus_sources() {
        let formatted = dcs_lua_fmt::format(&source, &config)
            .unwrap_or_else(|d| panic!("{path}: corpus file must format: {d:?}"));
        assert!(!formatted.guard_tripped, "{path}: semantic guard tripped");
        let mut before = comment_texts(&source);
        let mut after = comment_texts(&formatted.text);
        before.sort_unstable();
        after.sort_unstable();
        assert_eq!(before, after, "{path}: comments did not survive");
    }
}

/// Token-level restatement of semantic preservation: the output's
/// non-trivia token stream matches the input's modulo the documented
/// tree-neutral normalisations (SPEC.md §7) — `;` statement separators
/// dropped, table `;` separators and call sugar normalised, trailing
/// commas adjusted, strings requoted. Token *kinds* other than
/// Semi/Comma/LParen/RParen must appear in the same order with equal
/// lexemes (strings by decoded value via the parse-tree guard inside
/// `format`; here spellings of names/numbers/keywords are pinned).
#[test]
fn corpus_preserves_significant_tokens() {
    use dcs_lua_syntax::TokenKind;
    let config = FormatConfig::default();
    let significant = |source: &str| -> Vec<(TokenKind, String)> {
        let lexed = dcs_lua_syntax::lexer::lex(source);
        lexed
            .tokens
            .iter()
            .filter(|t| {
                !matches!(
                    t.kind,
                    TokenKind::Semi
                        | TokenKind::Comma
                        | TokenKind::LParen
                        | TokenKind::RParen
                        | TokenKind::Str
                        | TokenKind::Eof
                )
            })
            .map(|t| {
                (
                    t.kind,
                    source[t.span.start as usize..t.span.end as usize].to_string(),
                )
            })
            .collect()
    };
    for (path, source) in corpus_sources() {
        let formatted = dcs_lua_fmt::format(&source, &config)
            .unwrap_or_else(|d| panic!("{path}: corpus file must format: {d:?}"));
        assert_eq!(
            significant(&source),
            significant(&formatted.text),
            "{path}: significant token stream changed"
        );
    }
}

#[test]
fn adversarial_inputs_never_panic_and_stay_lawful() {
    let config = FormatConfig::default();
    let inputs: &[&str] = &[
        "",
        "\n",
        "x",
        ";",
        ";;;",
        "x = 1",
        "-- only a comment",
        "--[[unterminated",
        "local s = 'mixed \"quotes\\' here'",
        "local a = 1\r\nlocal b = 2\r\n",
        "local a = 1\nlocal b = 2\r\n",
        "f(--[[inline]] 1, --weird\n2)",
        "x = - -1",
        "return",
        "local t = {}",
        "local t = { [\"k\"] = { nested = { 1, 2, { 3 } } } }",
        "while true do break end",
        "a = [==[\nlong\n]==]",
        "x = 1 --[[a]] --[[b]] --c",
        "local x = f\n;(g or h)()",
        "(f or g)()",
        "do\n(f or g)()\nend",
        "t = { [ [[s]] ] = 1 }",
        "a = b[ [[s]] ]",
        "s = 'h\u{e9}llo'",
    ];
    for input in inputs {
        match dcs_lua_fmt::format(input, &config) {
            Ok(once) => {
                assert!(!once.guard_tripped, "{input:?}: semantic guard tripped");
                let twice = dcs_lua_fmt::format(&once.text, &config)
                    .unwrap_or_else(|d| panic!("{input:?}: output must re-format: {d:?}"));
                assert_eq!(once.text, twice.text, "{input:?}: not idempotent");
            }
            Err(diagnostics) => {
                assert!(
                    !diagnostics.is_empty(),
                    "{input:?}: Err must carry diagnostics"
                );
            }
        }
    }
}

/// BUG fix pin (PUC validity): the `;` statement-merge guard may only
/// follow a statement — Lua 5.1's `chunk ::= {stat [';']}` rejects a
/// block-start `;` — so it is suppressed for a block's first statement
/// and kept mid-block.
#[test]
fn paren_statement_semi_only_after_a_statement() {
    let config = FormatConfig::default();
    let formatted = dcs_lua_fmt::format("(f or g)()", &config).expect("formats");
    assert!(!formatted.guard_tripped);
    assert_eq!(formatted.text, "(f or g)()\n");

    let formatted =
        dcs_lua_fmt::format("do\n(f or g)()\nlocal h = f;\n(h or g)()\nend\n", &config)
            .expect("formats");
    assert!(!formatted.guard_tripped);
    assert_eq!(
        formatted.text,
        "do\n    (f or g)()\n    local h = f\n    ;(h or g)()\nend\n"
    );
}

/// BUG fix pin: a long-bracket string as table key or index operand keeps
/// one space inside the brackets — `[[[s]]]` would lex as a long-bracket
/// opener.
#[test]
fn long_bracket_keys_keep_their_padding() {
    let config = FormatConfig::default();
    let formatted = dcs_lua_fmt::format("t = { [ [[s]] ] = 1 }", &config).expect("formats");
    assert!(!formatted.guard_tripped);
    assert_eq!(formatted.text, "t = { [ [[s]] ] = 1 }\n");

    let formatted = dcs_lua_fmt::format("a = b[ [[s]] ]", &config).expect("formats");
    assert!(!formatted.guard_tripped);
    assert_eq!(formatted.text, "a = b[ [[s]] ]\n");
}

/// BUG fix pin: requoting must not mangle non-ASCII content (UTF-8 is
/// multi-byte; the swap edits are ASCII-only).
#[test]
fn non_ascii_strings_requote_without_mojibake() {
    let config = FormatConfig::default();
    let formatted =
        dcs_lua_fmt::format("s = 'h\u{e9}llo'\nt = 'd\u{f6}n\\'t \u{2014} ok'\n", &config)
            .expect("formats");
    assert!(!formatted.guard_tripped);
    assert_eq!(
        formatted.text,
        "s = \"h\u{e9}llo\"\nt = \"d\u{f6}n't \u{2014} ok\"\n"
    );
}

#[test]
fn crlf_sources_keep_crlf_endings() {
    let config = FormatConfig::default();
    let formatted = dcs_lua_fmt::format("local a=1\r\nlocal b=2\r\n", &config).expect("formats");
    assert_eq!(formatted.text, "local a = 1\r\nlocal b = 2\r\n");
}

#[test]
fn unparseable_source_returns_diagnostics() {
    let config = FormatConfig::default();
    let result = dcs_lua_fmt::format("function f(\nlocal x = 1", &config);
    let diagnostics = result.expect_err("syntax error must fail formatting");
    assert!(diagnostics.iter().any(|d| d.code.starts_with("LUA-E")));
}

#[test]
fn format_range_touches_only_the_run() {
    use dcs_lua_fmt::Span;
    let config = FormatConfig::default();
    let source = "local untouched   =   1\nfunction f()\nlocal x=1\nreturn x\nend\nlocal also   =   2\n";
    // Range inside the function body: the `local x=1` line.
    let start = source.find("local x").expect("marker") as u32;
    let formatted =
        dcs_lua_fmt::format_range(source, Span::new(start, start + 4), &config).expect("formats");
    assert!(!formatted.guard_tripped);
    let formatted = formatted.text;
    assert!(
        formatted.starts_with("local untouched   =   1\n"),
        "prefix must stay byte-identical:\n{formatted}"
    );
    assert!(
        formatted.ends_with("local also   =   2\n"),
        "suffix must stay byte-identical:\n{formatted}"
    );
    assert!(
        formatted.contains("\n    local x = 1\n"),
        "the run formats at its block depth:\n{formatted}"
    );
    // The sibling statement in the same block run is not part of the range.
    assert!(formatted.contains("\nreturn x\n"), "{formatted}");
}

#[test]
fn format_range_in_whitespace_changes_nothing() {
    use dcs_lua_fmt::Span;
    let config = FormatConfig::default();
    let source = "local a=1\n\n\nlocal b=2\n";
    let gap = source.find("\n\n").expect("gap") as u32 + 1;
    let formatted =
        dcs_lua_fmt::format_range(source, Span::new(gap, gap), &config).expect("formats");
    assert_eq!(formatted.text, source);
}

/// BUG fix pin: the splice start must widen below a block comment that
/// straddles the line boundary — splitting it would amputate its tail.
#[test]
fn format_range_widens_below_a_straddling_block_comment() {
    use dcs_lua_fmt::Span;
    let config = FormatConfig::default();
    let source = "--[[x\ny]] a=1\n";
    let start = source.find("a=1").expect("marker") as u32;
    let formatted =
        dcs_lua_fmt::format_range(source, Span::new(start, start + 3), &config).expect("formats");
    assert!(!formatted.guard_tripped, "guard must not trip:\n{}", formatted.text);
    assert!(
        formatted.text.contains("--[[x\ny]]"),
        "the comment must survive whole:\n{}",
        formatted.text
    );
    assert!(formatted.text.contains("a = 1"), "{}", formatted.text);
}

/// SF fix pin: the splice end must widen over a following statement on the
/// same line — the untouched suffix must never share a line with the
/// formatted run.
#[test]
fn format_range_end_does_not_merge_with_the_suffix() {
    use dcs_lua_fmt::Span;
    let config = FormatConfig::default();
    let source = "a=1 b=2\nc=3\n";
    let formatted =
        dcs_lua_fmt::format_range(source, Span::new(0, 3), &config).expect("formats");
    assert!(!formatted.guard_tripped);
    assert_eq!(
        formatted.text, "a = 1\nb = 2\nc=3\n",
        "the same-line sibling joins the run; the next line stays untouched"
    );
}

#[test]
fn quote_and_indent_config_are_honoured() {
    let config = FormatConfig {
        indent_width: 2,
        quote_style: dcs_lua_fmt::QuoteStyle::Single,
        ..FormatConfig::default()
    };
    let formatted =
        dcs_lua_fmt::format("if x then y = \"v\" end", &config).expect("formats");
    assert_eq!(formatted.text, "if x then\n  y = 'v'\nend\n");
}

#[test]
fn trailing_comma_never_is_honoured() {
    let config = FormatConfig {
        trailing_comma: dcs_lua_fmt::TrailingComma::Never,
        ..FormatConfig::default()
    };
    let formatted = dcs_lua_fmt::format("t = {\n1,\n2,\n}", &config).expect("formats");
    assert_eq!(formatted.text, "t = {\n    1,\n    2\n}\n");
}

/// NIT fix pin: `max_width` has a floor (SPEC.md §7: values below 20 clamp
/// to 20) — a degenerate budget must not break every construct.
#[test]
fn max_width_clamps_to_a_floor() {
    let config = FormatConfig {
        max_width: 0,
        ..FormatConfig::default()
    };
    let formatted = dcs_lua_fmt::format("t = { 1 }", &config).expect("formats");
    assert_eq!(
        formatted.text, "t = { 1 }\n",
        "a 9-column line fits the clamped 20-column budget"
    );
}
