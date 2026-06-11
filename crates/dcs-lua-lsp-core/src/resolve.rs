//! Identifier resolution — the first Phase-2 slice, shaped around hover.
//!
//! Finds the identifier under a byte offset and the declaration it binds
//! to: innermost lexical scope first (locals, `local function`s, function
//! parameters, for bindings — shadowing-aware), then file-level globals,
//! then workspace-level globals (the first global assignment or function
//! declaration with that name across all mounted files — the global-first
//! model).

use dcs_lua_syntax::ast::{Ast, ExprId, ExprKind, FuncBody, FuncName, Name, Parsed, StatKind};
use dcs_lua_syntax::span::Span;

use crate::workspace::Workspace;

/// The identifier under the cursor.
#[derive(Debug)]
pub enum Ident<'a> {
    /// A `NameRef` use site, resolved through the scope chain.
    Use { name: &'a str },
    /// A field access name (`obj.name`), resolved as a dotted global path.
    Field { dotted: String },
    /// The cursor sits on a declaration name itself.
    Decl(Decl<'a>),
}

/// A declaration an identifier binds to.
#[derive(Debug)]
pub enum Decl<'a> {
    Local {
        name: &'a Name,
        value: Option<ExprId>,
        stat_start: u32,
    },
    LocalFunction {
        name: &'a Name,
        func: &'a FuncBody,
        stat_start: u32,
    },
    Param {
        name: &'a Name,
    },
    NumericFor {
        name: &'a Name,
        stat_start: u32,
    },
    GenericFor {
        name: &'a Name,
        stat_start: u32,
    },
    GlobalAssign {
        name: String,
        value: Option<ExprId>,
        stat_start: u32,
    },
    GlobalFunction {
        name: &'a FuncName,
        func: &'a FuncBody,
        stat_start: u32,
    },
}

impl Decl<'_> {
    /// The byte offset the declaration starts at — the doc-run anchor.
    #[must_use]
    pub fn start(&self) -> u32 {
        match self {
            Decl::Param { name } => name.span.start,
            Decl::Local { stat_start, .. }
            | Decl::LocalFunction { stat_start, .. }
            | Decl::NumericFor { stat_start, .. }
            | Decl::GenericFor { stat_start, .. }
            | Decl::GlobalAssign { stat_start, .. }
            | Decl::GlobalFunction { stat_start, .. } => *stat_start,
        }
    }
}

/// `[start, end)` containment — the cursor is on the identifier.
fn on(span: Span, offset: u32) -> bool {
    span.start <= offset && offset < span.end
}

/// `[start, end]` containment — the offset lies within a scope.
fn within(span: Span, offset: u32) -> bool {
    span.start <= offset && offset <= span.end
}

/// The identifier at `offset`, walking the arenas by span.
#[must_use]
pub fn ident_at(parsed: &Parsed, offset: u32) -> Option<Ident<'_>> {
    let ast = &parsed.ast;
    for stat in &ast.stats {
        match &stat.kind {
            StatKind::LocalAssign { names, values } => {
                for (position, name) in names.iter().enumerate() {
                    if on(name.span, offset) {
                        return Some(Ident::Decl(Decl::Local {
                            name,
                            value: values.get(position).copied(),
                            stat_start: stat.span.start,
                        }));
                    }
                }
            }
            StatKind::LocalFunction { name, func } => {
                if on(name.span, offset) {
                    return Some(Ident::Decl(Decl::LocalFunction {
                        name,
                        func,
                        stat_start: stat.span.start,
                    }));
                }
                if let Some(param) = param_at(func, offset) {
                    return Some(Ident::Decl(param));
                }
            }
            StatKind::FunctionDecl { name, func } => {
                let on_name = name.segments.iter().any(|segment| on(segment.span, offset))
                    || name.method.as_ref().is_some_and(|m| on(m.span, offset));
                if on_name {
                    return Some(Ident::Decl(Decl::GlobalFunction {
                        name,
                        func,
                        stat_start: stat.span.start,
                    }));
                }
                if let Some(param) = param_at(func, offset) {
                    return Some(Ident::Decl(param));
                }
            }
            StatKind::NumericFor { name, .. } => {
                if on(name.span, offset) {
                    return Some(Ident::Decl(Decl::NumericFor {
                        name,
                        stat_start: stat.span.start,
                    }));
                }
            }
            StatKind::GenericFor { names, .. } => {
                for name in names {
                    if on(name.span, offset) {
                        return Some(Ident::Decl(Decl::GenericFor {
                            name,
                            stat_start: stat.span.start,
                        }));
                    }
                }
            }
            _ => {}
        }
    }
    for (position, expr) in ast.exprs.iter().enumerate() {
        match &expr.kind {
            ExprKind::NameRef(name) if on(expr.span, offset) => {
                return Some(Ident::Use { name });
            }
            ExprKind::Field { name, .. } if on(name.span, offset) => {
                let dotted = render_dotted(ast, ExprId(position as u32))?;
                return Some(Ident::Field { dotted });
            }
            ExprKind::Function(func) => {
                if let Some(param) = param_at(func, offset) {
                    return Some(Ident::Decl(param));
                }
            }
            _ => {}
        }
    }
    None
}

