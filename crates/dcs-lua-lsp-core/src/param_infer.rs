//! Function-signature type inference for inlay hints.
//!
//! Bidirectional-typing flavoured (Pierce & Turner, *Local Type Inference*):
//! `infer.rs` is the synthesis judgment ("read a type off an expression");
//! here we add the checking direction for parameters — what their uses in the
//! body *require* — and a best-common-type join for the return.
//!
//! Per parameter, in priority order: (1) its `@param` annotation, (2) a
//! best-common-type over its uses in the body. Conservative throughout — a
//! parameter constrained two incompatible ways, one with no evidence, or one
//! reassigned/shadowed yields `None`, and the hint is simply omitted. An
//! absent hint is fine; a wrong one is not.
//!
//! This pass is deliberately isolated from `infer.rs::decl_type` (which keeps
//! returning `Unknown` for a parameter): making parameters concrete there
//! would let `check.rs` raise `param-type-mismatch` on un-annotated parameters, breaking
//! the conservative call-check contract.

use std::collections::HashMap;

use dcs_lua_syntax::Type;
use dcs_lua_syntax::ast::{Ast, BinOp, BlockId, ExprId, ExprKind, FuncBody, StatKind, TableField, UnOp};

use crate::annot::block_at;
use crate::infer::infer_type;
use crate::workspace::Workspace;

/// The Lua 5.1 `string` library methods — a method call on one of these names
/// witnesses a `string` receiver. No typed standard library exists in the
/// engine yet, so this small set is what powers `p:upper()` ⇒ `string`.
const STRING_METHODS: &[&str] = &[
    "upper", "lower", "sub", "rep", "reverse", "format", "gsub", "len", "byte", "find", "match",
    "gmatch",
];

fn is_string_method(name: &str) -> bool {
    STRING_METHODS.contains(&name)
}

/// The result type of a `string`-library method call, for return inference.
/// `find`/`match`/`gmatch` are multi-value or pattern-dependent — skipped.
fn string_method_return(name: &str) -> Option<Type> {
    match name {
        "upper" | "lower" | "sub" | "rep" | "reverse" | "format" | "gsub" => Some(Type::String),
        "len" | "byte" => Some(Type::Number),
        _ => None,
    }
}

/// The inferred type of each parameter of `func`, positionally. `None` =
/// omit the hint. `decl_start` is the declaration's byte offset (the doc-run
/// anchor for `@param` lookup); `None` for a function literal, which has no
/// annotation block.
#[must_use]
pub(crate) fn param_types(
    workspace: &Workspace,
    path: &str,
    func: &FuncBody,
    decl_start: Option<u32>,
) -> Vec<Option<Type>> {
    let Some(entry) = workspace.file(path) else {
        return vec![None; func.params.len()];
    };
    let ast = &entry.parsed.ast;

    // Usage pass: best-common-type witnessed by each parameter's body uses.
    let mut collector = Collector::new(ast, func);
    collector.walk_block(func.body);
    let usage = collector.finish();

    // Annotation overlay: an explicit `@param` wins; an explicit `any` opts
    // the parameter out of a hint entirely.
    let block = decl_start.map(|start| block_at(entry, start));
    func.params
        .iter()
        .enumerate()
        .map(|(position, name)| {
            if let Some(block) = &block
                && let Some(param) = block.param_type(&name.text)
            {
                return match param.ty {
                    Type::Unknown | Type::Any => None,
                    ref ty => Some(ty.clone()),
                };
            }
            usage[position].clone()
        })
        .collect()
}

/// The inferred return type of `func`: the best-common-type over the first
/// value of every `return` in the body (a `return` of a typed parameter
/// reuses that type). `None` when there are no returns, they conflict, or the
/// only outcome is `nil` (a `: nil` hint is never useful).
#[must_use]
pub(crate) fn return_type(
    workspace: &Workspace,
    path: &str,
    func: &FuncBody,
    params: &[Option<Type>],
) -> Option<Type> {
    let entry = workspace.file(path)?;
    let ast = &entry.parsed.ast;

    let mut firsts = Vec::new();
    collect_returns(ast, func.body, &mut firsts);

    let mut witnesses = Vec::new();
    for first in firsts {
        match first {
            // A bare `return` yields nil.
            None => witnesses.push(Type::Nil),
            Some(expr) => {
                let ty = return_expr_type(workspace, path, ast, expr, func, params);
                if !matches!(ty, Type::Unknown | Type::Any) {
                    witnesses.push(ty);
                }
            }
        }
    }

    match join(&witnesses)? {
        Type::Nil => None,
        ty => Some(ty),
    }
}

