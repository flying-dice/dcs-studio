//! Lua type-definition (`.d.lua`) model + emitter — the lua-free half of the
//! `dcs_studio` DLL's tealr-style binding facade.
//!
//! The in-DCS `dcs_studio` native module exposes a typed Lua surface via mlua.
//! The facade in `crates/dcs-bridge` registers each binding *and* records it
//! into the pure-data [`ModuleDoc`] here — one declaration, no drift. This
//! module renders that model as a `---@meta` definition file in exactly the
//! EmmyLua/LuaLS dialect the dcs-lua engine parses (`dcs-lua-syntax`
//! annotation.rs; SPEC.md §4, §6; decision 003), so `lua-analyzer` gives
//! completion/hover on `require("dcs_studio")`.
//!
//! Living here (lua-free, no mlua link) means the file is emitted and
//! golden-tested on any platform — the `dcs-bridge` crate links DCS's
//! `lua.dll` and cannot run mlua off-DCS, so the type surface and its emitter
//! are kept on this side of the line.

use std::fmt::Write as _;

/// One parameter of a function or method. `optional` renders the `EmmyLua`
/// `name?` form.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Param {
    pub name: String,
    /// An `EmmyLua` type expression (`string`, `number`, `table`, `any`,
    /// `dcs_studio.Logger`, `string[]`, `string|nil`, …).
    pub ty: String,
    pub optional: bool,
}

impl Param {
    pub fn new(name: impl Into<String>, ty: impl Into<String>, optional: bool) -> Self {
        Self {
            name: name.into(),
            ty: ty.into(),
            optional,
        }
    }
}

/// One return value. `name` is the optional `EmmyLua` return-name (`---@return
/// string json`), useful for multi-return functions like the `(value, err)`
/// idiom.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ret {
    pub ty: String,
    pub name: Option<String>,
}

impl Ret {
    pub fn new(ty: impl Into<String>) -> Self {
        Self {
            ty: ty.into(),
            name: None,
        }
    }

    pub fn named(ty: impl Into<String>, name: impl Into<String>) -> Self {
        Self {
            ty: ty.into(),
            name: Some(name.into()),
        }
    }
}

/// One function or method. Emitted as `function <var>.<name>(...)` for a
/// dot-function or `function <var>:<name>(...)` for a colon-method (the
/// receiver is implicit and not listed in `params`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FnDoc {
    pub name: String,
    pub params: Vec<Param>,
    pub returns: Vec<Ret>,
    pub doc: String,
    /// `true` for a `:method` (userdata receiver), `false` for a `.function`.
    pub is_method: bool,
}

/// One `@field` on a class: a sub-namespace, a constant, or a nested table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FieldDoc {
    pub name: String,
    pub ty: String,
    pub doc: String,
}

/// One class: the root module table, a sub-namespace (`dcs_studio.json`), or a
/// userdata handle (`dcs_studio.Logger`). Rendered as an `---@class` with its
/// `@field`s, a backing `local`, and one `function` per dot-function /
/// colon-method.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClassDoc {
    pub name: String,
    pub doc: String,
    pub fields: Vec<FieldDoc>,
    pub functions: Vec<FnDoc>,
}

impl ClassDoc {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            doc: String::new(),
            fields: Vec::new(),
            functions: Vec::new(),
        }
    }
}

/// A whole module's type surface: an ordered list of classes plus the name of
/// the root class the file `return`s. Classes are emitted in order, so a
/// builder lists leaf namespaces/userdata before the root that fields them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ModuleDoc {
    /// The class name the file returns, e.g. `"dcs_studio"`.
    pub root: String,
    pub classes: Vec<ClassDoc>,
}

/// The `EmmyLua` local-variable name backing a class: dots and other
/// non-identifier characters collapse to underscores (`dcs_studio.json` →
/// `dcs_studio_json`). Stable and identifier-safe for any class name we emit.
fn local_var(class_name: &str) -> String {
    let v: String = class_name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    // A leading digit would be an invalid Lua identifier; prefix defensively.
    if v.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        format!("_{v}")
    } else {
        v
    }
}

/// Render a parameter list for the `function ...(a, b)` line. The receiver of a
/// colon-method is implicit, so only `params` are listed.
fn param_names(f: &FnDoc) -> String {
    f.params
        .iter()
        .map(|p| p.name.as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

/// Push a `---` doc body, one `--- ` line per source line. A blank `doc`
/// emits nothing.
fn push_doc(out: &mut String, doc: &str) {
    for line in doc.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            out.push_str("---\n");
        } else {
            let _ = writeln!(out, "--- {line}");
        }
    }
}