fn param_at(func: &FuncBody, offset: u32) -> Option<Decl<'_>> {
    func.params
        .iter()
        .find(|param| on(param.span, offset))
        .map(|name| Decl::Param { name })
}

/// `a.b.c` for a pure `NameRef`/`Field` chain; `None` once anything else
/// (calls, indexing) joins the chain.
fn render_dotted(ast: &Ast, expr: ExprId) -> Option<String> {
    match &ast.expr(expr).kind {
        ExprKind::NameRef(name) => Some(name.clone()),
        ExprKind::Field { obj, name } => {
            Some(format!("{}.{}", render_dotted(ast, *obj)?, name.text))
        }
        _ => None,
    }
}

/// The declaration `name` binds to at `offset` in `path`, with the path of
/// the file declaring it: innermost scope → file globals → workspace
/// globals.
#[must_use]
pub fn resolve<'ws>(
    workspace: &'ws Workspace,
    path: &str,
    name: &str,
    offset: u32,
) -> Option<(String, Decl<'ws>)> {
    let entry = workspace.file(path)?;
    if let Some(decl) = lookup_scopes(&entry.parsed, name, offset) {
        return Some((path.to_string(), decl));
    }
    lookup_globals(workspace, path, |ast, stat_kind| {
        global_match(ast, stat_kind, name)
    })
}

/// The first global function declaration or assignment matching a dotted
/// path (`lib.sub`), current file first.
#[must_use]
pub fn resolve_dotted<'ws>(
    workspace: &'ws Workspace,
    path: &str,
    dotted: &str,
) -> Option<(String, Decl<'ws>)> {
    lookup_globals(workspace, path, |ast, stat_kind| {
        dotted_match(ast, stat_kind, dotted)
    })
}

// ---- lexical scopes --------------------------------------------------------

/// One scope-ranked candidate: smaller scopes are inner, locals shadow the
/// bindings that introduced their block, later declarations shadow earlier
/// ones.
struct Candidate<'a> {
    scope_len: u32,
    /// 0 = local / local function, 1 = parameter, 2 = for binding.
    rank: u8,
    decl_start: u32,
    decl: Decl<'a>,
}

/// Every binding of `name` visible at `offset`, innermost-shadowing wins.
/// Scope nesting falls out of the arenas: every candidate's scope span
/// contains `offset`, so spans nest and the shortest is the innermost.
fn lookup_scopes<'a>(parsed: &'a Parsed, name: &str, offset: u32) -> Option<Decl<'a>> {
    let ast = &parsed.ast;
    let mut candidates: Vec<Candidate<'a>> = Vec::new();
    local_candidates(&mut candidates, ast, name, offset);
    binder_candidates(&mut candidates, ast, name, offset);
    candidates
        .into_iter()
        .min_by_key(|candidate| {
            (
                candidate.scope_len,
                candidate.rank,
                std::cmp::Reverse(candidate.decl_start),
            )
        })
        .map(|candidate| candidate.decl)
}

