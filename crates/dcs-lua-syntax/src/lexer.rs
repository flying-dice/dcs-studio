//! Hand-written one-pass Lua 5.1 lexer (SPEC.md §2, decisions/001).
//!
//! One pass yields two surfaces: the trivia-free token stream and
//! full-fidelity trivia (comments, `---` doc runs, blank-line gaps).
//! Infallible: anomalies surface as `LUA-E0xx` diagnostics, never a failed
//! lex, and the scan always reaches end of input.

use crate::diagnostic::{Diagnostic, codes};
use crate::span::{LineIndex, Span};
use crate::token::{Lexed, SpannedTrivia, Token, TokenKind, Trivia};

/// Lex `src` into tokens, trivia, and lexical diagnostics.
#[must_use]
pub fn lex(src: &str) -> Lexed {
    Lexer::new(src).run()
}

/// Render the conformance token stream: one `KIND@line:col "lexeme"` line
/// per token, the final `Eof` included, positions 1-based with byte
/// columns (CONFORMANCE/lexical/README.md).
#[must_use]
pub fn render_tokens(src: &str) -> String {
    use std::fmt::Write as _;

    let lexed = lex(src);
    let index = LineIndex::new(src);
    let mut out = String::new();
    for token in &lexed.tokens {
        let (line, col) = index.line_col(token.span.start);
        let lexeme = &src[token.span.start as usize..token.span.end as usize];
        let _ = writeln!(
            out,
            "{}@{line}:{col} \"{}\"",
            token.kind.golden_name(),
            escape_lexeme(lexeme)
        );
    }
    out
}

fn escape_lexeme(lexeme: &str) -> String {
    lexeme.replace('\\', "\\\\").replace('"', "\\\"")
}

struct Lexer<'src> {
    src: &'src str,
    bytes: &'src [u8],
    pos: usize,
    tokens: Vec<Token>,
    trivia: Vec<SpannedTrivia>,
    diagnostics: Vec<Diagnostic>,
}

impl<'src> Lexer<'src> {
    fn new(src: &'src str) -> Self {
        Self {
            src,
            bytes: src.as_bytes(),
            pos: 0,
            tokens: Vec::new(),
            trivia: Vec::new(),
            diagnostics: Vec::new(),
        }
    }

    fn run(mut self) -> Lexed {
        loop {
            self.skip_whitespace();
            let Some(byte) = self.peek() else { break };
            let start = self.pos;
            match byte {
                b'-' => self.dash(start),
                b'"' | b'\'' => self.short_string(start, byte),
                b'[' => self.bracket(start),
                b'0'..=b'9' => self.number(start),
                b'.' => self.dot(start),
                b'A'..=b'Z' | b'a'..=b'z' | b'_' => self.ident(start),
                b'=' => self.one_or_two(start, b'=', TokenKind::Eq, TokenKind::EqEq),
                b'<' => self.one_or_two(start, b'=', TokenKind::Lt, TokenKind::Le),
                b'>' => self.one_or_two(start, b'=', TokenKind::Gt, TokenKind::Ge),
                b'~' => self.tilde(start),
                b'+' => self.single(start, TokenKind::Plus),
                b'*' => self.single(start, TokenKind::Star),
                b'/' => self.single(start, TokenKind::Slash),
                b'%' => self.single(start, TokenKind::Percent),
                b'^' => self.single(start, TokenKind::Caret),
                b'#' => self.single(start, TokenKind::Hash),
                b'(' => self.single(start, TokenKind::LParen),
                b')' => self.single(start, TokenKind::RParen),
                b'{' => self.single(start, TokenKind::LBrace),
                b'}' => self.single(start, TokenKind::RBrace),
                b']' => self.single(start, TokenKind::RBracket),
                b';' => self.single(start, TokenKind::Semi),
                b':' => self.single(start, TokenKind::Colon),
                b',' => self.single(start, TokenKind::Comma),
                _ => self.error_run(start),
            }
        }
        let end = self.pos as u32;
        self.tokens.push(Token {
            kind: TokenKind::Eof,
            span: Span::empty(end),
        });
        Lexed {
            tokens: self.tokens,
            trivia: self.trivia,
            diagnostics: self.diagnostics,
        }
    }