/// Emit one function/method (its doc, `@param`/`@return` block, and the
/// bodyless `function` stub) onto `out`, bound to `var`.
fn emit_fn(out: &mut String, var: &str, f: &FnDoc) {
    push_doc(out, &f.doc);
    for p in &f.params {
        let name = if p.optional {
            format!("{}?", p.name)
        } else {
            p.name.clone()
        };
        let _ = writeln!(out, "---@param {name} {}", p.ty);
    }
    for r in &f.returns {
        match &r.name {
            Some(n) => {
                let _ = writeln!(out, "---@return {} {n}", r.ty);
            }
            None => {
                let _ = writeln!(out, "---@return {}", r.ty);
            }
        }
    }
    let sep = if f.is_method { ":" } else { "." };
    let _ = writeln!(
        out,
        "function {var}{sep}{}({}) end\n",
        f.name,
        param_names(f)
    );
}

/// Render `doc` as a `.d.lua` definition file: a leading NAMED `---@meta`
/// (the sumneko convention — it binds the file to the runtime module
/// `require("<root>")` loads, which has no on-disk path), every class as an
/// `---@class` + `@field`s + backing `local` + its functions, and a trailing
/// `return <root>`. The output parses under `dcs-lua-syntax` and is accepted
/// verbatim by `LuaLS`.
#[must_use]
pub fn emit_dlua(doc: &ModuleDoc) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "---@meta {}", doc.root);
    out.push_str("--- Generated type definitions for the dcs_studio DLL surface.\n");
    out.push_str("--- Do not edit by hand: regenerated from the binding facade.\n\n");

    for class in &doc.classes {
        push_doc(&mut out, &class.doc);
        let _ = writeln!(out, "---@class {}", class.name);
        for field in &class.fields {
            if field.doc.is_empty() {
                let _ = writeln!(out, "---@field {} {}", field.name, field.ty);
            } else {
                let _ = writeln!(
                    out,
                    "---@field {} {} # {}",
                    field.name,
                    field.ty,
                    field.doc.replace('\n', " ")
                );
            }
        }
        let var = local_var(&class.name);
        let _ = writeln!(out, "local {var} = {{}}\n");
        for f in &class.functions {
            emit_fn(&mut out, &var, f);
        }
    }

    let _ = writeln!(out, "return {}", local_var(&doc.root));
    out
}

// ---- introspected DCS globals -----------------------------------------------
//
// `dcs_studio.dump_globals()` (the DLL, `crates/dcs-bridge`) walks the live DCS
// API roots in `_G` and builds this pure-data tree; this lua-free side renders
// it as the dotted statements the resolver indexes (`global_match` /
// `dotted_match`, `crates/dcs-lua-lsp-core/src/resolve.rs`) — `DCS = {}` then
// `function DCS.getModelTime() end`. Never `---@class` / `---@meta`: the syntax
// layer parses `@meta` but no resolver honors it (model `bridge.pds`
// `Types.DumpGlobals`). The introspection walk (depth cap, visited set,
// never-raise) lives DLL-side where `_G` is; the emittable-segment filter and
// the rendering are here, lua-free and golden-tested on any platform.

/// A scalar member's primitive type. Emitted as a canonical placeholder value
/// of that type — never the live build's value — so the member resolves and
/// hovers as its type without baking sim data into the definitions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScalarTy {
    Number,
    String,
    Boolean,
}

/// How one introspected member is rendered as a resolver-indexed statement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GlobalKind {
    /// A Lua function → `function <path>() end`. A live function's parameter
    /// names and arity aren't recoverable, so it is emitted parameterless.
    Function,
    /// A table walked to its members → `<path> = {}` then each member, in the
    /// order given.
    Table(Vec<GlobalNode>),
    /// An opaque indexable handle — a table past the introspection depth cap,
    /// userdata, or a thread → `<path> = {}` with no members.
    Opaque,
    /// A scalar constant → `<path> = <placeholder>` (`0` / `""` / `false`).
    Scalar(ScalarTy),
}

/// One introspected member: `name` is its final dotted segment (e.g.
/// `getModelTime` in `DCS.getModelTime`) and `kind` drives its emitted form.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GlobalNode {
    pub name: String,
    pub kind: GlobalKind,
}

impl GlobalNode {
    pub fn new(name: impl Into<String>, kind: GlobalKind) -> Self {
        Self {
            name: name.into(),
            kind,
        }
    }
}

/// The Lua 5.1 reserved words — none may appear as a dotted segment, or the
/// emitted statement would be a syntax error (`function DCS.end() end`).
const LUA_KEYWORDS: &[&str] = &[
    "and", "break", "do", "else", "elseif", "end", "false", "for", "function", "if", "in", "local",
    "nil", "not", "or", "repeat", "return", "then", "true", "until", "while",
];

