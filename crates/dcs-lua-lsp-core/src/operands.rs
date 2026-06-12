//! Operator/operand type checking (`operator-type-mismatch`, SPEC.md §3.1).
//!
//! Flags an operator applied to an operand whose inferred type cannot fit it:
//! arithmetic or `#` on a table/boolean/nil/function, arithmetic on a
//! non-numeric string, concatenation of a table/boolean/nil/function. These
//! are **Warnings**, not Errors — Lua 5.1 coerces numeric strings in
//! arithmetic and numbers in concatenation, and a metamethod may overload an
//! operator, so a flagged operation is "very likely wrong", not illegal. A
//! numeric string literal (`"10" + 5`) is accepted; `any`/`unknown`/generics,
//! and anything the engine could not infer, never flag.

use dcs_lua_syntax::ast::{BinOp, ExprId, ExprKind, UnOp};
use dcs_lua_syntax::diagnostic::{Severity, codes};
use dcs_lua_syntax::{Diagnostic, Type};

use crate::infer::infer_type;
use crate::workspace::{FileEntry, Workspace};

/// What an operand is being used as — drives the message and the plausibility
/// rule.
#[derive(Clone, Copy)]
enum OperandRole {
    Arithmetic,
    Concat,
    Length,
}

impl OperandRole {
    fn verb(self) -> &'static str {
        match self {
            OperandRole::Arithmetic => "perform arithmetic on",
            OperandRole::Concat => "concatenate",
            OperandRole::Length => "get the length of",
        }
    }
}

/// Append every `operator-type-mismatch` finding in `path` to `findings`.
pub(crate) fn check_operands(
    workspace: &Workspace,
    path: &str,
    entry: &FileEntry,
    findings: &mut Vec<(String, Diagnostic)>,
) {
    let ast = &entry.parsed.ast;
    // A flat arena walk visits every operator expression in the file.
    for expr in &ast.exprs {
        match &expr.kind {
            ExprKind::Binary { op, lhs, rhs } => {
                let Some(role) = binary_use(*op) else { continue };
                check_operand(workspace, path, *lhs, role, findings);
                check_operand(workspace, path, *rhs, role, findings);
            }
            ExprKind::Unary { op, operand } => match op {
                UnOp::Neg => check_operand(workspace, path, *operand, OperandRole::Arithmetic, findings),
                UnOp::Len => check_operand(workspace, path, *operand, OperandRole::Length, findings),
                UnOp::Not => {}
            },
            _ => {}
        }
    }
}

/// The operand role an operator imposes, or `None` for operators that accept
/// any operand (comparisons, `and`/`or`).
fn binary_use(op: BinOp) -> Option<OperandRole> {
    match op {
        BinOp::Add | BinOp::Sub | BinOp::Mul | BinOp::Div | BinOp::Mod | BinOp::Pow => {
            Some(OperandRole::Arithmetic)
        }
        BinOp::Concat => Some(OperandRole::Concat),
        _ => None,
    }
}

fn check_operand(
    workspace: &Workspace,
    path: &str,
    operand: ExprId,
    role: OperandRole,
    findings: &mut Vec<(String, Diagnostic)>,
) {
    let Some(entry) = workspace.file(path) else {
        return;
    };
    let expr = entry.parsed.ast.expr(operand);

    // A string literal in arithmetic: accepted iff its content is numeric
    // (Lua coerces `"10" + 5`), otherwise flagged as a non-numeric string.
    if let (OperandRole::Arithmetic, ExprKind::Str { raw }) = (role, &expr.kind) {
        if !numeric_string_literal(raw) {
            push(findings, path, expr.span, role, "string");
        }
        return;
    }

    let ty = infer_type(workspace, path, operand);
    if !fits(&ty, role) {
        push(findings, path, expr.span, role, &ty.render());
    }
}

/// Whether `ty` can plausibly stand in for the operand role. Wildcards and
/// anything uninferred (`Unknown`) pass — the check only fires on a concrete,
/// provably-unfit type.
fn fits(ty: &Type, role: OperandRole) -> bool {
    match ty {
        Type::Any | Type::Unknown | Type::Generic(_) => true,
        Type::Union(members) => members.iter().any(|m| fits(m, role)),
        Type::Optional(inner) => fits(inner, role),
        _ => match role {
            // Arithmetic coerces numbers; a string is handled at the operand
            // level (numeric-literal carve-out), so a general string type here
            // does not fit.
            OperandRole::Arithmetic => matches!(ty, Type::Number | Type::LiteralNumber(_)),
            // Concatenation coerces both strings and numbers.
            OperandRole::Concat => matches!(
                ty,
                Type::String | Type::LiteralString(_) | Type::Number | Type::LiteralNumber(_)
            ),
            // Length applies to strings and table-likes (incl. class instances,
            // which may be array-like or carry `__len`).
            OperandRole::Length => matches!(
                ty,
                Type::String
                    | Type::LiteralString(_)
                    | Type::Table
                    | Type::Array(_)
                    | Type::Dict { .. }
                    | Type::Named(_)
            ),
        },
    }
}

