//! Call-site type checking (SPEC.md §3.1, `LUA-T001`).
//!
//! Walks every call in a file; for a callee that resolves to a function
//! carrying `@param` types, infers each argument's type and reports
//! `LUA-T001` at the argument span when it is not [`assignable`] to the
//! declared parameter type. Conservative by construction: unresolved
//! callees, un-annotated parameters, generics, and `any` never flag.

use dcs_lua_syntax::ast::{Ast, ExprId, ExprKind, FuncBody};
use dcs_lua_syntax::diagnostic::{Severity, codes};
use dcs_lua_syntax::{Diagnostic, Type};

use crate::annot::block_at;
use crate::assignable::assignable;
use crate::infer::infer_type;
use crate::resolve::{Decl, resolve, resolve_dotted};
use crate::ty_table::TypeTable;
use crate::workspace::Workspace;

/// Every `LUA-T001` finding across the workspace, paired with its file path.
#[must_use]
pub fn check_types(workspace: &Workspace) -> Vec<(String, Diagnostic)> {
    let table = TypeTable::build(workspace);
    let mut findings = Vec::new();
    for (path, entry) in workspace.files() {
        check_file(workspace, path, entry, &table, &mut findings);
    }
    findings.sort_by(|a, b| (a.0.as_str(), a.1.span.start).cmp(&(b.0.as_str(), b.1.span.start)));
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
        let Some((params, decl_path)) = callee_params(workspace, path, *callee) else {
            continue;
        };
        let Some(func_entry) = workspace.file(&decl_path) else {
            continue;
        };
        let block = block_at(func_entry, params.decl_start);
        if block.params.is_empty() {
            continue;
        }
        for (position, &arg) in args.iter().enumerate() {
            let Some(param_name) = params.names.get(position) else {
                break;
            };
            let Some(param) = block.param_type(param_name) else {
                continue;
            };
            if !is_checkable(&param.ty) {
                continue;
            }
            let arg_ty = infer_type(workspace, path, arg);
            if !assignable(&arg_ty, &param.ty, table) {
                findings.push((
                    path.to_string(),
                    Diagnostic {
                        severity: Severity::Error,
                        span: ast.expr(arg).span,
                        code: codes::ARGUMENT_TYPE_MISMATCH,
                        code_description: "",
                        message: format!(
                            "argument of type `{}` is not assignable to parameter `{}` of type `{}`",
                            arg_ty.render(),
                            param_name,
                            param.ty.render()
                        ),
                    },
                ));
            }
        }
    }
}

/// The parameter names of the function `callee` resolves to, plus the path
/// of the file declaring it. `None` when the callee is not a resolvable
/// function declaration.
struct Params {
    names: Vec<String>,
    decl_start: u32,
}

fn callee_params(workspace: &Workspace, path: &str, callee: ExprId) -> Option<(Params, String)> {
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
    let (func, decl_start): (&FuncBody, u32) = match &decl {
        Decl::LocalFunction { func, stat_start, .. }
        | Decl::GlobalFunction { func, stat_start, .. } => (func, *stat_start),
        _ => return None,
    };
    Some((
        Params {
            names: func.params.iter().map(|n| n.text.clone()).collect(),
            decl_start,
        },
        decl_path,
    ))
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
}