/// Whether `name` can be a dotted segment in an emitted statement: a non-empty
/// Lua identifier (`[A-Za-z_][A-Za-z0-9_]*`) that is not a reserved word.
///
/// The DLL-side `_G` walk filters keys through this before building a
/// [`GlobalNode`], so a key that is non-string, oddly-named (`"weird-key"`,
/// `"has space"`), or a keyword is skipped rather than emitted into an
/// unparseable definition file (which the resolver would reject whole).
#[must_use]
pub fn is_emittable_segment(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first.is_ascii_alphabetic() || first == '_') {
        return false;
    }
    if !chars.all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return false;
    }
    !LUA_KEYWORDS.contains(&name)
}

/// Render an introspected `_G` walk — the curated DCS API roots, each a
/// top-level [`GlobalNode`] — as a `.d.lua` file of the dotted global
/// statements the resolver indexes. Each root emits `<root> = {}`; a function
/// emits `function <path>() end`; a nested table recurses under its dotted
/// path. No `---@meta` / `---@class`: only the assign and function-declaration
/// forms `global_match` / `dotted_match` honor.
#[must_use]
pub fn emit_globals_dlua(roots: &[GlobalNode]) -> String {
    let mut out = String::new();
    out.push_str("--- DCS API type definitions, introspected from the running sim's `_G`.\n");
    out.push_str(
        "--- Do not edit by hand: regenerated by dcs_studio.dump_globals() over the link.\n\n",
    );
    for root in roots {
        emit_global_node(&mut out, "", root);
    }
    out
}

/// Emit one node — and, for a table, its members — under `prefix` (the parent's
/// dotted path; empty for a root). The table/opaque arms write the `<path> =
/// {}` the resolver needs at every level before recursing, so each dotted
/// prefix resolves.
fn emit_global_node(out: &mut String, prefix: &str, node: &GlobalNode) {
    let path = if prefix.is_empty() {
        node.name.clone()
    } else {
        format!("{prefix}.{}", node.name)
    };
    match &node.kind {
        GlobalKind::Function => {
            let _ = writeln!(out, "function {path}() end");
        }
        GlobalKind::Table(members) => {
            let _ = writeln!(out, "{path} = {{}}");
            for member in members {
                emit_global_node(out, &path, member);
            }
        }
        GlobalKind::Opaque => {
            let _ = writeln!(out, "{path} = {{}}");
        }
        GlobalKind::Scalar(ty) => {
            let placeholder = match ty {
                ScalarTy::Number => "0",
                ScalarTy::String => "\"\"",
                ScalarTy::Boolean => "false",
            };
            let _ = writeln!(out, "{path} = {placeholder}");
        }
    }
}

// These round-trip tests need the `dcs-lua-syntax` parser crate from the
// original dcs-studio workspace, which is not ported into this repo — without
// the gate they break compilation of EVERY test in the crate. Enable with
// `--features luadef-roundtrip` once that crate is available as a dev-dep.
#[cfg(all(test, feature = "luadef-roundtrip"))]
mod tests {
    use super::*;
    use dcs_lua_syntax::parser::parse;

    fn sample() -> ModuleDoc {
        let mut json = ClassDoc::new("dcs_studio.json");
        json.doc = "JSON encode/decode helpers.".to_string();
        json.functions.push(FnDoc {
            name: "encode".to_string(),
            params: vec![
                Param::new("value", "any", false),
                Param::new("opts", "table", true),
            ],
            returns: vec![Ret::named("string", "json"), Ret::named("string", "err")],
            doc: "Encode a Lua value to a JSON string.".to_string(),
            is_method: false,
        });

        let mut logger = ClassDoc::new("dcs_studio.Logger");
        logger.functions.push(FnDoc {
            name: "info".to_string(),
            params: vec![Param::new("msg", "string", false)],
            returns: vec![],
            doc: "Log at info level.".to_string(),
            is_method: true,
        });

        let mut root = ClassDoc::new("dcs_studio");
        root.doc = "The dcs_studio native module.".to_string();
        root.fields = vec![
            FieldDoc {
                name: "name".to_string(),
                ty: "string".to_string(),
                doc: String::new(),
            },
            FieldDoc {
                name: "json".to_string(),
                ty: "dcs_studio.json".to_string(),
                doc: "JSON helpers.".to_string(),
            },
        ];

        ModuleDoc {
            root: "dcs_studio".to_string(),
            classes: vec![json, logger, root],
        }
    }