    // ---- cursor primitives -------------------------------------------------

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn peek_at(&self, ahead: usize) -> Option<u8> {
        self.bytes.get(self.pos + ahead).copied()
    }

    fn bump(&mut self) {
        self.pos += 1;
    }

    fn push(&mut self, kind: TokenKind, start: usize) {
        self.tokens.push(Token {
            kind,
            span: Span::new(start as u32, self.pos as u32),
        });
    }

    fn span_from(&self, start: usize) -> Span {
        Span::new(start as u32, self.pos as u32)
    }

    // ---- whitespace & trivia ----------------------------------------------

    /// Skip whitespace; a run containing two or more newlines is a
    /// blank-line gap, preserved as trivia.
    fn skip_whitespace(&mut self) {
        let start = self.pos;
        let mut newlines = 0u32;
        while let Some(byte) = self.peek() {
            match byte {
                b'\n' => {
                    newlines += 1;
                    self.bump();
                }
                b' ' | b'\t' | b'\r' => self.bump(),
                _ => break,
            }
        }
        if newlines >= 2 {
            self.trivia.push(SpannedTrivia {
                trivia: Trivia::BlankLines {
                    count: newlines - 1,
                },
                span: self.span_from(start),
            });
        }
    }

    // ---- comments ----------------------------------------------------------

    /// Disambiguate a leading `-`: `--[=*[` long comment, `---` doc line,
    /// `--` line comment, lone `-` the minus token.
    fn dash(&mut self, start: usize) {
        if self.peek_at(1) != Some(b'-') {
            self.bump();
            self.push(TokenKind::Minus, start);
            return;
        }
        self.bump();
        self.bump();
        if let Some(level) = self.long_bracket_level() {
            let text_start = self.pos;
            let closed = self.consume_long_bracket_body(level, start);
            let text = self.long_body_text(text_start, level, closed);
            self.trivia.push(SpannedTrivia {
                trivia: Trivia::LongComment { text },
                span: self.span_from(start),
            });
            return;
        }
        if self.peek() == Some(b'-') {
            self.bump();
            let text_start = self.pos;
            self.consume_to_line_end();
            let text = self.src[text_start..self.pos].to_string();
            self.trivia.push(SpannedTrivia {
                trivia: Trivia::DocComment { text },
                span: self.span_from(start),
            });
            return;
        }
        let text_start = self.pos;
        self.consume_to_line_end();
        let text = self.src[text_start..self.pos].to_string();
        self.trivia.push(SpannedTrivia {
            trivia: Trivia::LineComment { text },
            span: self.span_from(start),
        });
    }

    fn consume_to_line_end(&mut self) {
        while let Some(byte) = self.peek() {
            if byte == b'\n' {
                break;
            }
            self.bump();
        }
    }

    // ---- long brackets -----------------------------------------------------

    /// At a possible `[=*[` opener: consume it and return its level, or
    /// consume nothing and return `None`.
    fn long_bracket_level(&mut self) -> Option<u32> {
        if self.peek() != Some(b'[') {
            return None;
        }
        let mut ahead = 1;
        let mut level = 0u32;
        while self.peek_at(ahead) == Some(b'=') {
            ahead += 1;
            level += 1;
        }
        if self.peek_at(ahead) != Some(b'[') {
            return None;
        }
        self.pos += ahead + 1;
        Some(level)
    }

    /// Consume up to and including the matching `]=*]` close. Returns
    /// whether the bracket was closed; an unterminated bracket is
    /// `LUA-E003`, closed at end of input.
    fn consume_long_bracket_body(&mut self, level: u32, opener: usize) -> bool {
        while let Some(byte) = self.peek() {
            if byte == b']' {
                let mut ahead = 1;
                let mut eqs = 0u32;
                while self.peek_at(ahead) == Some(b'=') {
                    ahead += 1;
                    eqs += 1;
                }
                if eqs == level && self.peek_at(ahead) == Some(b']') {
                    self.pos += ahead + 1;
                    return true;
                }
            }
            self.bump();
        }
        self.diagnostics.push(Diagnostic::error(
            self.span_from(opener),
            codes::UNTERMINATED_LONG_BRACKET,
            "unterminated long bracket".to_string(),
        ));
        false
    }

