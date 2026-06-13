//! Call-site type checking (SPEC.md §3.1, `param-type-mismatch`).
//!
//! Walks every call in a file; for a callee that resolves to a function
//! carrying `@param` types, infers each argument's type and reports
//! `param-type-mismatch` at the argument span when it is not [`assignable`] to the
//! declared parameter type. Conservative by construction: unresolved
//! callees, un-annotated parameters, generics, and `any` never flag.

use dcs_lua_syntax::ast::{Ast, ExprId, ExprKind, FuncBody};
use dcs_lua_syntax::diagnostic::{Severity, codes};
use dcs_lua_syntax::{Diagnostic, Type};

use crate::annot::block_at;
use crate::assignable::assignable;
use crate::infer::infer_type;
use crate::param_infer::param_types;
use crate::resolve::{Decl, resolve, resolve_dotted};
use crate::ty_table::TypeTable;
use crate::workspace::Workspace;

/// Every `param-type-mismatch` finding across the workspace, paired with its file path.
#[must_use]
pub fn check_types(workspace: &Workspace) -> Vec<(String, Diagnostic)> {
    let table = TypeTable::build(workspace);
    let mut findings = Vec::new();
    for (path, entry) in workspace.files() {
        check_file(workspace, path, entry, &table, &mut findings);
        crate::operands::check_operands(workspace, path, entry, &mut findings);
    }
    findings.sort_by(|a, b| (a.0.as_str(), a.1.span.start).cmp(&(b.0.as_str(), b.1.span.start)));
    tracing::debug!(findings = findings.len(), "type check");
    findings
}

fn check_file(
    workspace: &Workspace,
    path: &str,
    entry: &crate::workspace::FileEntry,
    table: &TypeTable,
    findings: &mut Vec<(String, Diagnostic)>,
) {
    let ast = &entry.parsed.ast;
    // A flat arena walk visits every call expression in the file.
    for expr in &ast.exprs {
        let ExprKind::Call { callee, args } = &expr.kind else {
            continue;
        };
        let Some((func, decl_start, decl_path)) = callee_function(workspace, path, *callee) else {
            continue;
        };
        let Some(func_entry) = workspace.file(&decl_path) else {
            continue;
        };
        let block = block_at(func_entry, decl_start);
        // Body-usage parameter types, for the un-annotated (`param-usage-mismatch`) path.
        // `param_types` is annotation-first, so an annotated slot keeps its
        // declared type — but those slots take the `param-type-mismatch` branch below.
        let usage = param_types(workspace, &decl_path, func, Some(decl_start));
        for (position, &arg) in args.iter().enumerate() {
            let Some(param) = func.params.get(position) else {
                break;
            };
            let name = param.text.as_str();
            let arg_ty = infer_type(workspace, path, arg);
            let arg_span = ast.expr(arg).span;

            if let Some(declared) = block.param_type(name) {
                // `param-type-mismatch` — a declared `@param` is violated (Error).
                if is_checkable(&declared.ty) && !assignable(&arg_ty, &declared.ty, table) {
                    findings.push((
                        path.to_string(),
                        Diagnostic {
                            severity: Severity::Error,
                            span: arg_span,
                            code: codes::ARGUMENT_TYPE_MISMATCH,
                            code_description: "",
                            message: format!(
                                "argument of type `{}` is not assignable to parameter `{}` of type `{}`",
                                arg_ty.render(),
                                name,
                                declared.ty.render()
                            ),
                        },
                    ));
                }
            } else if let Some(usage_ty) = usage.get(position).and_then(Option::as_ref) {
                // `param-usage-mismatch` — the parameter is un-annotated, but its body uses
                // imply a type the argument conflicts with (Warning).
                if is_checkable(usage_ty) && !assignable(&arg_ty, usage_ty, table) && !coerces(ast, arg, usage_ty) {
                    findings.push((
                        path.to_string(),
                        Diagnostic {
                            severity: Severity::Warning,
                            span: arg_span,
                            code: codes::ARGUMENT_USAGE_MISMATCH,
                            code_description: "",
                            message: format!(
                                "argument of type `{}` conflicts with parameter `{}`, used as `{}` in the body",
                                arg_ty.render(),
                                name,
                                usage_ty.render()
                            ),
                        },
                    ));
                }
            }
        }
    }
}

/// Whether `arg` coerces into `usage_ty` despite not being formally
/// assignable: a numeric string literal satisfies a `number`-typed use, the
/// way Lua coerces `"10" + 5`.
fn coerces(ast: &Ast, arg: ExprId, usage_ty: &Type) -> bool {
    matches!(usage_ty, Type::Number)
        && matches!(
            &ast.expr(arg).kind,
            ExprKind::Str { raw } if crate::operands::numeric_string_literal(raw)
        )
}

