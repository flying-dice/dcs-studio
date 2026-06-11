//! The semantic-preservation guard (SPEC.md §7): the printed text must
//! re-parse to a tree structurally identical to the input's — spans
//! ignored, short strings compared by decoded value — and every input
//! comment must survive into the output trivia.

use dcs_lua_syntax::Severity;
use dcs_lua_syntax::ast::{Ast, BlockId, ExprId, ExprKind, FuncBody, Parsed, StatKind, TableField};
use dcs_lua_syntax::token::{SpannedTrivia, Trivia};

use crate::strings::same_value;

/// Whether `printed` preserves the parse `before` (with `before_trivia`
/// from the same lex). False on any re-parse error, tree difference, or
/// lost comment.
#[must_use]
pub(crate) fn preserved(before: &Parsed, before_trivia: &[SpannedTrivia], printed: &str) -> bool {
    let lexed = dcs_lua_syntax::lexer::lex(printed);
    let comment_count_after = comment_count(&lexed.trivia);
    let after = dcs_lua_syntax::parser::parse_lexed(printed, lexed);
    if after
        .diagnostics
        .iter()
        .any(|d| d.severity == Severity::Error)
    {
        return false;
    }
    if comment_count(before_trivia) != comment_count_after {
        return false;
    }
    blocks_eq(
        &before.ast,
        before.chunk.body,
        &after.ast,
        after.chunk.body,
    )
}

fn comment_count(trivia: &[SpannedTrivia]) -> usize {
    trivia
        .iter()
        .filter(|t| !matches!(t.trivia, Trivia::BlankLines { .. }))
        .count()
}

fn blocks_eq(a: &Ast, ab: BlockId, b: &Ast, bb: BlockId) -> bool {
    let (left, right) = (a.block(ab), b.block(bb));
    left.stats.len() == right.stats.len()
        && left
            .stats
            .iter()
            .zip(&right.stats)
            .all(|(&l, &r)| stats_eq(a, b, &a.stat(l).kind, &b.stat(r).kind))
}

fn stats_eq(a: &Ast, b: &Ast, left: &StatKind, right: &StatKind) -> bool {
    match (left, right) {
        (
            StatKind::Assign {
                targets: lt,
                values: lv,
            },
            StatKind::Assign {
                targets: rt,
                values: rv,
            },
        ) => exprs_eq(a, b, lt, rt) && exprs_eq(a, b, lv, rv),
        (
            StatKind::LocalAssign {
                names: ln,
                values: lv,
            },
            StatKind::LocalAssign {
                names: rn,
                values: rv,
            },
        ) => names_eq(ln, rn) && exprs_eq(a, b, lv, rv),
        (StatKind::CallStat { call: l }, StatKind::CallStat { call: r }) => expr_eq(a, b, *l, *r),
        (StatKind::Do { body: l }, StatKind::Do { body: r }) => blocks_eq(a, *l, b, *r),
        (
            StatKind::While { cond: lc, body: lb },
            StatKind::While { cond: rc, body: rb },
        )
        | (
            StatKind::Repeat { cond: lc, body: lb },
            StatKind::Repeat { cond: rc, body: rb },
        ) => expr_eq(a, b, *lc, *rc) && blocks_eq(a, *lb, b, *rb),
        (
            StatKind::If {
                arms: la,
                else_body: le,
            },
            StatKind::If {
                arms: ra,
                else_body: re,
            },
        ) => {
            la.len() == ra.len()
                && la.iter().zip(ra).all(|(l, r)| {
                    expr_eq(a, b, l.cond, r.cond) && blocks_eq(a, l.body, b, r.body)
                })
                && match (le, re) {
                    (Some(l), Some(r)) => blocks_eq(a, *l, b, *r),
                    (None, None) => true,
                    _ => false,
                }
        }
        (StatKind::NumericFor { .. }, StatKind::NumericFor { .. }) => {
            numeric_for_eq(a, b, left, right)
        }
        (
            StatKind::GenericFor {
                names: ln,
                exprs: le,
                body: lb,
            },
            StatKind::GenericFor {
                names: rn,
                exprs: re,
                body: rb,
            },
        ) => names_eq(ln, rn) && exprs_eq(a, b, le, re) && blocks_eq(a, *lb, b, *rb),
        (
            StatKind::FunctionDecl { name: ln, func: lf },
            StatKind::FunctionDecl { name: rn, func: rf },
        ) => {
            names_eq(&ln.segments, &rn.segments)
                && match (&ln.method, &rn.method) {
                    (Some(l), Some(r)) => l.text == r.text,
                    (None, None) => true,
                    _ => false,
                }
                && funcs_eq(a, b, lf, rf)
        }
        (
            StatKind::LocalFunction { name: ln, func: lf },
            StatKind::LocalFunction { name: rn, func: rf },
        ) => ln.text == rn.text && funcs_eq(a, b, lf, rf),
        (StatKind::Return { values: l }, StatKind::Return { values: r }) => exprs_eq(a, b, l, r),
        (StatKind::Break, StatKind::Break) => true,
        _ => false,
    }
}

