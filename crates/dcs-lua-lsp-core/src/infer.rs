//! Typed inference: `expression -> Type`.
//!
//! Extends the shallow literal/operator inference hover uses with three
//! resolution-backed steps: an identifier takes its declaration's `@type`/
//! `@param` annotation (else its initializer's type), a call takes the
//! callee's first `@return` type, and everything unresolved stays
//! [`Type::Unknown`] so the checker never false-positives.

use dcs_lua_syntax::Type;
use dcs_lua_syntax::ast::{Ast, BinOp, ExprId, ExprKind, Name, TableField, UnOp};

use crate::annot::block_at;
use crate::resolve::{Decl, resolve, resolve_dotted};
use crate::workspace::Workspace;

/// A small recursion budget: guards `local x = x`-style cycles and keeps
/// inference cheap. Beyond it, the type is `Unknown`.
const MAX_DEPTH: u32 = 8;

/// The inferred type of expression `expr` in `path`.
#[must_use]
pub fn infer_type(workspace: &Workspace, path: &str, expr: ExprId) -> Type {
    infer(workspace, path, expr, 0)
}

/// The `name = value` fields of a table-constructor expression, in source
/// order — the structural field set a `{ … }` literal carries but the opaque
/// [`Type::Table`] inference above discards. `None` when `expr` is not a table
/// constructor, so a caller can tell "not a literal" from `{}` (an empty but
/// real table). Positional and `[expr]`-keyed entries are skipped: only a
/// `name = value` field is reachable as `recv.name`.
#[must_use]
pub fn table_literal_fields(ast: &Ast, expr: ExprId) -> Option<Vec<(&Name, ExprId)>> {
    let ExprKind::Table { fields } = &ast.expr(expr).kind else {
        return None;
    };
    Some(
        fields
            .iter()
            .filter_map(|field| match field {
                TableField::Named { name, value } => Some((name, *value)),
                TableField::Positional(_) | TableField::Keyed { .. } => None,
            })
            .collect(),
    )
}

fn infer(workspace: &Workspace, path: &str, expr: ExprId, depth: u32) -> Type {
    if depth >= MAX_DEPTH {
        return Type::Unknown;
    }
    let Some(entry) = workspace.file(path) else {
        return Type::Unknown;
    };
    let ast = &entry.parsed.ast;
    match &ast.expr(expr).kind {
        ExprKind::Nil => Type::Nil,
        ExprKind::True | ExprKind::False => Type::Boolean,
        ExprKind::Number { .. } => Type::Number,
        ExprKind::Str { .. } => Type::String,
        ExprKind::Table { .. } => Type::Table,
        ExprKind::Function(func) => Type::Function {
            params: func.params.iter().map(|_| Type::Any).collect(),
            ret: Vec::new(),
        },
        ExprKind::Paren(inner) => infer(workspace, path, *inner, depth + 1),
        ExprKind::Binary { op, .. } => binary_type(*op),
        ExprKind::Unary { op, .. } => match op {
            UnOp::Not => Type::Boolean,
            UnOp::Len | UnOp::Neg => Type::Number,
        },
        ExprKind::NameRef(name) => {
            let offset = ast.expr(expr).span.start;
            resolve(workspace, path, name, offset)
                .map_or(Type::Unknown, |(decl_path, decl)| {
                    decl_type(workspace, &decl_path, &decl, depth)
                })
        }
        ExprKind::Call { callee, .. } => call_return_type(workspace, path, *callee, depth),
        ExprKind::Field { .. } => {
            // Field access resolves through the dotted-global path; its type
            // comes from the target declaration's annotation when known.
            field_type(workspace, path, expr, depth)
        }
        _ => Type::Unknown,
    }
}

fn binary_type(op: BinOp) -> Type {
    match op {
        BinOp::Add | BinOp::Sub | BinOp::Mul | BinOp::Div | BinOp::Mod | BinOp::Pow => Type::Number,
        BinOp::Concat => Type::String,
        BinOp::Eq | BinOp::Ne | BinOp::Lt | BinOp::Gt | BinOp::Le | BinOp::Ge => Type::Boolean,
        // `and`/`or` short-circuit to either operand — not modelled.
        BinOp::And | BinOp::Or => Type::Unknown,
    }
}

/// The type a declaration carries: its `@type` annotation first, then its
/// initializer's inferred type. Parameters fall back to `Unknown` (their
/// `@param` type is only known at the call site, not from the use site).
fn decl_type(workspace: &Workspace, decl_path: &str, decl: &Decl<'_>, depth: u32) -> Type {
    let Some(entry) = workspace.file(decl_path) else {
        return Type::Unknown;
    };
    match decl {
        Decl::Local { value, stat_start, .. } | Decl::GlobalAssign { value, stat_start, .. } => {
            let block = block_at(entry, *stat_start);
            if let Some(ty) = block.var_type {
                return ty;
            }
            value.map_or(Type::Nil, |v| infer(workspace, decl_path, v, depth + 1))
        }
        Decl::NumericFor { .. } => Type::Number,
        Decl::LocalFunction { func, .. } | Decl::GlobalFunction { func, .. } => Type::Function {
            params: func.params.iter().map(|_| Type::Any).collect(),
            ret: Vec::new(),
        },
        Decl::Param { .. } | Decl::GenericFor { .. } => Type::Unknown,
    }
}

/// The result type of calling `callee`: the callee declaration's first
/// `@return` type, or `Unknown`.
fn call_return_type(workspace: &Workspace, path: &str, callee: ExprId, _depth: u32) -> Type {
    let Some(entry) = workspace.file(path) else {
        return Type::Unknown;
    };
    let ast = &entry.parsed.ast;
    let resolved = match &ast.expr(callee).kind {
        ExprKind::NameRef(name) => {
            let offset = ast.expr(callee).span.start;
            resolve(workspace, path, name, offset)
        }
        ExprKind::Field { .. } => {
            dotted_of(ast, callee).and_then(|d| resolve_dotted(workspace, path, &d))
        }
        _ => None,
    };
    resolved
        .and_then(|(decl_path, decl)| return_type_of(workspace, &decl_path, &decl))
        .unwrap_or(Type::Unknown)
}

/// The first `@return` type declared on a function declaration.
fn return_type_of(workspace: &Workspace, decl_path: &str, decl: &Decl<'_>) -> Option<Type> {
    let entry = workspace.file(decl_path)?;
    let start = match decl {
        Decl::LocalFunction { stat_start, .. } | Decl::GlobalFunction { stat_start, .. } => {
            *stat_start
        }
        _ => return None,
    };
    block_at(entry, start).returns.into_iter().next()
}

/// The type of a field-access expression, via its dotted-global target.
fn field_type(workspace: &Workspace, path: &str, expr: ExprId, depth: u32) -> Type {
    let Some(entry) = workspace.file(path) else {
        return Type::Unknown;
    };
    let ast = &entry.parsed.ast;
    let Some(dotted) = dotted_of(ast, expr) else {
        return Type::Unknown;
    };
    resolve_dotted(workspace, path, &dotted).map_or(Type::Unknown, |(decl_path, decl)| {
        decl_type(workspace, &decl_path, &decl, depth)
    })
}

/// Render a `Field`/`NameRef` chain as a dotted path (`a.b.c`).
fn dotted_of(ast: &Ast, expr: ExprId) -> Option<String> {
    match &ast.expr(expr).kind {
        ExprKind::NameRef(name) => Some(name.clone()),
        ExprKind::Field { obj, name } => Some(format!("{}.{}", dotted_of(ast, *obj)?, name.text)),
        _ => None,
    }
}