    /// The body text of a long bracket, exclusive of its delimiters.
    fn long_body_text(&self, text_start: usize, level: u32, closed: bool) -> String {
        let close_len = if closed { level as usize + 2 } else { 0 };
        self.src[text_start..self.pos - close_len].to_string()
    }

    // ---- strings -----------------------------------------------------------

    /// A short string to its closing quote, honouring the 5.1 escape set.
    /// A newline or end of input before the close is `LUA-E002`, recovered
    /// by closing the string at that point.
    fn short_string(&mut self, start: usize, quote: u8) {
        self.bump();
        loop {
            match self.peek() {
                None | Some(b'\n') => {
                    self.diagnostics.push(Diagnostic::error(
                        self.span_from(start),
                        codes::UNTERMINATED_STRING,
                        "unterminated string".to_string(),
                    ));
                    break;
                }
                Some(b'\\') => {
                    self.bump();
                    // Any escaped byte is consumed verbatim — including an
                    // escaped newline, which 5.1 allows inside a string.
                    if self.peek().is_some() {
                        self.bump();
                    }
                }
                Some(byte) if byte == quote => {
                    self.bump();
                    break;
                }
                Some(_) => self.bump(),
            }
        }
        self.push(TokenKind::Str, start);
    }

    /// `[` is a long string opener or the plain bracket.
    fn bracket(&mut self, start: usize) {
        if let Some(level) = self.long_bracket_level() {
            self.consume_long_bracket_body(level, start);
            self.push(TokenKind::Str, start);
        } else {
            self.bump();
            self.push(TokenKind::LBracket, start);
        }
    }

    // ---- numbers -----------------------------------------------------------

    /// Decimal (fraction/exponent) or `0x` hex. Trailing identifier bytes
    /// make the whole run `LUA-E004`, consumed greedily so the parser sees
    /// one malformed number, not a number and a name.
    fn number(&mut self, start: usize) {
        if self.peek() == Some(b'0') && matches!(self.peek_at(1), Some(b'x' | b'X')) {
            self.bump();
            self.bump();
            let digits_start = self.pos;
            while self.peek().is_some_and(|b| b.is_ascii_hexdigit()) {
                self.bump();
            }
            if self.pos == digits_start {
                self.malformed_number(start);
                return;
            }
        } else {
            self.scan_digits();
            if self.peek() == Some(b'.') {
                self.bump();
                self.scan_digits();
            }
            self.scan_exponent();
        }
        self.finish_number(start);
    }

    fn scan_digits(&mut self) {
        while self.peek().is_some_and(|b| b.is_ascii_digit()) {
            self.bump();
        }
    }

    /// `[eE][+-]?digits` — rewinds entirely when no digits follow, so the
    /// `e` lexes as a trailing identifier byte and trips `finish_number`.
    fn scan_exponent(&mut self) {
        if !matches!(self.peek(), Some(b'e' | b'E')) {
            return;
        }
        let marker = self.pos;
        self.bump();
        if matches!(self.peek(), Some(b'+' | b'-')) {
            self.bump();
        }
        if self.peek().is_some_and(|b| b.is_ascii_digit()) {
            self.scan_digits();
        } else {
            self.pos = marker;
        }
    }

    /// Close a numeral: trailing identifier bytes make the whole run
    /// `LUA-E004`; otherwise the token is a clean `Number`.
    fn finish_number(&mut self, start: usize) {
        if self
            .peek()
            .is_some_and(|b| b.is_ascii_alphanumeric() || b == b'_')
        {
            self.malformed_number(start);
        } else {
            self.push(TokenKind::Number, start);
        }
    }

