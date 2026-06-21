//! `require("mod")` resolution — the engine half of issue #51's parity goal.
//!
//! Go-to-definition and hover on a `require` string, and the unresolved /
//! shadowing diagnostics, all resolve a module name to a file through the SAME
//! [`SearchRoots`](dcs_lua_require::SearchRoots) the lua-cargo bundler uses. The
//! one difference is the existence predicate: the bundler asks the filesystem
//! (`Path::is_file`), the editor asks the workspace (is this candidate a mounted
//! file). The analyzer walks exactly the trees the bundler reads, so the two
//! sets agree — a require resolves to the same file in the editor and the
//! bundle, or is unresolved in both. Nothing here does I/O.
//!
//! Resolution needs a project context (root + vendored deps,
//! [`Workspace::set_resolution`]). A workspace with none — a unit fixture, the
//! in-page lab harness — has no search roots, so resolution and its diagnostics
//! are inert.

use std::path::{Path, PathBuf};

use dcs_lua_require::{RequireRef, SearchRoots, scan_require_refs};
use dcs_lua_syntax::diagnostic::{Severity, codes};
use dcs_lua_syntax::{Diagnostic, Span};

use crate::definition::Location;
use crate::hover::HoverInfo;
use crate::workspace::Workspace;

/// All distinct files `module` (required from the file at `from_path`) resolves
/// to, first chosen and any others shadowed — empty for a host built-in or a
/// workspace with no project context. The shared `SearchRoots` with workspace
/// membership as the existence predicate (no I/O), so the verdict matches the
/// bundler's.
fn resolve(workspace: &Workspace, from_path: &str, module: &str) -> Vec<PathBuf> {
    let Some(context) = workspace.resolution() else {
        return Vec::new();
    };
    let roots = SearchRoots::new(&context.root, Path::new(from_path), &context.vendored);
    roots.resolve_all(module, |candidate| is_mounted(workspace, candidate))
}

/// Whether `candidate` (an absolute path a search root produced) is a mounted
/// workspace file — the editor's analogue of the bundler's `Path::is_file`.
fn is_mounted(workspace: &Workspace, candidate: &Path) -> bool {
    workspace.file(&candidate.display().to_string()).is_some()
}

/// The `require("mod")` reference whose string argument contains `offset` (the
/// quotes included), if the cursor sits inside one.
fn require_at(src: &str, offset: u32) -> Option<RequireRef> {
    scan_require_refs(src)
        .into_iter()
        .find(|req| req.span.start <= offset && offset <= req.span.end)
}

/// `textDocument/definition` on a `require("mod")` string: the module file it
/// resolves to (the first hit — the one the bundler amalgamates), caret at the
/// file start. `None` over a non-require string, an unresolved require (a host
/// module), or a workspace with no project context.
#[must_use]
pub fn require_definition(workspace: &Workspace, path: &str, offset: u32) -> Option<Location> {
    let entry = workspace.file(path)?;
    let req = require_at(&entry.source, offset)?;
    let target = resolve(workspace, path, &req.module).into_iter().next()?;
    Some(Location {
        path: target.display().to_string(),
        span: Span::empty(0),
    })
}

/// `textDocument/hover` on a `require("mod")` string: where it resolves, or that
/// it is left to the host `require`. `None` outside a require string or a
/// workspace with no project context (where "unresolved" would be meaningless).
#[must_use]
pub fn require_hover(workspace: &Workspace, path: &str, offset: u32) -> Option<HoverInfo> {
    workspace.resolution()?;
    let entry = workspace.file(path)?;
    let req = require_at(&entry.source, offset)?;
    let hits = resolve(workspace, path, &req.module);
    let title = format!("require \"{}\"", req.module);
    let body = match hits.split_first() {
        None => "unresolved — left to the host `require` at runtime".to_string(),
        Some((chosen, [])) => format!("resolves to `{}`", chosen.display()),
        Some((chosen, shadowed)) => {
            format!("resolves to `{}` (shadows {})", chosen.display(), join_paths(shadowed))
        }
    };
    Some(HoverInfo { title, body })
}