/// Returns `true` when the function provably never returns a value: either no
/// `return` statement exists in the body, or every `return` is bare (no expression).
/// Used to emit `: void` hints rather than silently omitting the return hint.
#[must_use]
pub(crate) fn is_void_return(workspace: &Workspace, path: &str, func: &FuncBody) -> bool {
    let Some(entry) = workspace.file(path) else { return false };
    let ast = &entry.parsed.ast;
    let mut firsts = Vec::new();
    collect_returns(ast, func.body, &mut firsts);
    firsts.is_empty() || firsts.iter().all(|f| f.is_none())
}

/// The type of a single `return` value expression, reusing an inferred
/// parameter type for a bare parameter reference and the string-method table
/// for a string-library call (neither of which `infer.rs` resolves).
fn return_expr_type(
    workspace: &Workspace,
    path: &str,
    ast: &Ast,
    expr: ExprId,
    func: &FuncBody,
    params: &[Option<Type>],
) -> Type {
    match &ast.expr(expr).kind {
        ExprKind::NameRef(name) => func
            .params
            .iter()
            .position(|param| param.text == *name)
            .and_then(|position| params[position].clone())
            .unwrap_or_else(|| infer_type(workspace, path, expr)),
        ExprKind::MethodCall { method, .. } => {
            string_method_return(&method.text).unwrap_or(Type::Unknown)
        }
        _ => infer_type(workspace, path, expr),
    }
}

/// The first value of every `return` reachable in `block` without crossing a
/// nested function boundary (`None` element = a bare `return`).
fn collect_returns(ast: &Ast, block: BlockId, out: &mut Vec<Option<ExprId>>) {
    for &stat_id in &ast.block(block).stats {
        match &ast.stat(stat_id).kind {
            StatKind::Return { values } => out.push(values.first().copied()),
            StatKind::Do { body }
            | StatKind::While { body, .. }
            | StatKind::Repeat { body, .. }
            | StatKind::NumericFor { body, .. }
            | StatKind::GenericFor { body, .. } => collect_returns(ast, *body, out),
            StatKind::If { arms, else_body } => {
                for arm in arms {
                    collect_returns(ast, arm.body, out);
                }
                if let Some(body) = else_body {
                    collect_returns(ast, *body, out);
                }
            }
            // Nested functions are a separate scope — their returns are not ours.
            _ => {}
        }
    }
}

/// The best-common-type of a witness set: drop `Unknown`/`Any`, then a single
/// remaining distinct type wins; an empty set or a conflict yields `None`.
fn join(types: &[Type]) -> Option<Type> {
    let mut concrete = types
        .iter()
        .filter(|ty| !matches!(ty, Type::Unknown | Type::Any));
    let first = concrete.next()?.clone();
    concrete.all(|ty| *ty == first).then_some(first)
}

// ---- usage witnesses -------------------------------------------------------

/// Per-parameter witness accumulator. `Tainted` marks a parameter that was
/// reassigned or shadowed — its narrowed type can't be tracked, so it is
/// dropped.
enum Witness {
    Open(Vec<Type>),
    Tainted,
}

struct Collector<'a> {
    ast: &'a Ast,
    /// Parameter name → its position. A duplicate name (`function(x, x)`)
    /// keeps the last, matching resolution's last-wins rule.
    index: HashMap<&'a str, usize>,
    witness: Vec<Witness>,
}

impl<'a> Collector<'a> {
    fn new(ast: &'a Ast, func: &'a FuncBody) -> Self {
        let mut index = HashMap::new();
        for (position, param) in func.params.iter().enumerate() {
            index.insert(param.text.as_str(), position);
        }
        let witness = (0..func.params.len()).map(|_| Witness::Open(Vec::new())).collect();
        Self { ast, index, witness }
    }

    fn finish(self) -> Vec<Option<Type>> {
        self.witness
            .into_iter()
            .map(|witness| match witness {
                Witness::Tainted => None,
                Witness::Open(types) => join(&types),
            })
            .collect()
    }

    /// Record that `expr`, if it is a bare parameter reference, must have type
    /// `ty`.
    fn constrain(&mut self, expr: ExprId, ty: &Type) {
        if let ExprKind::NameRef(name) = &self.ast.expr(expr).kind
            && let Some(&position) = self.index.get(name.as_str())
            && let Witness::Open(types) = &mut self.witness[position]
        {
            types.push(ty.clone());
        }
    }

    fn taint(&mut self, name: &str) {
        if let Some(&position) = self.index.get(name) {
            self.witness[position] = Witness::Tainted;
        }
    }

    fn walk_block(&mut self, block: BlockId) {
        for &stat_id in &self.ast.block(block).stats {
            self.walk_stat(stat_id);
        }
    }