/// The function declaration `callee` resolves to: its body, its declaration
/// start (the `@param`/usage-inference anchor), and the path of the file
/// declaring it. `None` when the callee is not a resolvable function.
fn callee_function<'ws>(
    workspace: &'ws Workspace,
    path: &str,
    callee: ExprId,
) -> Option<(&'ws FuncBody, u32, String)> {
    let entry = workspace.file(path)?;
    let ast = &entry.parsed.ast;
    let (decl_path, decl) = match &ast.expr(callee).kind {
        ExprKind::NameRef(name) => {
            let offset = ast.expr(callee).span.start;
            resolve(workspace, path, name, offset)?
        }
        ExprKind::Field { .. } => {
            let dotted = dotted_of(ast, callee)?;
            resolve_dotted(workspace, path, &dotted)?
        }
        _ => return None,
    };
    let (func, decl_start): (&'ws FuncBody, u32) = match &decl {
        Decl::LocalFunction { func, stat_start, .. }
        | Decl::GlobalFunction { func, stat_start, .. } => (func, *stat_start),
        _ => return None,
    };
    Some((func, decl_start, decl_path))
}

/// Only concrete declared types gate a diagnostic; wildcards and generics
/// never flag (the conservative rule).
fn is_checkable(ty: &Type) -> bool {
    !matches!(ty, Type::Any | Type::Unknown | Type::Generic(_))
}

fn dotted_of(ast: &Ast, expr: ExprId) -> Option<String> {
    match &ast.expr(expr).kind {
        ExprKind::NameRef(name) => Some(name.clone()),
        ExprKind::Field { obj, name } => Some(format!("{}.{}", dotted_of(ast, *obj)?, name.text)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ws(src: &str) -> Workspace {
        let mut ws = Workspace::new();
        ws.set_source("main.lua", src);
        ws
    }

    const LOG: &str = "--- @param msg string\nlocal function log(msg) end\n";

    #[test]
    fn number_to_string_param_flags() {
        let ws = ws(&format!("{LOG}log(1)\n"));
        let findings = check_types(&ws);
        assert_eq!(findings.len(), 1, "{findings:?}");
        assert_eq!(findings[0].1.code, codes::ARGUMENT_TYPE_MISMATCH);
    }

    #[test]
    fn string_to_string_param_is_clean() {
        let ws = ws(&format!("{LOG}log(\"hi\")\n"));
        assert!(check_types(&ws).is_empty());
    }

    #[test]
    fn unannotated_param_never_flags() {
        let ws = ws("local function f(x) end\nf(1)\nf('s')\n");
        assert!(check_types(&ws).is_empty());
    }

    #[test]
    fn unresolved_callee_never_flags() {
        let ws = ws("undefined_fn(1, 2, 3)\n");
        assert!(check_types(&ws).is_empty());
    }

    #[test]
    fn string_variable_arg_flags_against_number_param() {
        let src = "--- @param n number\nlocal function f(n) end\nlocal s = 'x'\nf(s)\n";
        let ws = ws(src);
        let findings = check_types(&ws);
        assert_eq!(findings.len(), 1, "{findings:?}");
    }

    /// Inlay-hint parameter inference must stay isolated from call checking:
    /// a parameter passed straight to an annotated callee keeps inferring as
    /// `Unknown` here (never the body-witnessed type), so it never flags.
    #[test]
    fn parameter_passed_to_annotated_callee_never_flags() {
        let src =
            "--- @param n number\nlocal function g(n) end\nlocal function f(p) g(p) p:upper() end\n";
        assert!(check_types(&ws(src)).is_empty());
    }

    // ---- param-usage-mismatch: argument vs. un-annotated parameter body usage ----------

    fn codes_of(src: &str) -> Vec<&'static str> {
        check_types(&ws(src)).into_iter().map(|(_, d)| d.code).collect()
    }

    #[test]
    fn string_arg_to_numerically_used_param_warns() {
        // `p` is used as `p + 1`, so a string argument conflicts (Warning).
        let src = "local function f(p) return p + 1 end\nf('x')\n";
        let findings = check_types(&ws(src));
        assert_eq!(findings.len(), 1, "{findings:?}");
        assert_eq!(findings[0].1.code, codes::ARGUMENT_USAGE_MISMATCH);
        assert_eq!(findings[0].1.severity, Severity::Warning);
    }

    #[test]
    fn number_arg_to_numerically_used_param_is_clean() {
        assert!(check_types(&ws("local function f(p) return p + 1 end\nf(5)\n")).is_empty());
    }

    #[test]
    fn numeric_string_literal_arg_coerces_and_is_clean() {
        // Lua coerces `"10" + 1`, so passing "10" to a number-used param is ok.
        assert!(check_types(&ws("local function f(p) return p + 1 end\nf('10')\n")).is_empty());
    }

    #[test]
    fn number_arg_to_string_used_param_warns() {
        let src = "local function g(s) return s:upper() end\ng(5)\n";
        assert_eq!(codes_of(src), vec![codes::ARGUMENT_USAGE_MISMATCH]);
    }

    #[test]
    fn param_with_no_inferable_usage_never_warns() {
        // `x` is just returned — usage type is `Unknown`, so nothing flags.
        assert!(check_types(&ws("local function h(x) return x end\nh(5)\nh('s')\n")).is_empty());
    }

    #[test]
    fn annotated_param_stays_t001_not_t003() {
        // An annotated param uses the declared type and the Error code.
        let src = "--- @param n number\nlocal function f(n) end\nf('x')\n";
        let findings = check_types(&ws(src));
        assert_eq!(findings.len(), 1, "{findings:?}");
        assert_eq!(findings[0].1.code, codes::ARGUMENT_TYPE_MISMATCH);
        assert_eq!(findings[0].1.severity, Severity::Error);
    }
}