fn numeric_for_eq(a: &Ast, b: &Ast, left: &StatKind, right: &StatKind) -> bool {
    let (
        StatKind::NumericFor {
            name: ln,
            low: ll,
            high: lh,
            step: ls,
            body: lb,
        },
        StatKind::NumericFor {
            name: rn,
            low: rl,
            high: rh,
            step: rs,
            body: rb,
        },
    ) = (left, right)
    else {
        return false;
    };
    ln.text == rn.text
        && expr_eq(a, b, *ll, *rl)
        && expr_eq(a, b, *lh, *rh)
        && match (ls, rs) {
            (Some(l), Some(r)) => expr_eq(a, b, *l, *r),
            (None, None) => true,
            _ => false,
        }
        && blocks_eq(a, *lb, b, *rb)
}

fn names_eq(l: &[dcs_lua_syntax::ast::Name], r: &[dcs_lua_syntax::ast::Name]) -> bool {
    l.len() == r.len() && l.iter().zip(r).all(|(a, b)| a.text == b.text)
}

fn funcs_eq(a: &Ast, b: &Ast, l: &FuncBody, r: &FuncBody) -> bool {
    names_eq(&l.params, &r.params)
        && l.is_vararg == r.is_vararg
        && blocks_eq(a, l.body, b, r.body)
}

fn exprs_eq(a: &Ast, b: &Ast, l: &[ExprId], r: &[ExprId]) -> bool {
    l.len() == r.len() && l.iter().zip(r).all(|(&le, &re)| expr_eq(a, b, le, re))
}

fn expr_eq(a: &Ast, b: &Ast, le: ExprId, re: ExprId) -> bool {
    match (&a.expr(le).kind, &b.expr(re).kind) {
        (ExprKind::Nil, ExprKind::Nil)
        | (ExprKind::True, ExprKind::True)
        | (ExprKind::False, ExprKind::False)
        | (ExprKind::Vararg, ExprKind::Vararg)
        | (ExprKind::Missing, ExprKind::Missing) => true,
        (ExprKind::Number { raw: l }, ExprKind::Number { raw: r })
        | (ExprKind::NameRef(l), ExprKind::NameRef(r)) => l == r,
        (ExprKind::Str { raw: l }, ExprKind::Str { raw: r }) => same_value(l, r),
        (ExprKind::Function(l), ExprKind::Function(r)) => funcs_eq(a, b, l, r),
        (
            ExprKind::Field { obj: lo, name: ln },
            ExprKind::Field { obj: ro, name: rn },
        ) => ln.text == rn.text && expr_eq(a, b, *lo, *ro),
        (
            ExprKind::Index { obj: lo, key: lk },
            ExprKind::Index { obj: ro, key: rk },
        ) => expr_eq(a, b, *lo, *ro) && expr_eq(a, b, *lk, *rk),
        (
            ExprKind::Call {
                callee: lc,
                args: la,
            },
            ExprKind::Call {
                callee: rc,
                args: ra,
            },
        ) => expr_eq(a, b, *lc, *rc) && exprs_eq(a, b, la, ra),
        (
            ExprKind::MethodCall {
                obj: lo,
                method: lm,
                args: la,
            },
            ExprKind::MethodCall {
                obj: ro,
                method: rm,
                args: ra,
            },
        ) => lm.text == rm.text && expr_eq(a, b, *lo, *ro) && exprs_eq(a, b, la, ra),
        (ExprKind::Paren(l), ExprKind::Paren(r)) => expr_eq(a, b, *l, *r),
        (ExprKind::Table { fields: l }, ExprKind::Table { fields: r }) => {
            l.len() == r.len()
                && l.iter().zip(r).all(|(lf, rf)| match (lf, rf) {
                    (TableField::Positional(lv), TableField::Positional(rv)) => {
                        expr_eq(a, b, *lv, *rv)
                    }
                    (
                        TableField::Named {
                            name: ln,
                            value: lv,
                        },
                        TableField::Named {
                            name: rn,
                            value: rv,
                        },
                    ) => ln.text == rn.text && expr_eq(a, b, *lv, *rv),
                    (
                        TableField::Keyed { key: lk, value: lv },
                        TableField::Keyed { key: rk, value: rv },
                    ) => expr_eq(a, b, *lk, *rk) && expr_eq(a, b, *lv, *rv),
                    _ => false,
                })
        }
        (
            ExprKind::Binary {
                op: lo,
                lhs: ll,
                rhs: lr,
            },
            ExprKind::Binary {
                op: ro,
                lhs: rl,
                rhs: rr,
            },
        ) => lo == ro && expr_eq(a, b, *ll, *rl) && expr_eq(a, b, *lr, *rr),
        (
            ExprKind::Unary {
                op: lo,
                operand: ll,
            },
            ExprKind::Unary {
                op: ro,
                operand: rl,
            },
        ) => lo == ro && expr_eq(a, b, *ll, *rl),
        _ => false,
    }
}
