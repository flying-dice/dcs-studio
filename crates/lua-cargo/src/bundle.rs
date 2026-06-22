//! The require-graph bundler/amalgamator (model `studio::cargolua::Bundler`).
//! From each `[[bundle]]` entry, walk the `require("mod")` graph
//! ([`dcs_lua_require::scan_requires`]), resolve each module name to a file
//! under the shared [`SearchRoots`] (the same mapping the editor resolves
//! through — issue #51 parity), and emit ONE self-contained Lua 5.1 file behind
//! a `__require` shim.
//!
//! Each module's source is embedded as a STRING LITERAL (byte-for-byte) and
//! instantiated with `load()` at require time (the luabundle model). Embedding
//! source as data — never as wrapped code — makes the amalgamation BREAKOUT-PROOF:
//! a module body can't close a wrapper and inject bundle-top-level code. The
//! loaded chunk runs under a `setfenv` env so its `require` is the bundle's shim
//! (without clobbering the host `_G.require`). Requires that resolve to neither a
//! local module nor a vendored dep (DCS built-ins / host-provided) become
//! warnings, never failures: the shim falls back to a host `require` at runtime.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use dcs_lua_require::{SearchRoots, scan_requires};

use crate::manifest::{self, BundleTarget};
use crate::{CargoError, resolve};

/// The outcome of a bundle: the emitted file, the module names amalgamated
/// (sorted), and the requires that resolved to nothing (warnings).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BundleReport {
    pub output: PathBuf,
    pub modules: Vec<String>,
    pub warnings: Vec<String>,
}

/// Bundle every `[[bundle]]` target of the project at `root`.
///
/// Returns the report of the LAST target (the common case is a single bundle);
/// every target is still emitted. An empty `[[bundle]]` list yields an empty
/// report.
///
/// # Errors
///
/// A missing/malformed manifest ([`CargoError::Manifest`]) or an entry path
/// that does not exist ([`CargoError::MissingEntry`]).
pub fn bundle(root: &Path) -> Result<BundleReport, CargoError> {
    let manifest = manifest::find_and_parse(root)?;
    let vendored = resolve::vendored_roots(root).unwrap_or_default();

    let mut last = BundleReport {
        output: root.join("dist"),
        modules: Vec::new(),
        warnings: Vec::new(),
    };
    for target in &manifest.bundle {
        last = bundle_one(root, target, &vendored)?;
    }
    Ok(last)
}

/// Bundle a single `[[bundle]]` target.
fn bundle_one(
    root: &Path,
    target: &BundleTarget,
    vendored: &BTreeMap<String, PathBuf>,
) -> Result<BundleReport, CargoError> {
    let entry_path = root.join(&target.path);
    if !entry_path.is_file() {
        return Err(CargoError::MissingEntry(target.path.clone()));
    }

    let search = SearchRoots::new(root, &entry_path, vendored);
    let entry_module = module_name_of_entry(&target.path);

    // Walk the require graph, keyed by canonical module name.
    let mut modules: BTreeMap<String, String> = BTreeMap::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut stack: Vec<(String, PathBuf)> = vec![(entry_module.clone(), entry_path.clone())];

    while let Some((name, path)) = stack.pop() {
        if modules.contains_key(&name) {
            continue; // cycle / diamond guard
        }
        let src = std::fs::read_to_string(&path)
            .map_err(|e| CargoError::Io(format!("reading {}: {e}", path.display())))?;
        for req in scan_requires(&src) {
            if modules.contains_key(&req) || stack.iter().any(|(n, _)| n == &req) {
                continue;
            }
            // On disk: a candidate exists when it is a readable file. The editor
            // passes workspace membership instead — same roots, same verdict.
            let hits = search.resolve_all(&req, |p| p.is_file());
            if let Some(found) = hits.first() {
                if hits.len() > 1 {
                    let others: Vec<String> =
                        hits.iter().skip(1).map(|p| p.display().to_string()).collect();
                    let w = format!(
                        "module '{req}' resolves to {} files; using '{}', shadowing {}",
                        hits.len(),
                        found.display(),
                        others.join(", ")
                    );
                    if !warnings.contains(&w) {
                        warnings.push(w);
                    }
                }
                stack.push((req.clone(), found.clone()));
            } else {
                let w = format!("unresolved require '{req}' — left to the host require at runtime");
                if !warnings.contains(&w) {
                    warnings.push(w);
                }
            }
        }
        modules.insert(name, src);
    }

    let output_path = root.join("dist").join(&target.name);
    let emitted = emit_bundle(&modules, &entry_module);
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| CargoError::Io(format!("creating dist dir: {e}")))?;
    }
    std::fs::write(&output_path, emitted)
        .map_err(|e| CargoError::Io(format!("writing bundle: {e}")))?;

    warnings.sort();
    Ok(BundleReport {
        output: output_path,
        modules: modules.into_keys().collect(),
        warnings,
    })
}