/// Every unresolved-require and shadowing finding across the workspace — the
/// require half of the finding set ([`crate::analysis::findings_by_file`] folds
/// it in beside the type checker, ordered by path then offset). Inert without a
/// project context. Both codes are WARNING by default: a host / DCS built-in
/// legitimately resolves to nothing, so a require never hard-errors unless a
/// project opts in (`---@deny`, `[lints.lua]`).
#[must_use]
pub fn check_requires(workspace: &Workspace) -> Vec<(String, Diagnostic)> {
    let Some(context) = workspace.resolution() else {
        return Vec::new();
    };
    let mut findings = Vec::new();
    for (path, entry) in workspace.files() {
        let roots = SearchRoots::new(&context.root, Path::new(path), &context.vendored);
        for req in scan_require_refs(&entry.source) {
            let hits = roots.resolve_all(&req.module, |candidate| is_mounted(workspace, candidate));
            if let Some(diagnostic) = require_finding(&req, &hits) {
                findings.push((path.to_string(), diagnostic));
            }
        }
    }
    findings.sort_by(|a, b| (a.0.as_str(), a.1.span.start).cmp(&(b.0.as_str(), b.1.span.start)));
    findings
}

/// The diagnostic a resolved require warrants: unresolved (no hit) or shadowing
/// (more than one), else clean (exactly one). Placed on the require's string
/// argument — the same verdict the bundler reports (the parity contract).
fn require_finding(req: &RequireRef, hits: &[PathBuf]) -> Option<Diagnostic> {
    match hits.split_first() {
        None => Some(Diagnostic {
            severity: Severity::Warning,
            span: req.span,
            code: codes::UNRESOLVED_REQUIRE,
            code_description: "",
            message: format!(
                "unresolved require '{}' — left to the host require at runtime",
                req.module
            ),
        }),
        Some((_, [])) => None,
        Some((chosen, shadowed)) => Some(Diagnostic {
            severity: Severity::Warning,
            span: req.span,
            code: codes::REQUIRE_SHADOWING,
            code_description: "",
            message: format!(
                "module '{}' resolves to {} files; using '{}', shadowing {}",
                req.module,
                hits.len(),
                chosen.display(),
                join_paths(shadowed)
            ),
        }),
    }
}