    fn walk_stat(&mut self, stat_id: dcs_lua_syntax::ast::StatId) {
        match &self.ast.stat(stat_id).kind {
            StatKind::LocalAssign { names, values } => {
                for &value in values {
                    self.walk_expr(value);
                }
                // A `local` re-declaring a parameter name shadows it.
                for name in names {
                    self.taint(&name.text);
                }
            }
            StatKind::Assign { targets, values } => {
                for &target in targets {
                    match &self.ast.expr(target).kind {
                        // `p = ...` reassigns the parameter; we can't track it.
                        ExprKind::NameRef(name) => self.taint(name),
                        // `p.x = ...` / `p[k] = ...` use p as a table.
                        _ => self.walk_expr(target),
                    }
                }
                for &value in values {
                    self.walk_expr(value);
                }
            }
            StatKind::CallStat { call } => self.walk_expr(*call),
            StatKind::Do { body } => self.walk_block(*body),
            StatKind::While { cond, body } => {
                self.walk_expr(*cond);
                self.walk_block(*body);
            }
            StatKind::Repeat { body, cond } => {
                self.walk_block(*body);
                self.walk_expr(*cond);
            }
            StatKind::If { arms, else_body } => {
                for arm in arms {
                    self.walk_expr(arm.cond);
                    self.walk_block(arm.body);
                }
                if let Some(body) = else_body {
                    self.walk_block(*body);
                }
            }
            StatKind::NumericFor { name, low, high, step, body } => {
                self.walk_expr(*low);
                self.walk_expr(*high);
                if let Some(step) = step {
                    self.walk_expr(*step);
                }
                self.taint(&name.text);
                self.walk_block(*body);
            }
            StatKind::GenericFor { names, exprs, body } => {
                for &expr in exprs {
                    self.walk_expr(expr);
                }
                for name in names {
                    self.taint(&name.text);
                }
                self.walk_block(*body);
            }
            StatKind::Return { values } => {
                for &value in values {
                    self.walk_expr(value);
                }
            }
            // Nested functions are a separate scope — do not descend.
            StatKind::FunctionDecl { .. } | StatKind::LocalFunction { .. } | StatKind::Break => {}
        }
    }

    fn walk_expr(&mut self, expr: ExprId) {
        match &self.ast.expr(expr).kind {
            ExprKind::Binary { op, lhs, rhs } => {
                if let Some(ty) = binary_witness(*op) {
                    self.constrain(*lhs, &ty);
                    self.constrain(*rhs, &ty);
                }
                self.walk_expr(*lhs);
                self.walk_expr(*rhs);
            }
            ExprKind::Unary { op, operand } => {
                // `-p` ⇒ number; `#p` is string-or-table (ambiguous, skipped).
                if matches!(op, UnOp::Neg) {
                    self.constrain(*operand, &Type::Number);
                }
                self.walk_expr(*operand);
            }
            ExprKind::MethodCall { obj, method, args } => {
                let receiver = if is_string_method(&method.text) {
                    Type::String
                } else {
                    Type::Table
                };
                self.constrain(*obj, &receiver);
                self.walk_expr(*obj);
                for &arg in args {
                    self.walk_expr(arg);
                }
            }
            ExprKind::Field { obj, .. } => {
                self.constrain(*obj, &Type::Table);
                self.walk_expr(*obj);
            }
            ExprKind::Index { obj, key } => {
                self.constrain(*obj, &Type::Table);
                self.walk_expr(*obj);
                self.walk_expr(*key);
            }
            ExprKind::Call { callee, args } => {
                self.walk_expr(*callee);
                for &arg in args {
                    self.walk_expr(arg);
                }
            }
            ExprKind::Paren(inner) => self.walk_expr(*inner),
            ExprKind::Table { fields } => {
                for field in fields {
                    match field {
                        TableField::Positional(value) | TableField::Named { value, .. } => {
                            self.walk_expr(*value);
                        }
                        TableField::Keyed { key, value } => {
                            self.walk_expr(*key);
                            self.walk_expr(*value);
                        }
                    }
                }
            }
            // NameRef and literals constrain nothing on their own; a nested
            // `Function` literal is a separate scope we deliberately do not
            // descend (its uses of a same-named binding are not ours).
            _ => {}
        }
    }
}

