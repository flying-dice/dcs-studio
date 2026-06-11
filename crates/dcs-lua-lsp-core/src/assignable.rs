//! The type-compatibility rule.
//!
//! `assignable(arg, param)` answers "may a value of type `arg` be passed
//! where `param` is expected?". It is deliberately **conservative**: when in
//! doubt it returns `true`, so the checker only ever flags a provably-wrong
//! call. `Any`/`Unknown`/`Generic` are compatible both ways; `nil` satisfies
//! an optional; a union is assignable iff every member is; named types match
//! through the `@class` parent chain and `@alias`/`@enum` resolution; arrays
//! and dicts are covariant on their element types.

use dcs_lua_syntax::Type;

use crate::ty_table::TypeTable;

/// Whether `arg` is assignable to `param`, resolving named types via `table`.
#[must_use]
pub fn assignable(arg: &Type, param: &Type, table: &TypeTable) -> bool {
    // The escape hatches: anything goes through `any`/`unknown`/generics, in
    // either direction, and an unresolved named type never flags.
    if is_wildcard(arg) || is_wildcard(param) {
        return true;
    }

    // Resolve aliases on both sides before structural comparison.
    if let Type::Named(name) = param
        && let Some(target) = table.alias(name)
    {
        return assignable(arg, target, table);
    }
    if let Type::Named(name) = arg
        && let Some(target) = table.alias(name)
    {
        return assignable(target, param, table);
    }

    // Arms are ordered for precedence (an optional/union check must precede
    // the structural fallbacks), so several share a `true` body by design.
    #[allow(clippy::match_same_arms)]
    match (arg, param) {
        // Optional parameter: nil is fine, otherwise the inner type rules.
        (Type::Nil, Type::Optional(_)) => true,
        (_, Type::Optional(inner)) => assignable(arg, inner, table),
        (Type::Optional(inner), _) => {
            // An optional arg is assignable only if both nil and the inner
            // type are accepted — conservatively require the inner match.
            assignable(inner, param, table)
        }

        // Union parameter: the arg must fit at least one member.
        (_, Type::Union(members)) => members.iter().any(|m| assignable(arg, m, table)),
        // Union arg: every member must fit the parameter.
        (Type::Union(members), _) => members.iter().all(|m| assignable(m, param, table)),

        // Literals are assignable to their base primitive.
        (Type::LiteralString(_), Type::String) | (Type::LiteralNumber(_), Type::Number) => true,
        (Type::LiteralString(a), Type::LiteralString(b)) => a == b,
        (Type::LiteralNumber(a), Type::LiteralNumber(b)) => a == b,

        // Arrays / dicts: covariant on element types.
        (Type::Array(a), Type::Array(b)) => assignable(a, b, table),
        (
            Type::Dict { key: ak, value: av },
            Type::Dict { key: bk, value: bv },
        ) => assignable(ak, bk, table) && assignable(av, bv, table),
        // An array or dict is still a table where a plain table is expected.
        (Type::Array(_) | Type::Dict { .. } | Type::Table, Type::Table) => true,

        // Named types: a class is assignable to itself or an ancestor.
        (Type::Named(a), Type::Named(b)) => {
            if a == b {
                return true;
            }
            // Unknown classes never flag (conservative).
            if !table.is_known(a) || !table.is_known(b) {
                return true;
            }
            table.ancestry(a).iter().any(|ancestor| ancestor == b)
        }

        // Functions: arity-compatible, params contravariant, returns
        // covariant — but kept lenient (missing detail => compatible).
        (Type::Function { .. }, Type::Function { .. }) => true,

        // Identical primitives.
        _ => arg == param,
    }
}

/// `Any`, `Unknown`, and `Generic` suppress all checking.
fn is_wildcard(ty: &Type) -> bool {
    matches!(ty, Type::Any | Type::Unknown | Type::Generic(_))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty() -> TypeTable {
        TypeTable::default()
    }

    #[test]
    fn primitive_mismatch_flags() {
        assert!(!assignable(&Type::Number, &Type::String, &empty()));
        assert!(assignable(&Type::String, &Type::String, &empty()));
    }

    #[test]
    fn wildcards_never_flag() {
        assert!(assignable(&Type::Number, &Type::Any, &empty()));
        assert!(assignable(&Type::Any, &Type::String, &empty()));
        assert!(assignable(&Type::Unknown, &Type::String, &empty()));
        assert!(assignable(&Type::Generic("T".into()), &Type::String, &empty()));
    }

    #[test]
    fn optional_accepts_nil() {
        let opt = Type::Optional(Box::new(Type::String));
        assert!(assignable(&Type::Nil, &opt, &empty()));
        assert!(assignable(&Type::String, &opt, &empty()));
        assert!(!assignable(&Type::Number, &opt, &empty()));
    }

    #[test]
    fn union_param_accepts_any_member() {
        let u = Type::Union(vec![Type::String, Type::Number]);
        assert!(assignable(&Type::Number, &u, &empty()));
        assert!(!assignable(&Type::Boolean, &u, &empty()));
    }

    #[test]
    fn literal_to_primitive() {
        assert!(assignable(&Type::LiteralString("n".into()), &Type::String, &empty()));
        assert!(!assignable(&Type::LiteralString("n".into()), &Type::Number, &empty()));
    }

    #[test]
    fn unknown_classes_never_flag() {
        // With an empty table neither class is known, so the conservative
        // rule keeps quiet. The ancestry path is covered by the
        // workspace-level `ty_table` and `check` tests.
        assert!(assignable(
            &Type::Named("Dog".into()),
            &Type::Named("Animal".into()),
            &empty()
        ));
        assert!(assignable(
            &Type::Named("Same".into()),
            &Type::Named("Same".into()),
            &empty()
        ));
    }
}
