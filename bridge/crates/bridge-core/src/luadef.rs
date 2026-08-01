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

/// Collapse a doc line's whitespace: runs of spaces and tabs become one space,
/// and the ends are trimmed.
///
/// The doc strings this generator renders are prose assembled from Rust string
/// literals, and the `\`-at-end-of-line continuation that keeps those literals
/// readable is easy to lose while leaving its indentation behind. That is not a
/// hypothetical: a `JsonRpcServer.new` doc carried 18 literal spaces into the
/// middle of a sentence in both checked-in `.d.lua` goldens, because rustfmt
/// does not reach inside a string literal and nothing between the literal and
/// the file did either. Normalising here means the layout of the *source*
/// literal cannot change the *generated* artefact — the only whitespace that
/// survives is the line structure, which `push_doc` reads separately.
fn normalise_doc_line(line: &str) -> String {
    line.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Push a `---` doc body, one `--- ` line per source line. A blank `doc`
/// emits nothing.
fn push_doc(out: &mut String, doc: &str) {
    for line in doc.lines() {
        let line = normalise_doc_line(line);
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
                    // A `@field` comment is one line by construction, so the
                    // newlines fold into spaces — and then through the same
                    // normaliser, so a folded paragraph break does not leave a
                    // double space behind.
                    normalise_doc_line(&field.doc.replace('\n', " "))
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

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // idiomatic in tests
mod emitter_tests {
    use super::{
        emit_dlua, emit_globals_dlua, is_emittable_segment, ClassDoc, FieldDoc, FnDoc, GlobalKind,
        GlobalNode, ModuleDoc, ScalarTy,
    };

    /// The DLL-side `_G` walk filters every key through this before emitting a
    /// dotted statement. A key that slipped past would land in the generated
    /// file as a syntax error, and `LuaLS` rejects a definition file *whole* —
    /// one bad global would silently kill completion for the entire DCS API.
    #[test]
    fn only_plain_lua_identifiers_survive_the_segment_filter() {
        assert!(is_emittable_segment("getModelTime"));
        assert!(is_emittable_segment("_private"));
        assert!(is_emittable_segment("ERROR_2"));

        assert!(!is_emittable_segment(""), "an empty key names nothing");
        assert!(!is_emittable_segment("2fast"), "a leading digit");
        assert!(!is_emittable_segment("-dash"), "a leading punctuation");
        assert!(!is_emittable_segment("weird-key"), "an interior dash");
        assert!(!is_emittable_segment("has space"));
        // `function DCS.end() end` would not parse.
        assert!(!is_emittable_segment("end"));
        assert!(!is_emittable_segment("function"));
    }

    /// Each scalar renders as a canonical placeholder *of its type* rather than
    /// the live build's value, so the member hovers as the right type without
    /// baking this install's sim data into the checked-in definitions.
    #[test]
    fn scalars_render_as_a_placeholder_of_their_own_type() {
        let out = emit_globals_dlua(&[GlobalNode::new(
            "log",
            GlobalKind::Table(vec![
                GlobalNode::new("ERROR", GlobalKind::Scalar(ScalarTy::Number)),
                GlobalNode::new("NAME", GlobalKind::Scalar(ScalarTy::String)),
                GlobalNode::new("DEBUG", GlobalKind::Scalar(ScalarTy::Boolean)),
                GlobalNode::new("write", GlobalKind::Function),
                GlobalNode::new("handle", GlobalKind::Opaque),
            ]),
        )]);

        assert!(
            out.ends_with(concat!(
                "log = {}\n",
                "log.ERROR = 0\n",
                "log.NAME = \"\"\n",
                "log.DEBUG = false\n",
                "function log.write() end\n",
                "log.handle = {}\n",
            )),
            "{out}"
        );
    }

    /// The backing `local` is derived from the class name, which contains dots.
    /// A name that would start the local with a digit gets an underscore, since
    /// `local 3d = {}` is not parseable — and an unparseable definition file is
    /// rejected whole.
    #[test]
    fn the_backing_local_is_always_a_valid_lua_identifier() {
        let doc = ModuleDoc {
            root: "3d.api".to_string(),
            classes: vec![ClassDoc::new("3d.api")],
        };
        let out = emit_dlua(&doc);
        assert!(out.contains("local _3d_api = {}"), "{out}");
        assert!(out.trim_end().ends_with("return _3d_api"), "{out}");
    }

    /// A field with no documentation emits the bare `@field`, and a blank line
    /// inside a doc body emits a bare `---` — both are how `LuaLS` renders a
    /// paragraph break in hover text. Dropping the blank line would run two
    /// paragraphs of a binding's docs together in the editor.
    #[test]
    fn documentation_renders_bare_fields_and_paragraph_breaks() {
        let mut class = ClassDoc::new("m");
        class.doc = "First paragraph.\n\nSecond paragraph.".to_string();
        class.fields = vec![
            FieldDoc {
                name: "undocumented".to_string(),
                ty: "string".to_string(),
                doc: String::new(),
            },
            FieldDoc {
                name: "documented".to_string(),
                ty: "number".to_string(),
                doc: "Why it exists.".to_string(),
            },
        ];
        let out = emit_dlua(&ModuleDoc {
            root: "m".to_string(),
            classes: vec![class],
        });

        assert!(
            out.contains("--- First paragraph.\n---\n--- Second paragraph.\n"),
            "{out}"
        );
        assert!(out.contains("---@field undocumented string\n"), "{out}");
        assert!(
            out.contains("---@field documented number # Why it exists.\n"),
            "{out}"
        );
    }

    /// The layout of the source string literal must not reach the generated
    /// file. Both checked-in goldens carried 18 literal spaces mid-sentence
    /// because a `\` line-continuation was lost from a Rust string literal and
    /// its indentation was not — rustfmt does not look inside a literal, and
    /// nothing downstream looked either. Runs of spaces and tabs collapse, ends
    /// are trimmed, and a folded paragraph break in a `@field` leaves one space
    /// rather than two; only the line structure survives.
    #[test]
    fn intra_doc_whitespace_is_normalised_away() {
        let mut class = ClassDoc::new("m");
        class.doc = "Leaked          continuation.\n\tTabbed  and   spaced.  ".to_string();
        class.fields = vec![FieldDoc {
            name: "folded".to_string(),
            ty: "number".to_string(),
            doc: "One.\n\nTwo.".to_string(),
        }];
        class.functions = vec![FnDoc {
            name: "f".to_string(),
            params: vec![],
            returns: vec![],
            doc: "Spread    out.".to_string(),
            is_method: false,
        }];
        let out = emit_dlua(&ModuleDoc {
            root: "m".to_string(),
            classes: vec![class],
        });

        assert!(
            out.contains("--- Leaked continuation.\n--- Tabbed and spaced.\n"),
            "{out}"
        );
        assert!(
            out.contains("---@field folded number # One. Two.\n"),
            "{out}"
        );
        assert!(out.contains("--- Spread out.\n"), "{out}");
        assert!(!out.contains("  "), "double space survived: {out}");
    }
}
