//! Recursive-descent Lua 5.1 parser with error recovery (decisions/001).
//!
//! Total: always yields a (possibly partial) [`Chunk`] plus diagnostics —
//! never a panic on user input. On unexpected input it records a
//! `LUA-E1xx` diagnostic, resynchronises to the next statement boundary,
//! and continues; a forward-progress guard makes the block loop immune to
//! stray tokens.

use crate::ast::{
    Ast, BinOp, Block, BlockId, Chunk, Expr, ExprId, ExprKind, FuncBody, FuncName, IfArm, Name,
    Parsed, Stat, StatId, StatKind, TableField, UnOp,
};
use crate::diagnostic::{Diagnostic, codes};
use crate::lexer;
use crate::span::Span;
use crate::token::{Token, TokenKind};

/// Lua's unary operator binding power (lcode.c `UNARY_PRIORITY`).
const UNARY_PRIORITY: u8 = 12;

/// Nesting cap keeping recursion well inside wasm's 1 MiB shadow stack
/// (the deployment target's tightest budget). Beyond it, parsing recovers
/// with `LUA-E103` instead of overflowing — totality holds everywhere.
const MAX_NESTING_DEPTH: u32 = 200;

/// Parse `src` into a tree plus diagnostics (lexical ones included).
#[must_use]
pub fn parse(src: &str) -> Parsed {
    parse_lexed(src, lexer::lex(src))
}

/// Parse from an existing lex of `src` — lets a caller that also needs the
/// trivia lex exactly once.
#[must_use]
pub fn parse_lexed(src: &str, lexed: crate::token::Lexed) -> Parsed {
    Parser::new(src, lexed).run()
}

struct Parser<'src> {
    src: &'src str,
    tokens: Vec<Token>,
    pos: usize,
    ast: Ast,
    diagnostics: Vec<Diagnostic>,
    depth: u32,
}

impl<'src> Parser<'src> {
    fn new(src: &'src str, lexed: crate::token::Lexed) -> Self {
        Self {
            src,
            tokens: lexed.tokens,
            pos: 0,
            ast: Ast::default(),
            diagnostics: lexed.diagnostics,
            depth: 0,
        }
    }

    /// Recursion guard for every self-nesting production. `false` means
    /// the cap is hit: report once (at the trigger) and let the caller
    /// produce its recovery value without descending further.
    fn enter_nested(&mut self) -> bool {
        self.depth += 1;
        if self.depth == MAX_NESTING_DEPTH + 1 {
            self.error_here(codes::NESTING_TOO_DEEP, "nesting too deep");
        }
        self.depth <= MAX_NESTING_DEPTH
    }

    fn exit_nested(&mut self) {
        self.depth -= 1;
    }

    fn run(mut self) -> Parsed {
        let start = self.current_span();
        let body = self.parse_block();
        // Anything the block loop refused to own (stray `end`s, …) is
        // reported and skipped so parsing always reaches end of input.
        while !self.at(TokenKind::Eof) {
            self.error_here(codes::UNEXPECTED_TOKEN, "unexpected token");
            self.bump();
            let trailing = self.parse_block();
            let stats = self.ast.block(trailing).stats.clone();
            self.ast.blocks[body.0 as usize].stats.extend(stats);
        }
        let end = self.current_span();
        let chunk = Chunk {
            body,
            span: Span::new(start.start, end.end),
        };
        self.ast.blocks[body.0 as usize].span = chunk.span;
        Parsed {
            ast: self.ast,
            chunk,
            diagnostics: self.diagnostics,
        }
    }

    // ---- cursor ------------------------------------------------------------

    fn current(&self) -> Token {
        self.tokens[self.pos]
    }

    fn current_span(&self) -> Span {
        self.current().span
    }

    fn kind(&self) -> TokenKind {
        self.current().kind
    }

    fn at(&self, kind: TokenKind) -> bool {
        self.kind() == kind
    }

    fn bump(&mut self) {
        if self.pos + 1 < self.tokens.len() {
            self.pos += 1;
        }
    }

    fn eat(&mut self, kind: TokenKind) -> bool {
        if self.at(kind) {
            self.bump();
            true
        } else {
            false
        }
    }