/// Derive the entry module name from its project-relative path: drop a `.lua`
/// suffix and turn separators into dots (`src/main.lua` → `src.main`,
/// `foo/init.lua` → `foo`).
fn module_name_of_entry(rel: &str) -> String {
    let norm = rel.replace('\\', "/");
    let stem = norm.strip_suffix(".lua").unwrap_or(&norm);
    let stem = stem.strip_suffix("/init").unwrap_or(stem);
    stem.trim_start_matches("./").replace('/', ".")
}

/// Emit the self-contained bundle. `modules` is name → source. Each module's
/// source is embedded as a STRING LITERAL (never wrapped code), so a module body
/// can never close a wrapper and break out into bundle-top-level scope — it is
/// data until `load()` turns it into a chunk at require time (the luabundle
/// model). The chunk runs under a setfenv'd env so its `require` is the bundle's
/// without clobbering the host `_G.require`.
fn emit_bundle(modules: &BTreeMap<String, String>, entry: &str) -> String {
    let mut out = String::new();
    let _ = writeln!(
        out,
        "-- Generated by lua-cargo. Self-contained amalgamation; do not edit."
    );
    out.push_str(
        r#"local __modules = {}
local __loaded = {}
local __load = loadstring or load
local __hostrequire = rawget(_G, "require")
local __require
-- Per-module env: reads/writes pass through to _G (so a module's own globals
-- land normally), but `require` resolves into this bundle.
local __env = setmetatable({}, {
  __index = function(_, k) if k == "require" then return __require end return _G[k] end,
  __newindex = function(_, k, v) rawset(_G, k, v) end,
})
__require = function(name)
  local cached = __loaded[name]
  if cached ~= nil then return cached.value end
  local src = __modules[name]
  if src ~= nil then
    if not __load then error("lua-cargo bundle: load/loadstring unavailable for '" .. name .. "'") end
    local chunk, err = __load(src, "=" .. name)
    if not chunk then error("lua-cargo bundle: error loading '" .. name .. "': " .. tostring(err)) end
    if setfenv then setfenv(chunk, __env) end
    local result = chunk()
    if result == nil then result = true end
    __loaded[name] = { value = result }
    return result
  end
  if __hostrequire then return __hostrequire(name) end
  error("module '" .. name .. "' not found in bundle")
end

"#,
    );

    // Module sources as string literals, name-sorted (BTreeMap) for determinism.
    for (name, src) in modules {
        let _ = writeln!(out, "__modules[{}] = {}", lua_quote(name), lua_string_literal(src));
    }

    let _ = writeln!(out, "\nreturn __require({})", lua_quote(entry));
    out
}