/// `local` / `local function` declarations visible at `offset`, in a block
/// containing it. A plain `local`'s binding becomes visible only AFTER its
/// declaring statement completes (Lua 5.1 §2.4.7) — the RHS of
/// `local x = x` still sees the outer `x`. A `local function`'s name is
/// visible from the statement's start (its body recurses through it).
fn local_candidates<'a>(
    candidates: &mut Vec<Candidate<'a>>,
    ast: &'a Ast,
    name: &str,
    offset: u32,
) {
    for block in &ast.blocks {
        if !within(block.span, offset) {
            continue;
        }
        let scope_len = block.span.end - block.span.start;
        for &stat_id in &block.stats {
            let stat = ast.stat(stat_id);
            match &stat.kind {
                StatKind::LocalAssign { names, values } => {
                    if stat.span.end > offset {
                        continue;
                    }
                    for (position, decl_name) in names.iter().enumerate() {
                        if decl_name.text == name {
                            candidates.push(Candidate {
                                scope_len,
                                rank: 0,
                                decl_start: stat.span.start,
                                decl: Decl::Local {
                                    name: decl_name,
                                    value: values.get(position).copied(),
                                    stat_start: stat.span.start,
                                },
                            });
                        }
                    }
                }
                StatKind::LocalFunction {
                    name: decl_name,
                    func,
                } => {
                    if stat.span.start > offset {
                        continue;
                    }
                    if decl_name.text == name {
                        candidates.push(Candidate {
                            scope_len,
                            rank: 0,
                            decl_start: stat.span.start,
                            decl: Decl::LocalFunction {
                                name: decl_name,
                                func,
                                stat_start: stat.span.start,
                            },
                        });
                    }
                }
                _ => {}
            }
        }
    }
}

/// Parameters whose function literal spans `offset`. The last parameter of
/// one signature wins (`function (x, x)`).
fn func_scope<'a>(
    candidates: &mut Vec<Candidate<'a>>,
    func: &'a FuncBody,
    name: &str,
    offset: u32,
) {
    if !within(func.span, offset) {
        return;
    }
    if let Some(param) = func.params.iter().rev().find(|param| param.text == name) {
        candidates.push(Candidate {
            scope_len: func.span.end - func.span.start,
            rank: 1,
            decl_start: param.span.start,
            decl: Decl::Param { name: param },
        });
    }
}

/// Scope-introducing constructs spanning `offset`: function parameters,
/// recursive `local function` names, and for-statement bindings.
fn binder_candidates<'a>(
    candidates: &mut Vec<Candidate<'a>>,
    ast: &'a Ast,
    name: &str,
    offset: u32,
) {
    for expr in &ast.exprs {
        if let ExprKind::Function(func) = &expr.kind {
            func_scope(candidates, func, name, offset);
        }
    }
    for stat in &ast.stats {
        match &stat.kind {
            StatKind::FunctionDecl { func, .. } => {
                func_scope(candidates, func, name, offset);
            }
            StatKind::LocalFunction {
                name: decl_name,
                func,
            } => {
                func_scope(candidates, func, name, offset);
                // The function's own name is visible inside it (recursion).
                if decl_name.text == name && within(func.span, offset) {
                    candidates.push(Candidate {
                        scope_len: func.span.end - func.span.start,
                        rank: 1,
                        decl_start: stat.span.start,
                        decl: Decl::LocalFunction {
                            name: decl_name,
                            func,
                            stat_start: stat.span.start,
                        },
                    });
                }
            }
            StatKind::NumericFor {
                name: decl_name,
                body,
                ..
            } => {
                let body_span = ast.block(*body).span;
                if decl_name.text == name && within(body_span, offset) {
                    candidates.push(Candidate {
                        scope_len: body_span.end - body_span.start,
                        rank: 2,
                        decl_start: stat.span.start,
                        decl: Decl::NumericFor {
                            name: decl_name,
                            stat_start: stat.span.start,
                        },
                    });
                }
            }
            StatKind::GenericFor { names, body, .. } => {
                let body_span = ast.block(*body).span;
                if !within(body_span, offset) {
                    continue;
                }
                if let Some(decl_name) = names.iter().rev().find(|n| n.text == name) {
                    candidates.push(Candidate {
                        scope_len: body_span.end - body_span.start,
                        rank: 2,
                        decl_start: stat.span.start,
                        decl: Decl::GenericFor {
                            name: decl_name,
                            stat_start: stat.span.start,
                        },
                    });
                }
            }
            _ => {}
        }
    }
}

