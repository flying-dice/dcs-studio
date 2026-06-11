//! dcs-lua-syntax — source text to tokens and an AST.
//!
//! The foundation crate every other crate depends on: tokens, spans, the
//! Lua 5.1 AST (SPEC.md §2, decisions/004), and the one [`Diagnostic`] type
//! every stage emits (SPEC.md §3). WASM-safe — no threads, filesystem,
//! clock, or I/O. Analysis is total: lexing and parsing never fail on user
//! input; anomalies ride alongside as diagnostics.

pub mod annotation;
pub mod ast;
pub mod diagnostic;
pub mod lexer;
pub mod parser;
pub mod span;
pub mod token;
pub mod ty;
pub mod type_expr;

pub use annotation::{AnnotationBlock, FieldAnno, ParamAnno, parse_block};
pub use ast::Parsed;
pub use diagnostic::{Diagnostic, Severity};
pub use span::{LineIndex, Span};
pub use token::{Lexed, SpannedTrivia, Token, TokenKind, Trivia};
pub use ty::Type;
pub use type_expr::parse_type;
