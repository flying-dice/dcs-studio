//! Tokens and trivia (SPEC.md §2; taxonomy in CONFORMANCE/lexical/README.md).

use serde::Serialize;

use crate::diagnostic::Diagnostic;
use crate::span::Span;

/// Every lexical token kind. Keywords and punctuation are individual kinds
/// because the conformance golden renders each one (`KW_…`-free taxonomy:
/// `FUNCTION`, `DOTDOT`, …). The lexeme is the source slice of the span.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum TokenKind {
    Name,
    Number,
    Str,
    /// Bytes no lexical rule matches; always paired with `LUA-E001`.
    Error,
    Eof,

    // Keywords (Lua 5.1 §2.1).
    And,
    Break,
    Do,
    Else,
    Elseif,
    End,
    False,
    For,
    Function,
    If,
    In,
    Local,
    Nil,
    Not,
    Or,
    Repeat,
    Return,
    Then,
    True,
    Until,
    While,

    // Punctuation.
    Plus,
    Minus,
    Star,
    Slash,
    Percent,
    Caret,
    Hash,
    EqEq,
    Neq,
    Le,
    Ge,
    Lt,
    Gt,
    Eq,
    LParen,
    RParen,
    LBrace,
    RBrace,
    LBracket,
    RBracket,
    Semi,
    Colon,
    Comma,
    Dot,
    DotDot,
    Ellipsis,
}

impl TokenKind {
    /// The keyword kind for a reserved spelling, if `text` is one.
    #[must_use]
    pub fn keyword(text: &str) -> Option<Self> {
        Some(match text {
            "and" => Self::And,
            "break" => Self::Break,
            "do" => Self::Do,
            "else" => Self::Else,
            "elseif" => Self::Elseif,
            "end" => Self::End,
            "false" => Self::False,
            "for" => Self::For,
            "function" => Self::Function,
            "if" => Self::If,
            "in" => Self::In,
            "local" => Self::Local,
            "nil" => Self::Nil,
            "not" => Self::Not,
            "or" => Self::Or,
            "repeat" => Self::Repeat,
            "return" => Self::Return,
            "then" => Self::Then,
            "true" => Self::True,
            "until" => Self::Until,
            "while" => Self::While,
            _ => return None,
        })
    }

    /// The conformance golden's `KIND` rendering.
    #[must_use]
    pub fn golden_name(self) -> &'static str {
        match self {
            Self::Name => "NAME",
            Self::Number => "NUMBER",
            Self::Str => "STRING",
            Self::Error => "ERROR",
            Self::Eof => "EOF",
            Self::And => "AND",
            Self::Break => "BREAK",
            Self::Do => "DO",
            Self::Else => "ELSE",
            Self::Elseif => "ELSEIF",
            Self::End => "END",
            Self::False => "FALSE",
            Self::For => "FOR",
            Self::Function => "FUNCTION",
            Self::If => "IF",
            Self::In => "IN",
            Self::Local => "LOCAL",
            Self::Nil => "NIL",
            Self::Not => "NOT",
            Self::Or => "OR",
            Self::Repeat => "REPEAT",
            Self::Return => "RETURN",
            Self::Then => "THEN",
            Self::True => "TRUE",
            Self::Until => "UNTIL",
            Self::While => "WHILE",
            Self::Plus => "PLUS",
            Self::Minus => "MINUS",
            Self::Star => "STAR",
            Self::Slash => "SLASH",
            Self::Percent => "PERCENT",
            Self::Caret => "CARET",
            Self::Hash => "HASH",
            Self::EqEq => "EQEQ",
            Self::Neq => "NEQ",
            Self::Le => "LE",
            Self::Ge => "GE",
            Self::Lt => "LT",
            Self::Gt => "GT",
            Self::Eq => "EQ",
            Self::LParen => "LPAREN",
            Self::RParen => "RPAREN",
            Self::LBrace => "LBRACE",
            Self::RBrace => "RBRACE",
            Self::LBracket => "LBRACKET",
            Self::RBracket => "RBRACKET",
            Self::Semi => "SEMI",
            Self::Colon => "COLON",
            Self::Comma => "COMMA",
            Self::Dot => "DOT",
            Self::DotDot => "DOTDOT",
            Self::Ellipsis => "ELLIPSIS",
        }
    }
}

/// A lexical token. The lexeme is `&src[span.start..span.end]` — tokens
/// never copy source text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Token {
    pub kind: TokenKind,
    pub span: Span,
}

/// Non-token source between tokens. `DocComment` is one `---` line — the
/// annotation parser reads these from trivia; the statement grammar never
/// sees them. Comment texts are stored with their markers stripped.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum Trivia {
    LineComment {
        text: String,
    },
    LongComment {
        text: String,
    },
    DocComment {
        text: String,
    },
    /// A gap of `count` blank lines between tokens.
    BlankLines {
        count: u32,
    },
}

/// A trivia element paired with the source span it occupies.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SpannedTrivia {
    pub trivia: Trivia,
    pub span: Span,
}

/// The full result of lexing: the trivia-free token stream (terminated by
/// an `Eof` token), the interleaved trivia, and lexical diagnostics — all
/// in source order.
#[derive(Debug, Clone, PartialEq)]
pub struct Lexed {
    pub tokens: Vec<Token>,
    pub trivia: Vec<SpannedTrivia>,
    pub diagnostics: Vec<Diagnostic>,
}
