//! The LuaLS/EmmyLua type lattice (SPEC.md §4), the DCS Lua 5.1 subset.
//!
//! `Type` is what the annotation type-expression parser yields and what
//! inference produces. It is deliberately small: the DCS dialect targets a
//! single runtime, so there are no version-conditional shapes. `Any` is the
//! total fallback for an unknown name or malformed annotation text — it is
//! compatible with everything, so the checker never false-positives on it.
//! `Unknown` marks an expression the engine could not infer (distinct from
//! the author writing `any`).

use serde::Serialize;

/// A parsed or inferred Lua type.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum Type {
    Nil,
    Boolean,
    Number,
    String,
    /// An unconstrained table (no element types known).
    Table,
    /// `fun(params): ret` — `ret` is the (possibly multi-value) return list.
    Function {
        params: Vec<Type>,
        ret: Vec<Type>,
    },
    /// `T[]`.
    Array(Box<Type>),
    /// `table<K, V>`.
    Dict {
        key: Box<Type>,
        value: Box<Type>,
    },
    /// `A | B | ...` (always two or more members; flattened, never nested).
    Union(Vec<Type>),
    /// `T?` — sugar for `T | nil`, kept distinct for nicer rendering.
    Optional(Box<Type>),
    /// A `@class`/`@alias`/`@enum` reference, resolved by the type table.
    Named(String),
    /// A `@generic` type parameter in scope.
    Generic(String),
    /// A literal string type, e.g. `"north"`.
    LiteralString(String),
    /// A literal number type, e.g. `42`.
    LiteralNumber(String),
    /// The explicit `any` annotation: compatible with everything.
    Any,
    /// Inference could not determine a type. Compatible with everything so
    /// it never produces a false positive.
    Unknown,
}

impl Type {
    /// A primitive type name (`string`, `number`, …) if this is one.
    #[must_use]
    pub fn primitive_name(&self) -> Option<&'static str> {
        match self {
            Type::Nil => Some("nil"),
            Type::Boolean => Some("boolean"),
            Type::Number => Some("number"),
            Type::String => Some("string"),
            Type::Table => Some("table"),
            _ => None,
        }
    }

    /// Render the type the way `LuaLS` does, for hover cards and inlay hints.
    #[must_use]
    pub fn render(&self) -> String {
        match self {
            Type::Nil => "nil".to_string(),
            Type::Boolean => "boolean".to_string(),
            Type::Number => "number".to_string(),
            Type::String => "string".to_string(),
            Type::Table => "table".to_string(),
            Type::Function { params, ret } => {
                let ps = params.iter().map(Type::render).collect::<Vec<_>>().join(", ");
                if ret.is_empty() {
                    format!("fun({ps})")
                } else {
                    let rs = ret.iter().map(Type::render).collect::<Vec<_>>().join(", ");
                    format!("fun({ps}): {rs}")
                }
            }
            Type::Array(inner) => format!("{}[]", inner.render()),
            Type::Dict { key, value } => format!("table<{}, {}>", key.render(), value.render()),
            Type::Union(members) => members.iter().map(Type::render).collect::<Vec<_>>().join("|"),
            Type::Optional(inner) => format!("{}?", inner.render()),
            Type::Named(name) | Type::Generic(name) => name.clone(),
            Type::LiteralString(value) => format!("\"{value}\""),
            Type::LiteralNumber(raw) => raw.clone(),
            Type::Any => "any".to_string(),
            Type::Unknown => "unknown".to_string(),
        }
    }
}