/// The type a binary operator forces on its operands, if any.
fn binary_witness(op: BinOp) -> Option<Type> {
    match op {
        BinOp::Concat => Some(Type::String),
        BinOp::Add | BinOp::Sub | BinOp::Mul | BinOp::Div | BinOp::Mod | BinOp::Pow => {
            Some(Type::Number)
        }
        // Comparisons and `and`/`or` constrain nothing.
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dcs_lua_syntax::ast::StatKind;

    fn ws(src: &str) -> Workspace {
        let mut ws = Workspace::new();
        ws.set_source("main.lua", src);
        ws
    }

    /// The first `local function`'s body and statement start in `main.lua`.
    fn first_local_function(ws: &Workspace) -> (FuncBody, u32) {
        let entry = ws.file("main.lua").unwrap();
        for stat in &entry.parsed.ast.stats {
            if let StatKind::LocalFunction { func, .. } = &stat.kind {
                return (func.clone(), stat.span.start);
            }
        }
        panic!("no local function");
    }

    fn params(src: &str) -> Vec<Option<Type>> {
        let ws = ws(src);
        let (func, start) = first_local_function(&ws);
        param_types(&ws, "main.lua", &func, Some(start))
    }

    fn ret(src: &str) -> Option<Type> {
        let ws = ws(src);
        let (func, start) = first_local_function(&ws);
        let ps = param_types(&ws, "main.lua", &func, Some(start));
        return_type(&ws, "main.lua", &func, &ps)
    }

    #[test]
    fn concat_use_implies_string() {
        assert_eq!(params("local function f(p) return p .. 'x' end"), vec![Some(Type::String)]);
    }

    #[test]
    fn arithmetic_use_implies_number() {
        assert_eq!(params("local function f(p) return p + 1 end"), vec![Some(Type::Number)]);
    }

    #[test]
    fn string_method_receiver_implies_string() {
        assert_eq!(params("local function f(p) return p:upper() end"), vec![Some(Type::String)]);
    }

    #[test]
    fn unknown_method_receiver_implies_table() {
        assert_eq!(params("local function f(p) p:render() end"), vec![Some(Type::Table)]);
    }

    #[test]
    fn field_access_implies_table() {
        assert_eq!(params("local function f(p) return p.name end"), vec![Some(Type::Table)]);
    }

    #[test]
    fn index_access_implies_table() {
        assert_eq!(params("local function f(p) return p[1] end"), vec![Some(Type::Table)]);
    }

    #[test]
    fn conflicting_uses_omit_the_hint() {
        assert_eq!(params("local function f(p) return p .. (p + 1) end"), vec![None]);
    }

    #[test]
    fn no_evidence_omits_the_hint() {
        assert_eq!(params("local function f(p) return p end"), vec![None]);
    }

    #[test]
    fn annotation_wins_over_usage() {
        let src = "--- @param p number\nlocal function f(p) return p .. 'x' end";
        assert_eq!(params(src), vec![Some(Type::Number)]);
    }

    #[test]
    fn explicit_any_annotation_omits_the_hint() {
        let src = "--- @param p any\nlocal function f(p) return p .. 'x' end";
        assert_eq!(params(src), vec![None]);
    }

    #[test]
    fn reassigned_parameter_is_omitted() {
        assert_eq!(params("local function f(p) p = 1 return p .. 'x' end"), vec![None]);
    }

    #[test]
    fn shadowed_parameter_is_omitted() {
        assert_eq!(params("local function f(p) local p = 2 return p .. 'x' end"), vec![None]);
    }

    #[test]
    fn nested_function_use_does_not_leak() {
        // `p` used as a string only inside a nested function — not our scope.
        let src = "local function f(p) local g = function() return p:upper() end end";
        assert_eq!(params(src), vec![None]);
    }

    #[test]
    fn multiple_consistent_uses_agree() {
        assert_eq!(params("local function f(p) local x = p .. p return x end"), vec![Some(Type::String)]);
    }

    #[test]
    fn two_parameters_inferred_independently() {
        let src = "local function f(a, b) return a + 1, b .. 'x' end";
        assert_eq!(params(src), vec![Some(Type::Number), Some(Type::String)]);
    }

    #[test]
    fn return_of_literal_is_inferred() {
        assert_eq!(ret("local function f() return 1 end"), Some(Type::Number));
    }

    #[test]
    fn return_of_string_method_is_string() {
        assert_eq!(ret("local function f(p) return p:upper() end"), Some(Type::String));
    }

    #[test]
    fn return_of_typed_parameter_reuses_its_type() {
        assert_eq!(ret("local function f(p) return p + 1 end"), Some(Type::Number));
    }

    #[test]
    fn mixed_returns_conflict_and_omit() {
        assert_eq!(ret("local function f() if x then return 1 end return 'y' end"), None);
    }

    #[test]
    fn no_return_omits_the_return_type() {
        assert_eq!(ret("local function f() local x = 1 end"), None);
    }

    #[test]
    fn bare_return_only_omits_the_return_type() {
        assert_eq!(ret("local function f() return end"), None);
    }

    #[test]
    fn return_unifies_consistent_branches() {
        assert_eq!(ret("local function f() if x then return 1 end return 2 end"), Some(Type::Number));
    }
}