    fn text(&self, span: Span) -> &'src str {
        &self.src[span.start as usize..span.end as usize]
    }

    fn name_here(&mut self) -> Name {
        let span = self.current_span();
        let text = self.text(span).to_string();
        self.bump();
        Name { text, span }
    }

    /// Consume `kind` or report `LUA-E101` at the cursor.
    fn expect(&mut self, kind: TokenKind, what: &str) -> bool {
        if self.eat(kind) {
            true
        } else {
            self.error_here(codes::EXPECTED_TOKEN, &format!("expected {what}"));
            false
        }
    }

    /// Expect a `Name` token; a placeholder name recovers a missing one.
    fn expect_name(&mut self) -> Name {
        if self.at(TokenKind::Name) {
            self.name_here()
        } else {
            self.error_here(codes::EXPECTED_TOKEN, "expected a name");
            Name {
                text: String::new(),
                span: Span::empty(self.current_span().start),
            }
        }
    }

    fn error_here(&mut self, code: &'static str, message: &str) {
        self.error_at(self.current_span(), code, message);
    }

    fn error_at(&mut self, span: Span, code: &'static str, message: &str) {
        self.diagnostics
            .push(Diagnostic::error(span, code, message.to_string()));
    }

    // ---- blocks & statements -------------------------------------------------

    fn at_block_end(&self) -> bool {
        matches!(
            self.kind(),
            TokenKind::End
                | TokenKind::Else
                | TokenKind::Elseif
                | TokenKind::Until
                | TokenKind::Eof
        )
    }

    /// A statement sequence until a block terminator. `return`/`break` in a
    /// non-final position is reported (Lua 5.1 last-statement rule) but the
    /// following statements still parse.
    fn parse_block(&mut self) -> BlockId {
        if !self.enter_nested() {
            self.exit_nested();
            let offset = self.current_span().start;
            return self.ast.alloc_block(Block {
                stats: Vec::new(),
                span: Span::empty(offset),
            });
        }
        let block = self.parse_block_inner();
        self.exit_nested();
        block
    }

    fn parse_block_inner(&mut self) -> BlockId {
        let start = self.current_span();
        let mut stats = Vec::new();
        let mut last_was_final: Option<Span> = None;
        while !self.at_block_end() {
            if self.eat(TokenKind::Semi) {
                continue;
            }
            if let Some(final_span) = last_was_final.take() {
                self.error_at(
                    final_span,
                    codes::UNEXPECTED_TOKEN,
                    "'return'/'break' must be the last statement in a block",
                );
            }
            let before = self.pos;
            if let Some(stat) = self.parse_stat() {
                if matches!(
                    self.ast.stat(stat).kind,
                    StatKind::Return { .. } | StatKind::Break
                ) {
                    last_was_final = Some(self.ast.stat(stat).span);
                }
                stats.push(stat);
            }
            if self.pos == before {
                // Forward-progress guard: a token that starts no statement
                // is reported once and skipped, so the loop never spins.
                self.error_here(codes::UNEXPECTED_TOKEN, "unexpected token");
                self.bump();
            }
        }
        let end_offset = self.current_span().start;
        self.ast.alloc_block(Block {
            stats,
            span: Span::new(start.start.min(end_offset), end_offset),
        })
    }

    /// One statement, dispatched on the leading token. `None` only when the
    /// cursor sits on something no statement starts with (caller guard
    /// advances).
    fn parse_stat(&mut self) -> Option<StatId> {
        let start = self.current_span();
        let kind = match self.kind() {
            TokenKind::Local => self.parse_local(),
            TokenKind::If => self.parse_if(),
            TokenKind::While => self.parse_while(),
            TokenKind::Do => {
                self.bump();
                let body = self.parse_block();
                self.expect_end(start, "do");
                StatKind::Do { body }
            }
            TokenKind::For => self.parse_for(),
            TokenKind::Repeat => self.parse_repeat(),
            TokenKind::Function => self.parse_function_decl(),
            TokenKind::Return => {
                self.bump();
                let values = if self.at_block_end() || self.at(TokenKind::Semi) {
                    Vec::new()
                } else {
                    self.parse_expr_list()
                };
                StatKind::Return { values }
            }
            TokenKind::Break => {
                self.bump();
                StatKind::Break
            }
            TokenKind::Name | TokenKind::LParen => self.parse_expr_stat(),
            _ => return None,
        };
        let end = self.previous_end();
        Some(self.ast.alloc_stat(Stat {
            kind,
            span: Span::new(start.start, end),
        }))
    }

    fn previous_end(&self) -> u32 {
        if self.pos == 0 {
            0
        } else {
            self.tokens[self.pos - 1].span.end
        }
    }

    fn parse_local(&mut self) -> StatKind {
        self.bump();
        if self.eat(TokenKind::Function) {
            let name = self.expect_name();
            let func = self.parse_func_body();
            return StatKind::LocalFunction { name, func };
        }
        let mut names = vec![self.expect_name()];
        while self.eat(TokenKind::Comma) {
            names.push(self.expect_name());
        }
        let values = if self.eat(TokenKind::Eq) {
            self.parse_expr_list()
        } else {
            Vec::new()
        };
        StatKind::LocalAssign { names, values }
    }

    fn parse_if(&mut self) -> StatKind {
        let opener = self.current_span();
        self.bump();
        let mut arms = Vec::new();
        let cond = self.parse_expr();
        self.expect(TokenKind::Then, "'then'");
        let body = self.parse_block();
        arms.push(IfArm { cond, body });
        let mut else_body = None;
        loop {
            match self.kind() {
                TokenKind::Elseif => {
                    self.bump();
                    let cond = self.parse_expr();
                    self.expect(TokenKind::Then, "'then'");
                    let body = self.parse_block();
                    arms.push(IfArm { cond, body });
                }
                TokenKind::Else => {
                    self.bump();
                    else_body = Some(self.parse_block());
                    self.expect_end(opener, "if");
                    break;
                }
                _ => {
                    self.expect_end(opener, "if");
                    break;
                }
            }
        }
        StatKind::If { arms, else_body }
    }

    fn parse_while(&mut self) -> StatKind {
        let opener = self.current_span();
        self.bump();
        let cond = self.parse_expr();
        self.expect(TokenKind::Do, "'do'");
        let body = self.parse_block();
        self.expect_end(opener, "while");
        StatKind::While { cond, body }
    }

    fn parse_repeat(&mut self) -> StatKind {
        let opener = self.current_span();
        self.bump();
        let body = self.parse_block();
        if !self.expect(TokenKind::Until, "'until'") {
            self.error_at(
                opener,
                codes::UNTERMINATED_BLOCK,
                "unterminated 'repeat' block",
            );
        }
        let cond = self.parse_expr();
        StatKind::Repeat { body, cond }
    }

    fn parse_for(&mut self) -> StatKind {
        self.bump();
        let opener = self.tokens[self.pos - 1].span;
        let first = self.expect_name();
        if self.eat(TokenKind::Eq) {
            let low = self.parse_expr();
            self.expect(TokenKind::Comma, "','");
            let high = self.parse_expr();
            let step = if self.eat(TokenKind::Comma) {
                Some(self.parse_expr())
            } else {
                None
            };
            self.expect(TokenKind::Do, "'do'");
            let body = self.parse_block();
            self.expect_end(opener, "for");
            return StatKind::NumericFor {
                name: first,
                low,
                high,
                step,
                body,
            };
        }
        let mut names = vec![first];
        while self.eat(TokenKind::Comma) {
            names.push(self.expect_name());
        }
        self.expect(TokenKind::In, "'in'");
        let exprs = self.parse_expr_list();
        self.expect(TokenKind::Do, "'do'");
        let body = self.parse_block();
        self.expect_end(opener, "for");
        StatKind::GenericFor { names, exprs, body }
    }

    fn parse_function_decl(&mut self) -> StatKind {
        self.bump();
        let mut segments = vec![self.expect_name()];
        while self.eat(TokenKind::Dot) {
            segments.push(self.expect_name());
        }
        let method = if self.eat(TokenKind::Colon) {
            Some(self.expect_name())
        } else {
            None
        };
        let func = self.parse_func_body();
        StatKind::FunctionDecl {
            name: FuncName { segments, method },
            func,
        }
    }

    /// Assignment or call statement, disambiguated after the suffixed
    /// expression. A non-call expression statement is reported (only calls
    /// are legal) but kept in the tree for downstream analysis.
    fn parse_expr_stat(&mut self) -> StatKind {
        let first = self.parse_suffixed();
        if self.at(TokenKind::Eq) || self.at(TokenKind::Comma) {
            let mut targets = vec![first];
            while self.eat(TokenKind::Comma) {
                targets.push(self.parse_suffixed());
            }
            self.expect(TokenKind::Eq, "'='");
            // Lua 5.1 rejects assignment to anything but a name, field, or
            // index; report each bad target but keep the tree (totality).
            for &target in &targets {
                if !matches!(
                    self.ast.expr(target).kind,
                    ExprKind::NameRef(_)
                        | ExprKind::Field { .. }
                        | ExprKind::Index { .. }
                        | ExprKind::Missing
                ) {
                    self.error_at(
                        self.ast.expr(target).span,
                        codes::UNEXPECTED_TOKEN,
                        "cannot assign to this expression",
                    );
                }
            }
            let values = self.parse_expr_list();
            return StatKind::Assign { targets, values };
        }
        if !matches!(
            self.ast.expr(first).kind,
            ExprKind::Call { .. } | ExprKind::MethodCall { .. } | ExprKind::Missing
        ) {
            self.error_at(
                self.ast.expr(first).span,
                codes::UNEXPECTED_TOKEN,
                "only a function call can stand as a statement",
            );
        }
        StatKind::CallStat { call: first }
    }

    /// Consume the `end` that closes the block opened at `opener`, or
    /// report `LUA-E102` at the opener (usability: the missing `end` is the
    /// opener's fault, not the recovery point's).
    fn expect_end(&mut self, opener: Span, what: &str) {
        if !self.eat(TokenKind::End) {
            self.error_at(
                opener,
                codes::UNTERMINATED_BLOCK,
                &format!("unterminated '{what}' block: 'end' expected"),
            );
        }
    }

    // ---- expressions ---------------------------------------------------------

    fn parse_expr_list(&mut self) -> Vec<ExprId> {
        let mut exprs = vec![self.parse_expr()];
        while self.eat(TokenKind::Comma) {
            exprs.push(self.parse_expr());
        }
        exprs
    }

    fn parse_expr(&mut self) -> ExprId {
        self.parse_sub_expr(0)
    }

    /// lparser.c `subexpr`: unary operators bind at `UNARY_PRIORITY`; binary
    /// operators chain while their left power beats `limit`; right power
    /// drives the recursion, so `..` and `^` come out right-associative.
    fn parse_sub_expr(&mut self, limit: u8) -> ExprId {
        if !self.enter_nested() {
            self.exit_nested();
            return self.ast.alloc_expr(Expr {
                kind: ExprKind::Missing,
                span: Span::empty(self.current_span().start),
            });
        }
        let expr = self.parse_sub_expr_inner(limit);
        self.exit_nested();
        expr
    }

    fn parse_sub_expr_inner(&mut self, limit: u8) -> ExprId {
        let start = self.current_span();
        let mut lhs = if let Some(op) = unary_op(self.kind()) {
            self.bump();
            let operand = self.parse_sub_expr(UNARY_PRIORITY);
            let span = Span::new(start.start, self.previous_end());
            self.ast.alloc_expr(Expr {
                kind: ExprKind::Unary { op, operand },
                span,
            })
        } else {
            self.parse_simple_expr()
        };
        while let Some((op, left_power, right_power)) = binary_op(self.kind()) {
            if left_power <= limit {
                break;
            }
            self.bump();
            let rhs = self.parse_sub_expr(right_power);
            let span = Span::new(start.start, self.previous_end());
            lhs = self.ast.alloc_expr(Expr {
                kind: ExprKind::Binary { op, lhs, rhs },
                span,
            });
        }
        lhs
    }

    fn parse_simple_expr(&mut self) -> ExprId {
        let span = self.current_span();
        let kind = match self.kind() {
            TokenKind::Nil => {
                self.bump();
                ExprKind::Nil
            }
            TokenKind::True => {
                self.bump();
                ExprKind::True
            }
            TokenKind::False => {
                self.bump();
                ExprKind::False
            }
            TokenKind::Ellipsis => {
                self.bump();
                ExprKind::Vararg
            }
            TokenKind::Number => {
                let raw = self.text(span).to_string();
                self.bump();
                ExprKind::Number { raw }
            }
            TokenKind::Str => {
                let raw = self.text(span).to_string();
                self.bump();
                ExprKind::Str { raw }
            }
            TokenKind::Function => {
                self.bump();
                let func = self.parse_func_body();
                let span = Span::new(span.start, self.previous_end());
                return self.ast.alloc_expr(Expr {
                    kind: ExprKind::Function(func),
                    span,
                });
            }
            TokenKind::LBrace => return self.parse_table(),
            TokenKind::Name | TokenKind::LParen => return self.parse_suffixed(),
            _ => {
                self.error_here(codes::UNEXPECTED_TOKEN, "expected an expression");
                return self.ast.alloc_expr(Expr {
                    kind: ExprKind::Missing,
                    span: Span::empty(span.start),
                });
            }
        };
        self.ast.alloc_expr(Expr { kind, span })
    }

    /// A primary (`Name` or `( expr )`) plus its postfix chain: `.name`,
    /// `[expr]`, `:method(args)`, and the three call forms.
    fn parse_suffixed(&mut self) -> ExprId {
        let start = self.current_span();
        let mut expr = match self.kind() {
            TokenKind::Name => {
                let name = self.name_here();
                self.ast.alloc_expr(Expr {
                    kind: ExprKind::NameRef(name.text),
                    span: name.span,
                })
            }
            TokenKind::LParen => {
                self.bump();
                let inner = self.parse_expr();
                self.expect(TokenKind::RParen, "')'");
                let span = Span::new(start.start, self.previous_end());
                self.ast.alloc_expr(Expr {
                    kind: ExprKind::Paren(inner),
                    span,
                })
            }
            _ => {
                self.error_here(codes::UNEXPECTED_TOKEN, "expected an expression");
                return self.ast.alloc_expr(Expr {
                    kind: ExprKind::Missing,
                    span: Span::empty(start.start),
                });
            }
        };
        loop {
            match self.kind() {
                TokenKind::Dot => {
                    self.bump();
                    let name = self.expect_name();
                    let span = Span::new(start.start, self.previous_end());
                    expr = self.ast.alloc_expr(Expr {
                        kind: ExprKind::Field { obj: expr, name },
                        span,
                    });
                }
                TokenKind::LBracket => {
                    self.bump();
                    let key = self.parse_expr();
                    self.expect(TokenKind::RBracket, "']'");
                    let span = Span::new(start.start, self.previous_end());
                    expr = self.ast.alloc_expr(Expr {
                        kind: ExprKind::Index { obj: expr, key },
                        span,
                    });
                }
                TokenKind::Colon => {
                    self.bump();
                    let method = self.expect_name();
                    let args = self.parse_call_args();
                    let span = Span::new(start.start, self.previous_end());
                    expr = self.ast.alloc_expr(Expr {
                        kind: ExprKind::MethodCall {
                            obj: expr,
                            method,
                            args,
                        },
                        span,
                    });
                }
                TokenKind::LParen | TokenKind::Str | TokenKind::LBrace => {
                    let args = self.parse_call_args();
                    let span = Span::new(start.start, self.previous_end());
                    expr = self.ast.alloc_expr(Expr {
                        kind: ExprKind::Call { callee: expr, args },
                        span,
                    });
                }
                _ => break,
            }
        }
        expr
    }

    /// The three call-argument forms: `(explist)`, a string, a table.
    fn parse_call_args(&mut self) -> Vec<ExprId> {
        match self.kind() {
            TokenKind::LParen => {
                self.bump();
                let args = if self.at(TokenKind::RParen) {
                    Vec::new()
                } else {
                    self.parse_expr_list()
                };
                self.expect(TokenKind::RParen, "')'");
                args
            }
            TokenKind::Str => {
                let span = self.current_span();
                let raw = self.text(span).to_string();
                self.bump();
                vec![self.ast.alloc_expr(Expr {
                    kind: ExprKind::Str { raw },
                    span,
                })]
            }
            TokenKind::LBrace => vec![self.parse_table()],
            _ => {
                self.error_here(codes::EXPECTED_TOKEN, "expected call arguments");
                Vec::new()
            }
        }
    }

    fn parse_table(&mut self) -> ExprId {
        let start = self.current_span();
        self.bump();
        let mut fields = Vec::new();
        while !self.at(TokenKind::RBrace) && !self.at(TokenKind::Eof) {
            let field = match self.kind() {
                TokenKind::LBracket => {
                    self.bump();
                    let key = self.parse_expr();
                    self.expect(TokenKind::RBracket, "']'");
                    self.expect(TokenKind::Eq, "'='");
                    let value = self.parse_expr();
                    TableField::Keyed { key, value }
                }
                TokenKind::Name if self.tokens[self.pos + 1].kind == TokenKind::Eq => {
                    let name = self.name_here();
                    self.bump(); // `=`
                    let value = self.parse_expr();
                    TableField::Named { name, value }
                }
                _ => {
                    let before = self.pos;
                    let value = self.parse_expr();
                    if self.pos == before {
                        // `Missing` without progress: skip the offender so
                        // the field loop cannot spin.
                        self.bump();
                    }
                    TableField::Positional(value)
                }
            };
            fields.push(field);
            if !self.eat(TokenKind::Comma) && !self.eat(TokenKind::Semi) {
                break;
            }
        }
        self.expect(TokenKind::RBrace, "'}'");
        let span = Span::new(start.start, self.previous_end());
        self.ast.alloc_expr(Expr {
            kind: ExprKind::Table { fields },
            span,
        })
    }

    /// `(` parlist `)` block `end`, the body of any function form.
    fn parse_func_body(&mut self) -> FuncBody {
        let opener = self.current_span();
        self.expect(TokenKind::LParen, "'('");
        let mut params = Vec::new();
        let mut is_vararg = false;
        if !self.at(TokenKind::RParen) {
            loop {
                if self.eat(TokenKind::Ellipsis) {
                    is_vararg = true;
                    break;
                }
                params.push(self.expect_name());
                if !self.eat(TokenKind::Comma) {
                    break;
                }
            }
        }
        self.expect(TokenKind::RParen, "')'");
        let body = self.parse_block();
        self.expect_end(opener, "function");
        FuncBody {
            params,
            is_vararg,
            body,
            span: Span::new(opener.start, self.previous_end()),
        }
    }
}

