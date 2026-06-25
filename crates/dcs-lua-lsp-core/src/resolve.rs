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

use crate::symbols::render_func_name;
use crate::workspace::{FileEntry, Workspace};

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
        /// Span of the assignment target naming the global — the rename/
        /// definition anchor a `GlobalAssign` would otherwise lack.
        name_span: Span,
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

    /// The span of the declaration's own name — where go-to-definition lands
    /// the caret, and (by its start) the declaration's stable identity for
    /// find-references and rename. For a dotted/method `GlobalFunction` this
    /// is the final segment or the method name (the part a rename rewrites),
    /// so two `lib.f`/`other.f` declarations stay distinct identities.
    #[must_use]
    pub fn name_span(&self) -> Span {
        match self {
            Decl::Local { name, .. }
            | Decl::LocalFunction { name, .. }
            | Decl::Param { name }
            | Decl::NumericFor { name, .. }
            | Decl::GenericFor { name, .. } => name.span,
            Decl::GlobalAssign { name_span, .. } => *name_span,
            Decl::GlobalFunction { name, .. } => func_name_span(name),
        }
    }
}

/// The span a `FunctionDecl` name renames at: the method name if any, else
/// the final dotted segment, else (a recovery parse with no segments) empty.
fn func_name_span(name: &FuncName) -> Span {
    name.method
        .as_ref()
        .map(|m| m.span)
        .or_else(|| name.segments.last().map(|s| s.span))
        .unwrap_or(Span::new(0, 0))
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

/// The span naming the global an assignment target binds: the final field
/// name for a dotted target (`a.b.c` → `c`), else the whole target (a plain
/// `NameRef`). The rename/definition anchor for a `GlobalAssign`.
fn target_name_span(ast: &Ast, target: ExprId) -> Span {
    match &ast.expr(target).kind {
        ExprKind::Field { name, .. } => name.span,
        _ => ast.expr(target).span,
    }
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

/// `true` when a candidate's name passes the filter — a specific name when
/// resolving one identifier, or `None` to collect every binding for
/// completion.
fn matches_name(filter: Option<&str>, text: &str) -> bool {
    filter.is_none_or(|name| name == text)
}

/// The ranking key: innermost scope first, then binding rank, then the
/// latest declaration. `lookup_scopes` minimises it; `visible_locals`
/// dedupes by it.
fn rank_key(candidate: &Candidate<'_>) -> (u32, u8, std::cmp::Reverse<u32>) {
    (
        candidate.scope_len,
        candidate.rank,
        std::cmp::Reverse(candidate.decl_start),
    )
}

/// Every binding of `name` visible at `offset`, innermost-shadowing wins.
/// Scope nesting falls out of the arenas: every candidate's scope span
/// contains `offset`, so spans nest and the shortest is the innermost.
fn lookup_scopes<'a>(parsed: &'a Parsed, name: &str, offset: u32) -> Option<Decl<'a>> {
    let ast = &parsed.ast;
    let mut candidates: Vec<Candidate<'a>> = Vec::new();
    local_candidates(&mut candidates, ast, Some(name), offset);
    binder_candidates(&mut candidates, ast, Some(name), offset);
    candidates.into_iter().min_by_key(rank_key).map(|c| c.decl)
}

/// Every binding visible at `offset` — locals, `local function`s, function
/// parameters, and for-bindings — deduped by name with the innermost
/// (shadowing) binding kept. The completion counterpart of [`lookup_scopes`]:
/// it collects every name where that selects one.
#[must_use]
pub fn visible_locals<'a>(parsed: &'a Parsed, offset: u32) -> Vec<Decl<'a>> {
    let ast = &parsed.ast;
    let mut candidates: Vec<Candidate<'a>> = Vec::new();
    local_candidates(&mut candidates, ast, None, offset);
    binder_candidates(&mut candidates, ast, None, offset);
    candidates.sort_by_key(rank_key);
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    candidates
        .into_iter()
        .filter(|candidate| seen.insert(decl_label(&candidate.decl)))
        .map(|candidate| candidate.decl)
        .collect()
}

/// The bare identifier a declaration introduces — the completion label and
/// the scope dedup key.
#[must_use]
pub fn decl_label(decl: &Decl<'_>) -> String {
    match decl {
        Decl::Local { name, .. }
        | Decl::LocalFunction { name, .. }
        | Decl::Param { name }
        | Decl::NumericFor { name, .. }
        | Decl::GenericFor { name, .. } => name.text.clone(),
        Decl::GlobalAssign { name, .. } => name.clone(),
        Decl::GlobalFunction { name, .. } => render_func_name(name),
    }
}

