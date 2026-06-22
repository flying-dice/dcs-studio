//! dcs-lua-require — the shared `require("mod")` resolution contract (model
//! `studio::cargolua::ModuleResolver`).
//!
//! Two pure pieces, lifted out of the lua-cargo bundler so the editor and the
//! bundler resolve identically:
//!
//! - [`scan`] — the require scanner: every `require("mod")` reference in a Lua
//!   source, in any of Lua's call forms, with the span of its string argument.
//! - [`roots`] — [`SearchRoots`]: the module-name → file-path mapping. The
//!   priority-ordered search roots a module name is resolved against, and the
//!   first-hit + shadowing rule applied across them.
//!
//! The mapping is **IO-agnostic**: [`SearchRoots::resolve_all`] takes an
//! existence predicate, so the bundler supplies `Path::is_file` (on disk) and
//! the editor supplies workspace membership (mounted files). Same roots, same
//! candidate order, same first-hit/shadow rule — so a require resolves to the
//! same file in both, or is unresolved in both (the parity goal of issue #51).

// Test code is exempt from the production safety lints — indexing/slicing into
// known-shape fixtures and `panic!` on bad setup are idiomatic there (the same
// exemption lua-cargo and the engine crates take).
#![cfg_attr(test, allow(clippy::indexing_slicing, clippy::panic, clippy::print_stderr, clippy::print_stdout))]

pub mod roots;
pub mod scan;

pub use roots::SearchRoots;
pub use scan::{RequireRef, scan_require_refs, scan_requires};