fn push(
    findings: &mut Vec<(String, Diagnostic)>,
    path: &str,
    span: dcs_lua_syntax::span::Span,
    role: OperandRole,
    label: &str,
) {
    findings.push((
        path.to_string(),
        Diagnostic {
            severity: Severity::Warning,
            span,
            code: codes::OPERATOR_TYPE_MISMATCH,
            code_description: "",
            message: format!("cannot {} a `{label}` value", role.verb()),
        },
    ));
}

/// Whether the source of a string literal (quotes included) holds a number Lua
/// would coerce in arithmetic — a decimal/float/exponent, or `0x` hex.
pub(crate) fn numeric_string_literal(raw: &str) -> bool {
    let inner = string_content(raw).trim();
    if inner.is_empty() {
        return false;
    }
    if let Some(hex) = inner
        .strip_prefix("0x")
        .or_else(|| inner.strip_prefix("0X"))
    {
        return !hex.is_empty() && i64::from_str_radix(hex, 16).is_ok();
    }
    inner.parse::<f64>().is_ok()
}

/// The text inside a string literal's delimiters (best-effort; the value is
/// only inspected for numeric content, so escape decoding is unnecessary).
fn string_content(raw: &str) -> &str {
    if let Some(rest) = raw.strip_prefix('"').and_then(|s| s.strip_suffix('"')) {
        return rest;
    }
    if let Some(rest) = raw.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')) {
        return rest;
    }
    // Long-bracket strings (`[[ … ]]`) are never numeric; return as-is.
    raw
}

#[cfg(test)]
mod tests {
    use super::*;

    fn warnings(src: &str) -> Vec<String> {
        let mut ws = Workspace::new();
        ws.set_source("main.lua", src);
        let entry = ws.file("main.lua").unwrap();
        let mut findings = Vec::new();
        // SAFETY of borrow: read-only; clone the entry handle via the workspace.
        check_operands(&ws, "main.lua", entry, &mut findings);
        findings.into_iter().map(|(_, d)| d.message).collect()
    }

    #[test]
    fn arithmetic_on_string_literal_flags() {
        assert_eq!(
            warnings("local x = 'hi' + 1\n"),
            vec!["cannot perform arithmetic on a `string` value"]
        );
    }

    #[test]
    fn numeric_string_literal_in_arithmetic_is_allowed() {
        assert!(warnings("local x = '10' + 5\n").is_empty());
        assert!(warnings("local x = '0x1A' + 1\n").is_empty());
        assert!(warnings("local x = '3.14' * 2\n").is_empty());
    }

    #[test]
    fn arithmetic_on_table_flags() {
        assert_eq!(
            warnings("local x = {} + 1\n"),
            vec!["cannot perform arithmetic on a `table` value"]
        );
    }

    #[test]
    fn concat_with_table_flags() {
        assert_eq!(
            warnings("local x = 'a' .. {}\n"),
            vec!["cannot concatenate a `table` value"]
        );
    }

    #[test]
    fn concat_with_number_is_allowed() {
        assert!(warnings("local x = 'a' .. 1\n").is_empty());
        assert!(warnings("local x = 1 .. 'a'\n").is_empty());
    }

    #[test]
    fn length_of_number_flags() {
        assert_eq!(
            warnings("local x = #42\n"),
            vec!["cannot get the length of a `number` value"]
        );
    }

    #[test]
    fn length_of_string_or_table_is_allowed() {
        assert!(warnings("local x = #'abc'\n").is_empty());
        assert!(warnings("local x = #({})\n").is_empty());
    }

    #[test]
    fn arithmetic_on_boolean_flags() {
        assert_eq!(
            warnings("local x = true + 1\n"),
            vec!["cannot perform arithmetic on a `boolean` value"]
        );
    }

    #[test]
    fn unary_minus_on_string_flags() {
        assert_eq!(
            warnings("local x = -'hi'\n"),
            vec!["cannot perform arithmetic on a `string` value"]
        );
    }

    #[test]
    fn typed_local_string_in_arithmetic_flags() {
        // A string-typed variable (not a literal) in arithmetic is flagged.
        assert_eq!(
            warnings("local s = 'x'\nlocal y = s + 1\n"),
            vec!["cannot perform arithmetic on a `string` value"]
        );
    }

    #[test]
    fn uninferred_operands_never_flag() {
        // A call result and an un-annotated parameter are `Unknown` — no flag.
        assert!(warnings("local x = some_call() + 1\n").is_empty());
        assert!(warnings("local function f(p) return p + 1 end\n").is_empty());
    }

    #[test]
    fn comparison_and_logical_never_flag() {
        assert!(warnings("local x = {} == 1\nlocal y = {} and 2\n").is_empty());
    }
}