    fn malformed_number(&mut self, start: usize) {
        while self
            .peek()
            .is_some_and(|b| b.is_ascii_alphanumeric() || b == b'_')
        {
            self.bump();
        }
        self.diagnostics.push(Diagnostic::error(
            self.span_from(start),
            codes::MALFORMED_NUMBER,
            format!("malformed number '{}'", &self.src[start..self.pos]),
        ));
        self.push(TokenKind::Number, start);
    }

    // ---- names, dots, small operators ---------------------------------------

    /// Greedy identifier run, then a keyword-table lookup.
    fn ident(&mut self, start: usize) {
        while self
            .peek()
            .is_some_and(|b| b.is_ascii_alphanumeric() || b == b'_')
        {
            self.bump();
        }
        let text = &self.src[start..self.pos];
        let kind = TokenKind::keyword(text).unwrap_or(TokenKind::Name);
        self.push(kind, start);
    }

    /// `.` / `..` / `...`, or a number like `.5`.
    fn dot(&mut self, start: usize) {
        if self.peek_at(1).is_some_and(|b| b.is_ascii_digit()) {
            // `.5` — fraction digits then the shared exponent/closing rules,
            // so `.5e` is malformed here exactly as `1e` is in `number`.
            self.bump();
            self.scan_digits();
            self.scan_exponent();
            self.finish_number(start);
            return;
        }
        self.bump();
        if self.peek() == Some(b'.') {
            self.bump();
            if self.peek() == Some(b'.') {
                self.bump();
                self.push(TokenKind::Ellipsis, start);
            } else {
                self.push(TokenKind::DotDot, start);
            }
        } else {
            self.push(TokenKind::Dot, start);
        }
    }

    /// `~=` is the inequality operator; a lone `~` matches no 5.1 rule.
    fn tilde(&mut self, start: usize) {
        self.bump();
        if self.peek() == Some(b'=') {
            self.bump();
            self.push(TokenKind::Neq, start);
        } else {
            self.diagnostics.push(Diagnostic::error(
                self.span_from(start),
                codes::UNEXPECTED_CHARACTER,
                "unexpected character '~'".to_string(),
            ));
            self.push(TokenKind::Error, start);
        }
    }

    fn single(&mut self, start: usize, kind: TokenKind) {
        self.bump();
        self.push(kind, start);
    }

    fn one_or_two(&mut self, start: usize, second: u8, one: TokenKind, two: TokenKind) {
        self.bump();
        if self.peek() == Some(second) {
            self.bump();
            self.push(two, start);
        } else {
            self.push(one, start);
        }
    }

    /// A run of bytes no rule matches: one `Error` token, one `LUA-E001`.
    fn error_run(&mut self, start: usize) {
        while let Some(byte) = self.peek() {
            if recognised_start(byte) || byte.is_ascii_whitespace() {
                break;
            }
            self.bump();
        }
        self.diagnostics.push(Diagnostic::error(
            self.span_from(start),
            codes::UNEXPECTED_CHARACTER,
            format!("unexpected character '{}'", &self.src[start..self.pos]),
        ));
        self.push(TokenKind::Error, start);
    }
}

