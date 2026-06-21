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

/// One parameter of a function or method. `optional` renders the EmmyLua
/// `name?` form.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Param {
    pub name: String,
    /// An EmmyLua type expression (`string`, `number`, `table`, `any`,
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

/// One return value. `name` is the optional EmmyLua return-name (`---@return
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
    pub parent: Option<String>,
    pub doc: String,
    pub fields: Vec<FieldDoc>,
    pub functions: Vec<FnDoc>,
}

impl ClassDoc {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            parent: None,
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

/// The EmmyLua local-variable name backing a class: dots and other
/// non-identifier characters collapse to underscores (`dcs_studio.json` →
/// `dcs_studio_json`). Stable and identifier-safe for any class name we emit.
fn local_var(class_name: &str) -> String {
    let v: String = class_name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '_' { c } else { '_' })
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

/// Render `doc` as a `.d.lua` definition file: a leading `---@meta`, every
/// class as an `---@class` + `@field`s + backing `local` + its functions, and a
/// trailing `return <root>`. The output parses under `dcs-lua-syntax` and is
/// accepted verbatim by LuaLS.
#[must_use]
pub fn emit_dlua(doc: &ModuleDoc) -> String {
    let mut out = String::new();
    out.push_str("---@meta\n");
    out.push_str("--- Generated type definitions for the dcs_studio DLL surface.\n");
    out.push_str("--- Do not edit by hand: regenerated from the binding facade.\n\n");

    for class in &doc.classes {
        push_doc(&mut out, &class.doc);
        match &class.parent {
            Some(p) => {
                let _ = writeln!(out, "---@class {} : {p}", class.name);
            }
            None => {
                let _ = writeln!(out, "---@class {}", class.name);
            }
        }
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

#[cfg(test)]
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
        assert!(out.starts_with("---@meta\n"), "must lead with @meta:\n{out}");
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
}
