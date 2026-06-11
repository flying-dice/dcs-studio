//! `dcs-studio-cli bundle` — amalgamate a lua-script project into one
//! PUC-loadable file (issue #9; model: `studio::cli::Bundler`).
//!
//! A standalone subcommand rather than a `build` flag: `build` is the
//! cargo seam for rust-dll projects (exit-code passthrough, toolchain
//! detection) and bundling shares none of that — overloading it would
//! tangle two unrelated flows behind one verb.
//!
//! Shape: the require graph grows from the manifest's `[build] entry`
//! via string-literal `require("...")` calls found by the dcs-lua-syntax
//! AST. A module resolves project-locally against the entry script's
//! folder, then the project root (`<base>/<a/b/c>.lua`, then
//! `<base>/<a/b/c>/init.lua`); anything that does not resolve is left
//! untouched for the DCS runtime to provide. The output is a
//! `package.preload["<name>"]` entry per local module in dependency
//! order, then the entry body verbatim — so require semantics (single
//! execution, module table identity, cache) survive unchanged.
//!
//! Documented limitations: dynamic (non-string-literal) requires are not
//! followed or bundled; module sources must parse without error-severity
//! findings (run `check` first); a require cycle is an error naming the
//! cycle.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use dcs_lua_syntax::Severity;
use dcs_lua_syntax::ast::ExprKind;

/// The whole subcommand: read the manifest, walk, emit, write.
pub fn run(root: &Path) -> ExitCode {
    match bundle(root) {
        Ok(report) => {
            println!(
                "bundled {} module{} into {}",
                report.modules,
                if report.modules == 1 { "" } else { "s" },
                report.output
            );
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("bundle: {message}");
            ExitCode::FAILURE
        }
    }
}

pub struct Report {
    /// Root-relative output path (`dist/<name>`).
    pub output: String,
    /// Project-local modules inlined.
    pub modules: usize,
}

/// Bundle the project at `root` into `dist/`.
///
/// # Errors
///
/// No manifest or no `[build] entry` (bundling never guesses), an
/// unreadable/unparseable entry or module, a require cycle, or a write
/// failure.
pub fn bundle(root: &Path) -> Result<Report, String> {
    if !root.is_dir() {
        return Err(format!("'{}' does not exist", root.display()));
    }
    let manifest = dcs_studio_project::manifest::load(root)?;
    let Some(entry) = manifest.build.entry else {
        return Err(
            "no [build] entry in dcs-studio.toml — add e.g.\n  [build]\n  entry = \"Scripts/<slug>/main.lua\""
                .to_string(),
        );
    };
    let entry_path = root.join(&entry);
    if !entry_path.is_file() {
        return Err(format!(
            "[build] entry '{entry}' does not exist under {}",
            root.display()
        ));
    }

    let mut walk = Walk {
        root,
        entry_dir: entry_path.parent().unwrap_or(root).to_path_buf(),
        entry_path: entry_path.clone(),
        modules: BTreeMap::new(),
        order: Vec::new(),
        stack: Vec::new(),
    };
    let entry_source = read_module(&entry_path)?;
    walk.visit_requires(&entry, &entry_source)?;

    let text = emit(&entry, &entry_source, &walk);
    let output_name = manifest.build.output.unwrap_or_else(|| {
        format!(
            "{}.lua",
            dcs_studio_project::templates::slugify(&manifest.project.name)
        )
    });
    let dist = root.join("dist");
    std::fs::create_dir_all(&dist).map_err(|e| format!("creating {}: {e}", dist.display()))?;
    let output_path = dist.join(&output_name);
    std::fs::write(&output_path, text)
        .map_err(|e| format!("writing {}: {e}", output_path.display()))?;

    Ok(Report {
        output: format!("dist/{output_name}"),
        modules: walk.order.len(),
    })
}

/// Depth-first require walk: post-order collection gives dependency
/// order; the in-progress stack names cycles.
struct Walk<'a> {
    root: &'a Path,
    entry_dir: PathBuf,
    entry_path: PathBuf,
    /// Module name -> source, for emission.
    modules: BTreeMap<String, String>,
    /// Dependency-ordered module names (dependencies before dependents).
    order: Vec<String>,
    /// Modules currently on the DFS path (`context` names for cycles).
    stack: Vec<String>,
}

impl Walk<'_> {
    /// Scan `source` (belonging to `context`, a module name or the entry
    /// path — used in messages) and recurse into every project-local
    /// require.
    fn visit_requires(&mut self, context: &str, source: &str) -> Result<(), String> {
        for name in requires_in(context, source)? {
            if self.stack.contains(&name) {
                let mut cycle = self.stack.clone();
                cycle.push(name);
                return Err(format!("require cycle: {}", cycle.join(" -> ")));
            }
            if self.modules.contains_key(&name) {
                continue; // already bundled (diamond requires are fine)
            }
            let Some(path) = self.resolve(&name) else {
                continue; // not project-local: the DCS runtime provides it
            };
            // The entry is the bundle's top level, not a module: bundling
            // it under preload too would execute its body twice.
            if path == self.entry_path {
                return Err(format!(
                    "module '{name}' resolves to the [build] entry itself — a require back \
                     into the entry is a cycle"
                ));
            }
            let module_source = read_module(&path)?;
            self.stack.push(name.clone());
            self.visit_requires(&name, &module_source)?;
            self.stack.pop();
            self.modules.insert(name.clone(), module_source);
            self.order.push(name);
        }
        Ok(())
    }

    /// Lua's `?`-substitution against the entry folder, then the root:
    /// `a.b.c` -> `a/b/c.lua`, then `a/b/c/init.lua`.
    fn resolve(&self, name: &str) -> Option<PathBuf> {
        let relative = name.replace('.', "/");
        for base in [self.entry_dir.as_path(), self.root] {
            for candidate in [
                base.join(format!("{relative}.lua")),
                base.join(relative.as_str()).join("init.lua"),
            ] {
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
        None
    }
}

fn read_module(path: &Path) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| format!("reading {}: {e}", path.display()))
}