// ---- globals ----------------------------------------------------------------

/// Scan one file's statement arena with `matcher`, keeping the match
/// earliest in the source.
fn file_global<'a>(
    parsed: &'a Parsed,
    matcher: &impl Fn(&'a Ast, &'a dcs_lua_syntax::ast::Stat) -> Option<Decl<'a>>,
) -> Option<Decl<'a>> {
    let ast = &parsed.ast;
    ast.stats
        .iter()
        .filter_map(|stat| matcher(ast, stat))
        .min_by_key(Decl::start)
}

/// Current file first, then every other mounted file in path order.
fn lookup_globals<'ws>(
    workspace: &'ws Workspace,
    path: &str,
    matcher: impl Fn(&'ws Ast, &'ws dcs_lua_syntax::ast::Stat) -> Option<Decl<'ws>>,
) -> Option<(String, Decl<'ws>)> {
    if let Some(entry) = workspace.file(path)
        && let Some(decl) = file_global(&entry.parsed, &matcher)
    {
        return Some((path.to_string(), decl));
    }
    let mut others: Vec<(&str, &crate::workspace::FileEntry)> = workspace
        .files()
        .filter(|(other, _)| *other != path)
        .collect();
    others.sort_by_key(|(other, _)| other.to_string());
    for (other, entry) in others {
        if let Some(decl) = file_global(&entry.parsed, &matcher) {
            return Some((other.to_string(), decl));
        }
    }
    None
}

fn global_match<'a>(
    ast: &'a Ast,
    stat: &'a dcs_lua_syntax::ast::Stat,
    name: &str,
) -> Option<Decl<'a>> {
    match &stat.kind {
        StatKind::Assign { targets, values } => {
            targets.iter().enumerate().find_map(|(position, &target)| {
                let ExprKind::NameRef(target_name) = &ast.expr(target).kind else {
                    return None;
                };
                (target_name == name).then(|| Decl::GlobalAssign {
                    name: target_name.clone(),
                    value: values.get(position).copied(),
                    stat_start: stat.span.start,
                })
            })
        }
        StatKind::FunctionDecl {
            name: func_name,
            func,
        } => {
            let simple = func_name.segments.len() == 1
                && func_name.method.is_none()
                && func_name.segments[0].text == name;
            simple.then_some(Decl::GlobalFunction {
                name: func_name,
                func,
                stat_start: stat.span.start,
            })
        }
        _ => None,
    }
}

fn dotted_match<'a>(
    ast: &'a Ast,
    stat: &'a dcs_lua_syntax::ast::Stat,
    dotted: &str,
) -> Option<Decl<'a>> {
    match &stat.kind {
        StatKind::Assign { targets, values } => {
            targets.iter().enumerate().find_map(|(position, &target)| {
                (render_dotted(ast, target).as_deref() == Some(dotted)).then(|| {
                    Decl::GlobalAssign {
                        name: dotted.to_string(),
                        value: values.get(position).copied(),
                        stat_start: stat.span.start,
                    }
                })
            })
        }
        StatKind::FunctionDecl {
            name: func_name,
            func,
        } => {
            let path_only = func_name.method.is_none()
                && func_name
                    .segments
                    .iter()
                    .map(|segment| segment.text.as_str())
                    .collect::<Vec<_>>()
                    .join(".")
                    == dotted;
            path_only.then_some(Decl::GlobalFunction {
                name: func_name,
                func,
                stat_start: stat.span.start,
            })
        }
        _ => None,
    }
}
