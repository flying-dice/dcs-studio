//! The single diagnostic type every stage emits (SPEC.md §3).

use serde::Serialize;

use crate::span::Span;

/// Diagnostic severity. `Error` marks input the engine cannot fully analyse;
/// `Warning`/`Info` advise and never block analysis.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Severity {
    Error,
    Warning,
    Info,
}

/// One message about a span of source. Every stage (lex, parse, static,
/// type, lint) emits this same shape so a driver collects one ordered list.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Diagnostic {
    pub severity: Severity,
    pub span: Span,
    /// Stable identifier from the SPEC.md §3.1 registry.
    pub code: &'static str,
    /// URL of the rule's article; empty when the code carries none.
    pub code_description: &'static str,
    pub message: String,
}

impl Diagnostic {
    #[must_use]
    pub fn error(span: Span, code: &'static str, message: String) -> Self {
        Self {
            severity: Severity::Error,
            span,
            code,
            code_description: "",
            message,
        }
    }
}

/// The SPEC.md §3.1 code registry — lexical and parse ranges.
pub mod codes {
    pub const UNEXPECTED_CHARACTER: &str = "LUA-E001";
    pub const UNTERMINATED_STRING: &str = "LUA-E002";
    pub const UNTERMINATED_LONG_BRACKET: &str = "LUA-E003";
    pub const MALFORMED_NUMBER: &str = "LUA-E004";

    pub const UNEXPECTED_TOKEN: &str = "LUA-E100";
    pub const EXPECTED_TOKEN: &str = "LUA-E101";
    pub const UNTERMINATED_BLOCK: &str = "LUA-E102";
    pub const NESTING_TOO_DEEP: &str = "LUA-E103";

    // Type lints carry kebab-case names (rustc/clippy idiom), not numeric
    // codes — they are levelled (`allow`/`warn`/`deny`/`forbid`) inline and in
    // `dcs-studio.toml`. The lexical/parse codes above keep `LUA-Exxx`, the
    // analog of rustc's hard-error `E####` codes (a parse failure is not a lint).

    /// An argument's type is not assignable to the declared `@param` type.
    pub const ARGUMENT_TYPE_MISMATCH: &str = "param-type-mismatch";

    /// An operator was applied to an operand whose type does not fit it
    /// (arithmetic/concat/length on a non-numeric, non-coercible value).
    pub const OPERATOR_TYPE_MISMATCH: &str = "operator-type-mismatch";

    /// An argument's type conflicts with how the (un-annotated) parameter is
    /// used in the callee body.
    pub const ARGUMENT_USAGE_MISMATCH: &str = "param-usage-mismatch";

    /// An `---@expect` directive named a lint that did not fire in its scope
    /// (the analog of rustc's `unfulfilled_lint_expectations`).
    pub const UNFULFILLED_EXPECTATION: &str = "unfulfilled-lint-expectation";
}