/// `local` / `local function` declarations visible at `offset`, in a block
/// containing it. A plain `local`'s binding becomes visible only AFTER its
/// declaring statement completes (Lua 5.1 §2.4.7) — the RHS of
/// `local x = x` still sees the outer `x`. A `local function`'s name is
/// visible from the statement's start (its body recurses through it).
fn local_candidates<'a>(
    candidates: &mut Vec<Candidate<'a>>,
    ast: &'a Ast,
    name: Option<&str>,
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
                        if matches_name(name, &decl_name.text) {
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
                    if matches_name(name, &decl_name.text) {
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
    name: Option<&str>,
    offset: u32,
) {
    if !within(func.span, offset) {
        return;
    }
    let scope_len = func.span.end - func.span.start;
    // Resolving one name takes the last parameter of that name
    // (`function (x, x)`); collecting takes every parameter once.
    let params: Vec<&'a Name> = match name {
        Some(n) => func
            .params
            .iter()
            .rev()
            .filter(|param| param.text == n)
            .take(1)
            .collect(),
        None => func.params.iter().collect(),
    };
    for param in params {
        candidates.push(Candidate {
            scope_len,
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
    name: Option<&str>,
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
                if matches_name(name, &decl_name.text) && within(func.span, offset) {
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
                if matches_name(name, &decl_name.text) && within(body_span, offset) {
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
                // Resolving one name takes the last binding of that name;
                // collecting takes every binding the for-clause introduces.
                let bound: Vec<&Name> = match name {
                    Some(n) => names.iter().rev().filter(|nm| nm.text == n).take(1).collect(),
                    None => names.iter().collect(),
                };
                for decl_name in bound {
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

/// Mounted files in resolution priority: the current file first, then every
/// other file in path order. The single ordering every workspace-global walk
/// shares — single-symbol lookup ([`lookup_globals`]) and the completion
/// enumerations ([`global_decls`], [`dotted_children`]) — so completion picks
/// the same declaration hover and go-to-definition resolve.
fn files_in_resolution_order<'ws>(
    workspace: &'ws Workspace,
    current_path: &str,
) -> Vec<(&'ws str, &'ws FileEntry)> {
    let mut current = None;
    let mut others: Vec<(&'ws str, &'ws FileEntry)> = Vec::new();
    for (path, entry) in workspace.files() {
        if path == current_path {
            current = Some((path, entry));
        } else {
            others.push((path, entry));
        }
    }
    others.sort_by_key(|(path, _)| *path);
    current.into_iter().chain(others).collect()
}

/// The first global matched by `matcher`: each file in resolution order
/// (current first, then path order), taking that file's earliest match.
fn lookup_globals<'ws>(
    workspace: &'ws Workspace,
    path: &str,
    matcher: impl Fn(&'ws Ast, &'ws dcs_lua_syntax::ast::Stat) -> Option<Decl<'ws>>,
) -> Option<(String, Decl<'ws>)> {
    for (file_path, entry) in files_in_resolution_order(workspace, path) {
        if let Some(decl) = file_global(&entry.parsed, &matcher) {
            return Some((file_path.to_string(), decl));
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
                    name_span: target_name_span(ast, target),
                })
            })
        }
        StatKind::FunctionDecl {
            name: func_name,
            func,
        } => {
            let simple = func_name.method.is_none()
                && matches!(func_name.segments.as_slice(), [seg] if seg.text == name);
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
                        name_span: target_name_span(ast, target),
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

// ---- completion enumeration -------------------------------------------------

/// The dotted path of a non-method function declaration (`a.b.c`); `None`
/// for a method (`a:b`), whose receiver is not a dotted-global path.
fn func_path(name: &FuncName) -> Option<String> {
    if name.method.is_some() {
        return None;
    }
    Some(
        name.segments
            .iter()
            .map(|segment| segment.text.as_str())
            .collect::<Vec<_>>()
            .join("."),
    )
}

/// Every workspace global with a simple (non-dotted) name: `NameRef`
/// assignment targets and single-segment function declarations, each paired
/// with the file that declares it. The typed half of completion's
/// bare-identifier set — every `Decl` carries the kind, signature, and docs.
///
/// Returned in resolution order — current file first, then path order, each
/// file's declarations earliest-first — so the caller's first-wins dedup by
/// name selects the same declaration [`resolve`] (and thus hover) would.
#[must_use]
pub fn global_decls<'ws>(
    workspace: &'ws Workspace,
    current_path: &str,
) -> Vec<(String, Decl<'ws>)> {
    let mut out = Vec::new();
    for (path, entry) in files_in_resolution_order(workspace, current_path) {
        let ast = &entry.parsed.ast;
        let mut file_decls: Vec<Decl<'ws>> = Vec::new();
        for stat in &ast.stats {
            match &stat.kind {
                StatKind::Assign { targets, values } => {
                    for (position, &target) in targets.iter().enumerate() {
                        if let ExprKind::NameRef(target_name) = &ast.expr(target).kind {
                            file_decls.push(Decl::GlobalAssign {
                                name: target_name.clone(),
                                value: values.get(position).copied(),
                                stat_start: stat.span.start,
                                name_span: target_name_span(ast, target),
                            });
                        }
                    }
                }
                StatKind::FunctionDecl { name, func } => {
                    if name.method.is_none() && name.segments.len() == 1 {
                        file_decls.push(Decl::GlobalFunction {
                            name,
                            func,
                            stat_start: stat.span.start,
                        });
                    }
                }
                _ => {}
            }
        }
        file_decls.sort_by_key(Decl::start);
        out.extend(file_decls.into_iter().map(|decl| (path.to_string(), decl)));
    }
    out
}

/// Every distinct global root across the workspace: a simple global's name,
/// or the first segment of a dotted-global statement (`DCS` from
/// `DCS.x = …`). The bare-identifier set's complete label list — it surfaces
/// a `_G` table that only ever appears dotted.
#[must_use]
pub fn global_roots(workspace: &Workspace) -> Vec<String> {
    let mut roots: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for (_, entry) in workspace.files() {
        let ast = &entry.parsed.ast;
        for stat in &ast.stats {
            match &stat.kind {
                StatKind::Assign { targets, .. } => {
                    for &target in targets {
                        let Some(dotted) = render_dotted(ast, target) else {
                            continue;
                        };
                        if let Some(root) = root_segment(&dotted) {
                            roots.insert(root.to_string());
                        }
                    }
                }
                StatKind::FunctionDecl { name, .. } => {
                    if let Some(first) = name.segments.first() {
                        roots.insert(first.text.clone());
                    }
                }
                _ => {}
            }
        }
    }
    roots.into_iter().collect()
}

/// The members one segment under `receiver.`: every dotted-global
/// `Assign`/`FunctionDecl` whose path is `receiver.<segment>[.…]`, returned
/// as `(segment, declaring-path, decl)`. The generated `.d.lua` member path —
/// the same dotted statements `dotted_match` resolves, enumerated by prefix.
///
/// Returned in resolution order — current file first, then path order, each
/// file's declarations earliest-first — so the caller's first-wins dedup by
/// segment is deterministic. For a leaf member it selects the declaration
/// [`resolve_dotted`] (and thus hover) resolves for `receiver.<segment>`; the
/// exception is a nested namespace whose own `receiver.<segment>` declaration
/// is outranked by a deeper `receiver.<segment>.…` sibling — the generated
/// stubs are flat, so leaves are the norm.
#[must_use]
pub fn dotted_children<'ws>(
    workspace: &'ws Workspace,
    current_path: &str,
    receiver: &str,
) -> Vec<(String, String, Decl<'ws>)> {
    let prefix = format!("{receiver}.");
    let mut out = Vec::new();
    for (path, entry) in files_in_resolution_order(workspace, current_path) {
        let ast = &entry.parsed.ast;
        let mut file_children: Vec<(String, Decl<'ws>)> = Vec::new();
        for stat in &ast.stats {
            match &stat.kind {
                StatKind::Assign { targets, values } => {
                    for (position, &target) in targets.iter().enumerate() {
                        let Some(dotted) = render_dotted(ast, target) else {
                            continue;
                        };
                        let Some(segment) = child_segment(&dotted, &prefix) else {
                            continue;
                        };
                        file_children.push((
                            segment,
                            Decl::GlobalAssign {
                                name: dotted,
                                value: values.get(position).copied(),
                                stat_start: stat.span.start,
                                name_span: target_name_span(ast, target),
                            },
                        ));
                    }
                }
                StatKind::FunctionDecl { name, func } => {
                    let Some(segment) =
                        func_path(name).and_then(|dotted| child_segment(&dotted, &prefix))
                    else {
                        continue;
                    };
                    file_children.push((
                        segment,
                        Decl::GlobalFunction {
                            name,
                            func,
                            stat_start: stat.span.start,
                        },
                    ));
                }
                _ => {}
            }
        }
        file_children.sort_by_key(|(_, decl)| decl.start());
        out.extend(
            file_children
                .into_iter()
                .map(|(segment, decl)| (segment, path.to_string(), decl)),
        );
    }
    out
}

/// The first segment of a dotted path (`DCS` from `DCS.x`), or `None` for an
/// empty string.
fn root_segment(dotted: &str) -> Option<&str> {
    dotted.split('.').next().filter(|segment| !segment.is_empty())
}

/// The single segment directly under `prefix` (`foo` from `DCS.foo` or
/// `DCS.foo.bar` under `DCS.`), or `None` when `dotted` is not under it.
fn child_segment(dotted: &str, prefix: &str) -> Option<String> {
    let rest = dotted.strip_prefix(prefix)?;
    let segment = rest.split('.').next().unwrap_or(rest);
    (!segment.is_empty()).then(|| segment.to_string())
}