fn unary_op(kind: TokenKind) -> Option<UnOp> {
    Some(match kind {
        TokenKind::Not => UnOp::Not,
        TokenKind::Minus => UnOp::Neg,
        TokenKind::Hash => UnOp::Len,
        _ => return None,
    })
}

/// Binary operators with lcode.c's (left, right) binding powers; a smaller
/// right power makes the operator right-associative.
fn binary_op(kind: TokenKind) -> Option<(BinOp, u8, u8)> {
    Some(match kind {
        TokenKind::Or => (BinOp::Or, 1, 1),
        TokenKind::And => (BinOp::And, 2, 2),
        TokenKind::Lt => (BinOp::Lt, 3, 3),
        TokenKind::Gt => (BinOp::Gt, 3, 3),
        TokenKind::Le => (BinOp::Le, 3, 3),
        TokenKind::Ge => (BinOp::Ge, 3, 3),
        TokenKind::Neq => (BinOp::Ne, 3, 3),
        TokenKind::EqEq => (BinOp::Eq, 3, 3),
        TokenKind::DotDot => (BinOp::Concat, 9, 8),
        TokenKind::Plus => (BinOp::Add, 10, 10),
        TokenKind::Minus => (BinOp::Sub, 10, 10),
        TokenKind::Star => (BinOp::Mul, 11, 11),
        TokenKind::Slash => (BinOp::Div, 11, 11),
        TokenKind::Percent => (BinOp::Mod, 11, 11),
        TokenKind::Caret => (BinOp::Pow, 14, 13),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::{ExprKind as E, StatKind as S};

    fn parse_ok(src: &str) -> Parsed {
        let parsed = parse(src);
        assert!(
            parsed.diagnostics.is_empty(),
            "unexpected diagnostics: {:?}",
            parsed.diagnostics
        );
        parsed
    }

    fn first_stat(parsed: &Parsed) -> &Stat {
        let block = parsed.ast.block(parsed.chunk.body);
        parsed.ast.stat(block.stats[0])
    }

    #[test]
    fn local_assignment() {
        let parsed = parse_ok("local a, b = 1, 'two'");
        match &first_stat(&parsed).kind {
            S::LocalAssign { names, values } => {
                assert_eq!(names.len(), 2);
                assert_eq!(values.len(), 2);
            }
            other => panic!("expected local assign, got {other:?}"),
        }
    }

    #[test]
    fn suffixed_chain_and_method_call() {
        let parsed = parse_ok("trigger.action.outText('hi', 10)\nunit:getName()");
        let block = parsed.ast.block(parsed.chunk.body);
        assert_eq!(block.stats.len(), 2);
        match &parsed.ast.stat(block.stats[1]).kind {
            S::CallStat { call } => {
                assert!(matches!(parsed.ast.expr(*call).kind, E::MethodCall { .. }));
            }
            other => panic!("expected call stat, got {other:?}"),
        }
    }

    #[test]
    fn precedence_pow_right_assoc_and_unary() {
        // -2^2 parses as -(2^2); 2^3^2 as 2^(3^2).
        let parsed = parse_ok("x = -2^2 + 1 .. 'y'");
        match &first_stat(&parsed).kind {
            S::Assign { values, .. } => {
                // Top of `-2^2 + 1 .. 'y'` is the right-associative concat.
                assert!(matches!(
                    parsed.ast.expr(values[0]).kind,
                    E::Binary {
                        op: BinOp::Concat,
                        ..
                    }
                ));
            }
            other => panic!("expected assign, got {other:?}"),
        }
    }

    #[test]
    fn control_flow_nests() {
        parse_ok(
            "for i = 1, 10 do\n  if i % 2 == 0 then\n    print(i)\n  elseif i > 5 then\n    break\n  end\nend\nwhile true do do end end\nrepeat local x = 1 until x",
        );
    }

    #[test]
    fn table_constructor_forms() {
        let parsed = parse_ok("t = { 1, x = 2, ['k'] = 3, f(); 4 }");
        match &first_stat(&parsed).kind {
            S::Assign { values, .. } => match &parsed.ast.expr(values[0]).kind {
                E::Table { fields } => assert_eq!(fields.len(), 5),
                other => panic!("expected table, got {other:?}"),
            },
            other => panic!("expected assign, got {other:?}"),
        }
    }

    #[test]
    fn function_forms() {
        parse_ok(
            "function a.b.c:m(x, ...) return x end\nlocal function f() end\nlocal g = function() end",
        );
    }

    #[test]
    fn missing_end_recovers_and_points_at_opener() {
        let parsed = parse("function f()\nlocal x = 1\n");
        assert!(
            parsed
                .diagnostics
                .iter()
                .any(|d| d.code == codes::UNTERMINATED_BLOCK)
        );
        let diagnostic = parsed
            .diagnostics
            .iter()
            .find(|d| d.code == codes::UNTERMINATED_BLOCK)
            .unwrap();
        // Points at the opener (the `(` of the parameter list region).
        assert!(diagnostic.span.start <= 12);
        // The local inside still parsed.
        assert!(
            parsed
                .ast
                .stats
                .iter()
                .any(|s| matches!(s.kind, S::LocalAssign { .. }))
        );
    }

    #[test]
    fn statements_after_gap_still_parse() {
        let parsed = parse("if x then\ny = 1\n-- missing end\nz = 2\n");
        assert!(!parsed.diagnostics.is_empty());
        assert!(
            parsed
                .ast
                .stats
                .iter()
                .filter(|s| matches!(s.kind, S::Assign { .. }))
                .count()
                >= 2
        );
    }

    #[test]
    fn non_call_expression_statement_is_reported_but_kept() {
        let parsed = parse("x");
        assert!(
            parsed
                .diagnostics
                .iter()
                .any(|d| d.code == codes::UNEXPECTED_TOKEN)
        );
        assert!(matches!(first_stat(&parsed).kind, S::CallStat { .. }));
    }

    #[test]
    fn misplaced_return_is_reported() {
        let parsed = parse("return 1\nx = 2\n");
        assert!(
            parsed
                .diagnostics
                .iter()
                .any(|d| d.message.contains("last statement"))
        );
    }

    #[test]
    fn misplaced_return_behind_a_semicolon_is_still_reported() {
        let parsed = parse("return 1; x = 2\n");
        assert!(
            parsed
                .diagnostics
                .iter()
                .any(|d| d.message.contains("last statement"))
        );
        // A final `return 1;` stays legal.
        assert!(parse("return 1;\n").diagnostics.is_empty());
    }

    #[test]
    fn assignment_to_non_lvalue_is_reported_but_kept() {
        let parsed = parse("f() = 1\n");
        assert!(
            parsed
                .diagnostics
                .iter()
                .any(|d| d.message.contains("cannot assign"))
        );
        assert!(
            parsed
                .ast
                .stats
                .iter()
                .any(|s| matches!(s.kind, S::Assign { .. }))
        );
        // Names, fields, and indexes stay assignable.
        assert!(parse("a, b.c, d[1] = 1, 2, 3\n").diagnostics.is_empty());
    }

    #[test]
    fn stray_end_at_top_level_does_not_stop_parsing() {
        let parsed = parse("end\nx = 1\n");
        assert!(!parsed.diagnostics.is_empty());
        assert!(
            parsed
                .ast
                .stats
                .iter()
                .any(|s| matches!(s.kind, S::Assign { .. }))
        );
    }
}