    #[test]
    fn emits_meta_class_field_param_return_and_return_stmt() {
        let out = emit_dlua(&sample());
        // NAMED meta: binds the file to the runtime module require() loads.
        assert!(
            out.starts_with("---@meta dcs_studio\n"),
            "must lead with a NAMED @meta:\n{out}"
        );
        assert!(out.contains("---@class dcs_studio.json"), "{out}");
        assert!(out.contains("---@field json dcs_studio.json"), "{out}");
        assert!(out.contains("---@param value any"), "{out}");
        assert!(out.contains("---@param opts? table"), "{out}");
        assert!(out.contains("---@return string json"), "{out}");
        assert!(
            out.contains("function dcs_studio_json.encode(value, opts) end"),
            "{out}"
        );
        // Userdata method renders with a colon receiver, implicit self.
        assert!(
            out.contains("function dcs_studio_Logger:info(msg) end"),
            "{out}"
        );
        assert!(out.trim_end().ends_with("return dcs_studio"), "{out}");
    }

    #[test]
    fn output_parses_under_the_engine_and_the_meta_block_is_recognised() {
        let out = emit_dlua(&sample());
        // The engine's parser is total, but a definition file must be free of
        // syntax errors (SPEC.md §6): the only diagnostics allowed in a `.d.lua`
        // are syntax errors, so a clean parse is the contract.
        let parsed = parse(&out);
        assert!(
            parsed.diagnostics.is_empty(),
            "emitted .d.lua has syntax diagnostics: {:?}\n{out}",
            parsed.diagnostics
        );
    }

    #[test]
    fn local_var_sanitises_dotted_and_numeric_class_names() {
        assert_eq!(local_var("dcs_studio.serde.json"), "dcs_studio_serde_json");
        assert_eq!(local_var("dcs_studio"), "dcs_studio");
        assert_eq!(local_var("123bad"), "_123bad");
    }

    /// A representative introspected tree: a root with a function and a nested
    /// table (itself holding a function + an opaque handle + a scalar), plus a
    /// second root. Mirrors `DCS`/`log` from a live `_G`.
    fn sample_globals() -> Vec<GlobalNode> {
        vec![
            GlobalNode::new(
                "DCS",
                GlobalKind::Table(vec![
                    GlobalNode::new("getModelTime", GlobalKind::Function),
                    GlobalNode::new(
                        "export",
                        GlobalKind::Table(vec![
                            GlobalNode::new("getData", GlobalKind::Function),
                            GlobalNode::new("handle", GlobalKind::Opaque),
                        ]),
                    ),
                ]),
            ),
            GlobalNode::new(
                "log",
                GlobalKind::Table(vec![
                    GlobalNode::new("write", GlobalKind::Function),
                    GlobalNode::new("ERROR", GlobalKind::Scalar(ScalarTy::Number)),
                ]),
            ),
        ]
    }

    #[test]
    fn emits_dotted_global_statements_for_each_kind() {
        let out = emit_globals_dlua(&sample_globals());
        // Roots and nested tables are `<path> = {}` so every dotted prefix resolves.
        assert!(out.contains("DCS = {}"), "{out}");
        assert!(out.contains("DCS.export = {}"), "{out}");
        // Functions emit as dotted function declarations (`dotted_match`).
        assert!(out.contains("function DCS.getModelTime() end"), "{out}");
        assert!(out.contains("function DCS.export.getData() end"), "{out}");
        // Opaque handle: a bare table, no members.
        assert!(out.contains("DCS.export.handle = {}"), "{out}");
        // Scalar: a type-canonical placeholder, never the live value.
        assert!(out.contains("log.ERROR = 0"), "{out}");
        // Never the ambient `@meta`/`@class` forms no resolver honors.
        assert!(!out.contains("---@meta"), "must not emit @meta:\n{out}");
        assert!(!out.contains("---@class"), "must not emit @class:\n{out}");
    }

    #[test]
    fn emitted_globals_parse_clean_under_the_engine() {
        // A `.d.lua` may carry only syntax errors, so a clean parse is the
        // contract (SPEC.md §6) — a malformed dump is rejected whole.
        let parsed = parse(&emit_globals_dlua(&sample_globals()));
        assert!(
            parsed.diagnostics.is_empty(),
            "emitted globals .d.lua has syntax diagnostics: {:?}",
            parsed.diagnostics
        );
    }

    #[test]
    fn empty_globals_emit_only_the_header() {
        let out = emit_globals_dlua(&[]);
        assert!(out.starts_with("--- DCS API type definitions"), "{out}");
        assert!(parse(&out).diagnostics.is_empty(), "{out}");
    }

    #[test]
    fn emittable_segment_accepts_identifiers_and_rejects_the_rest() {
        for ok in ["getModelTime", "_internal", "a1", "Export", "LoGetSelfData"] {
            assert!(is_emittable_segment(ok), "should accept `{ok}`");
        }
        // Empty, leading digit, punctuation/space, and reserved words can't be
        // dotted segments — emitting them would break the parse.
        for bad in [
            "",
            "1bad",
            "weird-key",
            "has space",
            "a.b",
            "end",
            "function",
            "nil",
        ] {
            assert!(!is_emittable_segment(bad), "should reject `{bad}`");
        }
    }
}