/// Every string-literal `require("...")` argument in `source`, in source
/// order. Errors when the file does not parse clean at error severity —
/// bundling broken Lua would only move the breakage into dist/.
fn requires_in(context: &str, source: &str) -> Result<Vec<String>, String> {
    let parsed = dcs_lua_syntax::parser::parse(source);
    if let Some(error) = parsed
        .diagnostics
        .iter()
        .find(|d| d.severity == Severity::Error)
    {
        return Err(format!(
            "{context} has parse errors ({}); run `dcs-studio-cli check` first",
            error.message
        ));
    }
    let mut names = Vec::new();
    for expr in &parsed.ast.exprs {
        let ExprKind::Call { callee, args } = &expr.kind else {
            continue;
        };
        if !matches!(parsed.ast.expr(*callee).kind, ExprKind::NameRef(ref name) if name == "require")
        {
            continue;
        }
        // String-literal args only; dynamic requires are a documented
        // limitation and stay untouched in the emitted source.
        if let [only] = args.as_slice()
            && let ExprKind::Str { raw } = &parsed.ast.expr(*only).kind
            && let Some(name) = unquote(raw)
        {
            names.push((expr.span.start, name));
        }
    }
    // Arena order is allocation order, not source order — sort by span.
    names.sort_by_key(|(start, _)| *start);
    Ok(names.into_iter().map(|(_, name)| name).collect())
}

/// Decode a Lua string literal: quoted forms with the escapes a module
/// name can carry, and long-bracket forms verbatim.
fn unquote(raw: &str) -> Option<String> {
    if let Some(rest) = raw.strip_prefix("[") {
        // [=*[ ... ]=*]
        let level = rest.chars().take_while(|&c| c == '=').count();
        let open = format!("[{}[", "=".repeat(level));
        let close = format!("]{}]", "=".repeat(level));
        let body = raw.strip_prefix(&open)?.strip_suffix(&close)?;
        return Some(body.to_string());
    }
    let quote = raw.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let body = raw.strip_prefix(quote)?.strip_suffix(quote)?;
    let mut decoded = String::new();
    let mut chars = body.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            decoded.push(c);
            continue;
        }
        match chars.next()? {
            'n' => decoded.push('\n'),
            't' => decoded.push('\t'),
            'r' => decoded.push('\r'),
            '\\' => decoded.push('\\'),
            '"' => decoded.push('"'),
            '\'' => decoded.push('\''),
            // Anything fancier than a module name needs is treated as
            // dynamic: not bundled, left for the runtime.
            _ => return None,
        }
    }
    Some(decoded)
}

/// One file: preload entries in dependency order, then the entry body.
fn emit(entry: &str, entry_source: &str, walk: &Walk<'_>) -> String {
    let mut out = String::new();
    let _ = writeln!(
        out,
        "-- Bundled by `dcs-studio-cli bundle`. DO NOT EDIT — edit the sources and re-bundle.\n\
         -- Entry: {entry}\n\
         -- Modules are registered in package.preload so require() keeps its exact\n\
         -- semantics: single execution, cached module table identity.\n"
    );
    for name in &walk.order {
        let source = &walk.modules[name];
        // `function(...)` so the module sees the name require() passes.
        let _ = writeln!(out, "package.preload[{}] = function(...)", lua_quote(name));
        out.push_str(source);
        if !source.ends_with('\n') {
            out.push('\n');
        }
        let _ = writeln!(out, "end\n");
    }
    let _ = writeln!(out, "-- entry: {entry}");
    out.push_str(entry_source);
    if !entry_source.ends_with('\n') {
        out.push('\n');
    }
    out
}

/// Quote a module name as a Lua string literal.
fn lua_quote(name: &str) -> String {
    format!("\"{}\"", name.replace('\\', "\\\\").replace('"', "\\\""))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unquote_handles_every_literal_form() {
        assert_eq!(unquote("\"a.b\""), Some("a.b".to_string()));
        assert_eq!(unquote("'a-b'"), Some("a-b".to_string()));
        assert_eq!(unquote("[[long]]"), Some("long".to_string()));
        assert_eq!(unquote("[==[lvl]==]"), Some("lvl".to_string()));
        assert_eq!(unquote("\"esc\\\"aped\""), Some("esc\"aped".to_string()));
        // Unsupported escapes are treated as dynamic.
        assert_eq!(unquote("\"\\120\""), None);
    }

    #[test]
    fn requires_found_in_source_order_string_literals_only() {
        let names = requires_in(
            "x.lua",
            r#"
local a = require("first")
require "second"   -- paren-free call sugar
local dynamic = require(name_in_a_variable)
local concat = require("pre" .. "fix")
if true then
  local nested = require('third')
end
"#,
        )
        .expect("parses");
        assert_eq!(names, ["first", "second", "third"]);
    }

    #[test]
    fn parse_errors_refuse_to_bundle() {
        let result = requires_in("broken.lua", "local = require('x')");
        let message = result.expect_err("must refuse");
        assert!(message.contains("broken.lua has parse errors"), "{message}");
    }
}