fn recognised_start(byte: u8) -> bool {
    matches!(
        byte,
        b'-' | b'"'
            | b'\''
            | b'['
            | b']'
            | b'0'..=b'9'
            | b'.'
            | b'A'..=b'Z'
            | b'a'..=b'z'
            | b'_'
            | b'='
            | b'<'
            | b'>'
            | b'~'
            | b'+'
            | b'*'
            | b'/'
            | b'%'
            | b'^'
            | b'#'
            | b'('
            | b')'
            | b'{'
            | b'}'
            | b';'
            | b':'
            | b','
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diagnostic::codes;
    use crate::token::TokenKind as K;

    fn kinds(src: &str) -> Vec<K> {
        lex(src).tokens.iter().map(|t| t.kind).collect()
    }

    #[test]
    fn keywords_and_names() {
        assert_eq!(
            kinds("local x = nil"),
            vec![K::Local, K::Name, K::Eq, K::Nil, K::Eof]
        );
    }

    #[test]
    fn long_string_levels_match_exactly() {
        let lexed = lex("s = [==[a]]b]==]");
        assert_eq!(
            lexed.tokens.iter().map(|t| t.kind).collect::<Vec<_>>(),
            vec![K::Name, K::Eq, K::Str, K::Eof]
        );
        assert!(lexed.diagnostics.is_empty());
    }

    #[test]
    fn unterminated_long_string_closes_at_eof() {
        let lexed = lex("s = [[abc");
        assert_eq!(lexed.diagnostics.len(), 1);
        assert_eq!(lexed.diagnostics[0].code, codes::UNTERMINATED_LONG_BRACKET);
        assert_eq!(
            *lexed
                .tokens
                .iter()
                .map(|t| t.kind)
                .collect::<Vec<_>>()
                .last()
                .unwrap(),
            K::Eof
        );
    }

    #[test]
    fn unterminated_string_recovers_at_newline() {
        let lexed = lex("s = \"abc\nx = 1");
        assert_eq!(lexed.diagnostics.len(), 1);
        assert_eq!(lexed.diagnostics[0].code, codes::UNTERMINATED_STRING);
        // Lexing continued on the next line.
        assert!(lexed.tokens.iter().any(|t| t.kind == K::Number));
    }

    #[test]
    fn doc_runs_are_trivia_not_tokens() {
        let lexed = lex("---@param a number\nfunction f(a) end");
        assert_eq!(
            lexed.tokens.iter().map(|t| t.kind).collect::<Vec<_>>(),
            vec![
                K::Function,
                K::Name,
                K::LParen,
                K::Name,
                K::RParen,
                K::End,
                K::Eof
            ]
        );
        assert!(matches!(
            &lexed.trivia[0].trivia,
            Trivia::DocComment { text } if text == "@param a number"
        ));
    }

    #[test]
    fn long_comment_swallows_fake_doc() {
        let lexed = lex("--[[\n---@param not real\n]] x = 1");
        assert_eq!(
            lexed.tokens.iter().map(|t| t.kind).collect::<Vec<_>>(),
            vec![K::Name, K::Eq, K::Number, K::Eof]
        );
        assert!(matches!(
            &lexed.trivia[0].trivia,
            Trivia::LongComment { .. }
        ));
    }

    #[test]
    fn numbers_decimal_hex_and_malformed() {
        assert_eq!(
            kinds("0x1F 3.5e-1 .5"),
            vec![K::Number, K::Number, K::Number, K::Eof]
        );
        let bad = lex("3a");
        assert_eq!(bad.diagnostics[0].code, codes::MALFORMED_NUMBER);
        assert_eq!(bad.tokens[0].kind, K::Number);
        assert_eq!(bad.tokens[0].span.end, 2);
    }

    #[test]
    fn dots_family() {
        assert_eq!(
            kinds("a.b .. c ..."),
            vec![
                K::Name,
                K::Dot,
                K::Name,
                K::DotDot,
                K::Name,
                K::Ellipsis,
                K::Eof
            ]
        );
    }

    #[test]
    fn unknown_bytes_are_one_error_run() {
        let lexed = lex("x = §§ + 1");
        let errors: Vec<_> = lexed.tokens.iter().filter(|t| t.kind == K::Error).collect();
        assert_eq!(errors.len(), 1);
        assert_eq!(lexed.diagnostics.len(), 1);
        assert_eq!(lexed.diagnostics[0].code, codes::UNEXPECTED_CHARACTER);
    }

    #[test]
    fn blank_line_gaps_are_trivia() {
        let lexed = lex("a = 1\n\n\nb = 2");
        assert!(matches!(
            &lexed.trivia[0].trivia,
            Trivia::BlankLines { count: 2 }
        ));
    }

    #[test]
    fn escaped_quote_stays_inside_string() {
        let lexed = lex(r#"s = "a\"b""#);
        assert_eq!(
            lexed.tokens.iter().map(|t| t.kind).collect::<Vec<_>>(),
            vec![K::Name, K::Eq, K::Str, K::Eof]
        );
        assert!(lexed.diagnostics.is_empty());
    }
}