/// A Lua double-quoted string literal of a bare module name.
fn lua_quote(s: &str) -> String {
    let escaped = s.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

/// A Lua double-quoted string literal carrying `s` byte-for-byte. Every byte is
/// represented (printables literally, the rest as `\ddd` decimal escapes), so
/// the output is clean ASCII text and a module body can never break out of the
/// quotes — making the amalgamation breakout-proof.
fn lua_string_literal(s: &str) -> String {
    use std::fmt::Write as _;
    let mut out = String::from("\"");
    for &b in s.as_bytes() {
        match b {
            b'\\' => out.push_str("\\\\"),
            b'"' => out.push_str("\\\""),
            b'\n' => out.push_str("\\n"),
            b'\r' => out.push_str("\\r"),
            b'\t' => out.push_str("\\t"),
            0x20..=0x7e => out.push(b as char),
            other => {
                let _ = write!(out, "\\{other:03}");
            }
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;

    struct TempTree(PathBuf);

    impl TempTree {
        fn new(tag: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "lua-cargo-bundle-{tag}-{}-{}",
                std::process::id(),
                nanos()
            ));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(&root).expect("root");
            TempTree(root)
        }
        fn write(&self, rel: &str, contents: &str) {
            let path = self.0.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).expect("parent");
            std::fs::write(path, contents).expect("write");
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn nanos() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    }

    fn project_with_local_and_vendored() -> TempTree {
        let tree = TempTree::new("p");
        tree.write(
            "CargoLua.toml",
            "[package]\nname = \"p\"\n[dependencies]\nmoose = { github = \"a/moose\" }\n\n[[bundle]]\nname = \"out.lua\"\npath = \"src/main.lua\"\n",
        );
        // Entry requires a local module `util` and a vendored dep module `moose`.
        tree.write(
            "src/main.lua",
            "local util = require(\"util\")\nlocal moose = require(\"moose\")\nreturn util.go() + moose.x\n",
        );
        tree.write("src/util.lua", "local M = {}\nfunction M.go() return 1 end\nreturn M\n");
        // Stub a vendored dep directly on disk (no git): .lua-cargo/deps/moose.
        tree.write(
            ".lua-cargo/deps/moose/init.lua",
            "local M = { x = 2 }\nreturn M\n",
        );
        // A directory existence marker so vendored_roots() sees the checkout.
        tree.write(".lua-cargo/deps/moose/.keep", "");
        tree
    }

    #[test]
    fn bundles_one_file_with_shim_and_tail() {
        let tree = project_with_local_and_vendored();
        let report = bundle(&tree.0).expect("bundle");

        let out = tree.0.join("dist").join("out.lua");
        assert!(out.is_file(), "one dist file produced");
        assert_eq!(report.output, out);

        let text = std::fs::read_to_string(&out).unwrap();
        assert!(text.contains("__require = function(name)"), "shim present");
        assert!(text.contains("return __require(\"src.main\")"), "entry tail: {text}");
        assert!(text.contains("__modules[\"util\"] = \""), "local module is a string literal");
        assert!(text.contains("__modules[\"moose\"] = \""), "vendored module is a string literal");
        // No unresolved requires here.
        assert!(report.warnings.is_empty(), "warnings: {:?}", report.warnings);
        // util, moose, src.main.
        assert!(report.modules.contains(&"util".to_string()));
        assert!(report.modules.contains(&"moose".to_string()));
    }

    #[test]
    fn a_hostile_module_body_cannot_break_out_of_the_bundle() {
        // Under the old verbatim-wrapper this body closed the wrapper (`end`) and
        // injected top-level code. As a string literal it is inert DATA.
        let mut modules = BTreeMap::new();
        modules.insert(
            "evil".to_string(),
            "return 1\nend\nPWNED = true\n__modules = {}\nlocal _ = function()".to_string(),
        );
        let text = emit_bundle(&modules, "evil");
        // The body appears ONLY inside a quoted string literal (newlines escaped
        // to \n), so its `end`/`PWNED` are characters, not live Lua tokens.
        assert!(
            text.contains(r#"__modules["evil"] = "return 1\nend\nPWNED = true"#),
            "body embedded as a string literal: {text}"
        );
        // No LIVE breakout: `PWNED = true` never appears on its own source line.
        assert!(!text.contains("\nPWNED = true\n"), "breakout code is not live: {text}");
        // The injected `__modules = {}` likewise can't clobber the real table.
        assert!(!text.contains("\n__modules = {}\n"), "no live table clobber: {text}");
    }

    /// Oracle: actually RUN the emitted bundle under the lua5.1 interpreter — the
    /// require graph must resolve through the load()+setfenv shim, and a module's
    /// own global must write through to _G. Proves the mechanism, not just parse.
    /// The PUC Lua 5.1 interpreter, pinned to the SAME toolchain as the compile
    /// oracle: the interpreter beside `DCS_PUC_LUAC` (CI sets it; `luac`→`lua`),
    /// else a `lua5.1` on PATH. Tying it to DCS_PUC_LUAC stops a stray non-5.1
    /// `lua5.1` (e.g. LuaJIT, which accepts `load(string)`) from masking a
    /// 5.1-only load-form regression — the round-1 vacuity.
    fn puc_lua51() -> Option<String> {
        if let Ok(luac) = std::env::var("DCS_PUC_LUAC") {
            let lua = luac.replacen("luac", "lua", 1);
            if Command::new(&lua).arg("-v").output().is_ok() {
                return Some(lua);
            }
        }
        Command::new("lua5.1")
            .arg("-v")
            .output()
            .ok()
            .map(|_| "lua5.1".to_string())
    }

    #[test]
    fn bundle_runs_and_resolves_requires_under_lua51() {
        let Some(lua) = puc_lua51() else {
            eprintln!("skip: no PUC lua5.1 interpreter (DCS_PUC_LUAC or PATH)");
            return;
        };
        let tree = TempTree::new("exec");
        tree.write(
            "CargoLua.toml",
            "[package]\nname = \"x\"\n\n[[bundle]]\nname = \"out.lua\"\npath = \"src/main.lua\"\n",
        );
        tree.write("src/util.lua", "return { greet = function() return \"hi-from-util\" end }\n");
        // Entry requires util, then sets a global MOOSE-style (must reach _G).
        tree.write(
            "src/main.lua",
            "local u = require(\"util\")\nMY_GLOBAL = u.greet()\nprint(MY_GLOBAL)\nreturn 0\n",
        );
        bundle(&tree.0).expect("bundle");
        let out = Command::new(&lua)
            .arg(tree.0.join("dist").join("out.lua"))
            .output()
            .expect("run lua5.1");
        assert!(out.status.success(), "bundle ran: {}", String::from_utf8_lossy(&out.stderr));
        assert_eq!(
            String::from_utf8_lossy(&out.stdout).trim(),
            "hi-from-util",
            "require resolved + module global written through to _G"
        );
    }

    #[test]
    fn rerun_is_deterministic() {
        let tree = project_with_local_and_vendored();
        bundle(&tree.0).expect("bundle 1");
        let first = std::fs::read(tree.0.join("dist").join("out.lua")).unwrap();
        bundle(&tree.0).expect("bundle 2");
        let second = std::fs::read(tree.0.join("dist").join("out.lua")).unwrap();
        assert_eq!(first, second, "byte-for-byte deterministic");
    }

    #[test]
    fn unresolved_require_is_a_warning_not_an_error() {
        let tree = TempTree::new("warn");
        tree.write(
            "CargoLua.toml",
            "[package]\nname = \"p\"\n[[bundle]]\nname = \"out.lua\"\npath = \"src/main.lua\"\n",
        );
        tree.write(
            "src/main.lua",
            "local net = require(\"socket\")\nreturn net\n",
        );
        let report = bundle(&tree.0).expect("bundle still succeeds");
        assert_eq!(report.warnings.len(), 1);
        assert!(
            report.warnings[0].contains("unresolved require 'socket'"),
            "descriptive unresolved warning: {:?}",
            report.warnings
        );
    }

    #[test]
    fn a_module_resolving_in_two_roots_is_a_shadowing_warning() {
        let tree = TempTree::new("shadow");
        tree.write(
            "CargoLua.toml",
            "[package]\nname = \"p\"\n[dependencies]\nshared = { github = \"a/shared\" }\n\n[[bundle]]\nname = \"out.lua\"\npath = \"src/main.lua\"\n",
        );
        tree.write("src/main.lua", "return require(\"shared\")\n");
        // Same module name present BOTH locally and in a vendored dep.
        tree.write("src/shared.lua", "return \"local\"\n");
        tree.write(".lua-cargo/deps/shared/init.lua", "return \"vendored\"\n");
        tree.write(".lua-cargo/deps/shared/.keep", "");
        let report = bundle(&tree.0).expect("bundle");
        assert!(
            report.warnings.iter().any(|w| w.contains("shadowing")),
            "collision warned: {:?}",
            report.warnings
        );
    }

    #[test]
    fn missing_entry_is_an_error() {
        let tree = TempTree::new("missing");
        tree.write(
            "CargoLua.toml",
            "[package]\nname = \"p\"\n[[bundle]]\nname = \"out.lua\"\npath = \"src/nope.lua\"\n",
        );
        let err = bundle(&tree.0).unwrap_err();
        assert!(matches!(err, CargoError::MissingEntry(_)), "{err:?}");
    }

    #[test]
    fn cycle_does_not_loop_forever() {
        let tree = TempTree::new("cycle");
        tree.write(
            "CargoLua.toml",
            "[package]\nname = \"p\"\n[[bundle]]\nname = \"out.lua\"\npath = \"src/main.lua\"\n",
        );
        tree.write("src/main.lua", "require(\"a\")\nreturn 1\n");
        tree.write("src/a.lua", "require(\"b\")\nreturn 1\n");
        tree.write("src/b.lua", "require(\"a\")\nreturn 1\n");
        let report = bundle(&tree.0).expect("bundle");
        assert!(report.modules.contains(&"a".to_string()));
        assert!(report.modules.contains(&"b".to_string()));
    }

    /// Oracle: if `luac5.1` is on PATH, the emitted bundle must parse.
    #[test]
    fn emitted_bundle_parses_with_luac_if_available() {
        if Command::new("luac5.1").arg("-v").output().is_err() {
            return; // gate on availability
        }
        let tree = project_with_local_and_vendored();
        bundle(&tree.0).expect("bundle");
        let out = tree.0.join("dist").join("out.lua");
        let status = Command::new("luac5.1")
            .arg("-p")
            .arg(&out)
            .status()
            .expect("run luac5.1");
        assert!(status.success(), "luac5.1 -p rejected the bundle");
    }
}