fn join_paths(paths: &[PathBuf]) -> String {
    paths.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    const ROOT: &str = "/proj";

    /// A workspace rooted at `/proj` with `vendored` deps and `files` mounted at
    /// absolute paths under the root — mirroring how the analyzer mounts a walked
    /// tree, so the resolver's candidate paths match the mounted keys.
    fn workspace(vendored: &[&str], files: &[(&str, &str)]) -> Workspace {
        let mut ws = Workspace::new();
        for (path, text) in files {
            ws.set_source(path, text);
        }
        let vendored = vendored
            .iter()
            .map(|n| (n.to_string(), PathBuf::from(format!("{ROOT}/.lua-cargo/deps/{n}"))))
            .collect::<BTreeMap<_, _>>();
        ws.set_resolution(PathBuf::from(ROOT), vendored);
        ws
    }

    /// Byte offset of the `nth` (0-based) occurrence of `needle` in `src`.
    fn at(src: &str, needle: &str, nth: usize) -> u32 {
        src.match_indices(needle).nth(nth).expect("needle").0 as u32
    }

    #[test]
    fn resolves_a_local_module_and_a_vendored_dep_clean() {
        let main = "local u = require(\"util\")\nlocal m = require(\"moose\")\nreturn u\n";
        let ws = workspace(
            &["moose"],
            &[
                ("/proj/src/main.lua", main),
                ("/proj/src/util.lua", "return {}\n"),
                ("/proj/.lua-cargo/deps/moose/init.lua", "return {}\n"),
            ],
        );
        // Both requires resolve to a mounted file → no findings.
        assert!(check_requires(&ws).is_empty(), "{:?}", check_requires(&ws));
    }

    #[test]
    fn unresolved_host_module_is_a_warning() {
        let main = "local s = require(\"socket\")\nreturn s\n";
        let ws = workspace(&[], &[("/proj/src/main.lua", main)]);
        let findings = check_requires(&ws);
        assert_eq!(findings.len(), 1, "{findings:?}");
        assert_eq!(findings[0].1.code, codes::UNRESOLVED_REQUIRE);
        assert_eq!(findings[0].1.severity, Severity::Warning);
        // The squiggle sits on the `"socket"` argument.
        assert_eq!(findings[0].1.span.start, at(main, "\"socket\"", 0));
    }

    #[test]
    fn a_module_in_two_roots_is_a_shadowing_warning() {
        let main = "return require(\"shared\")\n";
        let ws = workspace(
            &["shared"],
            &[
                ("/proj/src/main.lua", main),
                ("/proj/src/shared.lua", "return \"local\"\n"),
                ("/proj/.lua-cargo/deps/shared/init.lua", "return \"vendored\"\n"),
            ],
        );
        let findings = check_requires(&ws);
        assert_eq!(findings.len(), 1, "{findings:?}");
        assert_eq!(findings[0].1.code, codes::REQUIRE_SHADOWING);
        assert!(findings[0].1.message.contains("shadowing"), "{}", findings[0].1.message);
    }

    #[test]
    fn definition_jumps_into_the_vendored_dep() {
        let main = "local m = require(\"moose\")\nreturn m\n";
        let ws = workspace(
            &["moose"],
            &[
                ("/proj/src/main.lua", main),
                ("/proj/.lua-cargo/deps/moose/init.lua", "return {}\n"),
            ],
        );
        // Caret inside the `"moose"` string resolves into the vendored checkout.
        let loc = require_definition(&ws, "/proj/src/main.lua", at(main, "moose", 0))
            .expect("definition");
        assert_eq!(loc.path, "/proj/.lua-cargo/deps/moose/init.lua");
        assert_eq!(loc.span, Span::empty(0), "lands at the module file start");
    }

    #[test]
    fn definition_off_a_require_string_is_none() {
        let main = "local m = require(\"moose\")\nreturn m\n";
        let ws = workspace(&["moose"], &[("/proj/src/main.lua", main)]);
        // On the `local` keyword, not a require argument.
        assert!(require_definition(&ws, "/proj/src/main.lua", at(main, "local", 0)).is_none());
        // An unresolved require has no target to jump to.
        let host = "return require(\"socket\")\n";
        let ws2 = workspace(&[], &[("/proj/src/h.lua", host)]);
        assert!(require_definition(&ws2, "/proj/src/h.lua", at(host, "socket", 0)).is_none());
    }

    #[test]
    fn hover_reports_the_resolved_target() {
        let main = "local m = require(\"moose\")\nreturn m\n";
        let ws = workspace(
            &["moose"],
            &[
                ("/proj/src/main.lua", main),
                ("/proj/.lua-cargo/deps/moose/init.lua", "return {}\n"),
            ],
        );
        let card = require_hover(&ws, "/proj/src/main.lua", at(main, "moose", 0)).expect("hover");
        assert_eq!(card.title, "require \"moose\"");
        assert!(card.body.contains("moose/init.lua"), "{}", card.body);
    }

    #[test]
    fn no_project_context_means_no_require_findings() {
        // A bare workspace (no `set_resolution`) cannot resolve modules, so even a
        // clearly-unresolved require stays silent — there are no search roots.
        let mut ws = Workspace::new();
        ws.set_source("/proj/src/main.lua", "return require(\"socket\")\n");
        assert!(check_requires(&ws).is_empty());
        assert!(require_hover(&ws, "/proj/src/main.lua", 16).is_none());
    }
}
