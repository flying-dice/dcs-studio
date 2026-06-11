//! Property tests: lexer and parser are total — any input terminates with
//! a well-formed result, never a panic.

use dcs_lua_syntax::lexer::lex;
use dcs_lua_syntax::parser::parse;
use dcs_lua_syntax::token::TokenKind;
use proptest::prelude::*;

proptest! {
    #[test]
    fn lexing_any_string_terminates_in_order(src in ".*") {
        let lexed = lex(&src);
        let last = lexed.tokens.last().expect("eof token always present");
        prop_assert_eq!(last.kind, TokenKind::Eof);
        let mut previous_end = 0u32;
        for token in &lexed.tokens {
            prop_assert!(token.span.start >= previous_end, "tokens out of order");
            prop_assert!(token.span.end <= src.len() as u32, "span out of bounds");
            prop_assert!(token.span.start <= token.span.end);
            previous_end = token.span.end;
        }
    }

    #[test]
    fn lexing_lua_ish_soup_never_panics(src in "[-\\[\\]=\"'a-z0-9 \\n.~]{0,64}") {
        let _ = lex(&src);
    }

    #[test]
    fn parsing_any_string_yields_a_tree(src in ".*") {
        let parsed = parse(&src);
        // A tree always comes back; the chunk's block exists in the arena.
        let _ = parsed.ast.block(parsed.chunk.body);
    }

    #[test]
    fn parsing_lua_ish_soup_never_panics(
        src in "(local|function|if|then|end|do|while|return|[a-z]|[0-9]|[=,.;:(){}\\[\\]\"'\\n ]){0,80}"
    ) {
        let _ = parse(&src);
    }
}
