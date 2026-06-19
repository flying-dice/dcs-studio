//! The type-expression sub-parser (SPEC.md §4).
//!
//! Parses the text after an annotation tag (`string`, `A|B`, `T?`, `T[]`,
//! `table<K, V>`, `{ k: T }`, `fun(a: T): R`, `"literal"`, `42`) into a
//! [`Type`]. Total by contract: any malformed or unrecognised input yields
//! [`Type::Any`], never a panic and never an error — the annotation layer
//! must never destabilise analysis.
//!
//! Bare identifiers become [`Type::Named`]; the annotation parser rewrites
//! names that match a block's `@generic` parameters into [`Type::Generic`].

use crate::ty::Type;

/// Parse one type expression. Returns [`Type::Any`] on any malformed input.
#[must_use]
pub fn parse_type(text: &str) -> Type {
    let mut p = Parser {
        chars: text.chars().collect(),
        pos: 0,
    };
    let ty = p.union();
    p.skip_ws();
    // Trailing junk means we did not understand the whole expression.
    if p.pos < p.chars.len() {
        return Type::Any;
    }
    ty
}

struct Parser {
    chars: Vec<char>,
    pos: usize,
}

impl Parser {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.pos).copied()
    }

    fn skip_ws(&mut self) {
        while matches!(self.peek(), Some(c) if c.is_whitespace()) {
            self.pos += 1;
        }
    }

    fn eat(&mut self, c: char) -> bool {
        self.skip_ws();
        if self.peek() == Some(c) {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    /// `union := postfix ('|' postfix)*`
    fn union(&mut self) -> Type {
        let mut members = vec![self.postfix()];
        while self.eat('|') {
            members.push(self.postfix());
        }
        if members.len() == 1 {
            // len == 1 just checked; `Type::Any` is the unreachable-case default.
            members.pop().unwrap_or(Type::Any)
        } else {
            flatten_union(members)
        }
    }

    /// `postfix := primary ('[' ']' | '?')*`
    fn postfix(&mut self) -> Type {
        let mut ty = self.primary();
        loop {
            self.skip_ws();
            if self.peek() == Some('?') {
                self.pos += 1;
                ty = Type::Optional(Box::new(ty));
            } else if self.peek() == Some('[') {
                // Only `[]`; `[indexKey]` would be a parse we don't model here.
                let save = self.pos;
                self.pos += 1;
                if self.eat(']') {
                    ty = Type::Array(Box::new(ty));
                } else {
                    self.pos = save;
                    break;
                }
            } else {
                break;
            }
        }
        ty
    }

    fn primary(&mut self) -> Type {
        self.skip_ws();
        match self.peek() {
            Some('(') => {
                self.pos += 1;
                let inner = self.union();
                if self.eat(')') { inner } else { Type::Any }
            }
            Some('{') => self.table_literal(),
            Some('"' | '\'') => self.literal_string(),
            Some(c) if c.is_ascii_digit() || c == '-' => self.literal_number(),
            Some(c) if is_name_start(c) => self.named_or_keyword(),
            _ => Type::Any,
        }
    }

    fn literal_string(&mut self) -> Type {
        // The caller (`primary`) only dispatches here on a peeked quote, so this
        // is Some; fall back to `Any` rather than panic if that ever changes.
        let Some(quote) = self.peek() else {
            return Type::Any;
        };
        self.pos += 1;
        let mut s = String::new();
        while let Some(c) = self.peek() {
            self.pos += 1;
            if c == quote {
                return Type::LiteralString(s);
            }
            s.push(c);
        }
        Type::Any
    }

    // `self.chars[start..self.pos]`: `start` is a saved `self.pos`, which only
    // advances while `peek()` is Some, so start <= self.pos <= chars.len().
    #[allow(clippy::indexing_slicing)]
    fn literal_number(&mut self) -> Type {
        let start = self.pos;
        if self.peek() == Some('-') {
            self.pos += 1;
        }
        while matches!(self.peek(), Some(c) if c.is_ascii_digit() || c == '.' || c == 'x'
            || c.is_ascii_hexdigit())
        {
            self.pos += 1;
        }
        let raw: String = self.chars[start..self.pos].iter().collect();
        if raw.is_empty() || raw == "-" {
            Type::Any
        } else {
            Type::LiteralNumber(raw)
        }
    }

    // `self.chars[start..self.pos]`: scanner invariant start <= self.pos <= len.
    #[allow(clippy::indexing_slicing)]
    fn name(&mut self) -> String {
        let start = self.pos;
        while matches!(self.peek(), Some(c) if is_name_continue(c)) {
            self.pos += 1;
        }
        self.chars[start..self.pos].iter().collect()
    }

    fn named_or_keyword(&mut self) -> Type {
        let name = self.name();
        match name.as_str() {
            "nil" => Type::Nil,
            "boolean" | "bool" | "true" | "false" => Type::Boolean,
            "number" | "integer" | "int" => Type::Number,
            "string" => Type::String,
            "table" => self.maybe_table_generic(),
            "any" => Type::Any,
            "unknown" => Type::Unknown,
            "fun" => self.function_type(),
            _ => Type::Named(name),
        }
    }

    /// `table` or `table<K, V>`.
    fn maybe_table_generic(&mut self) -> Type {
        self.skip_ws();
        if self.peek() != Some('<') {
            return Type::Table;
        }
        self.pos += 1;
        let key = self.union();
        if !self.eat(',') {
            return Type::Any;
        }
        let value = self.union();
        if self.eat('>') {
            Type::Dict {
                key: Box::new(key),
                value: Box::new(value),
            }
        } else {
            Type::Any
        }
    }

    /// `fun(a: T, b: T): R, S` — parameter names are optional and dropped.
    fn function_type(&mut self) -> Type {
        if !self.eat('(') {
            return Type::Any;
        }
        let mut params = Vec::new();
        if !self.eat(')') {
            loop {
                params.push(self.param_type());
                if self.eat(')') {
                    break;
                }
                if !self.eat(',') {
                    return Type::Any;
                }
            }
        }
        let mut ret = Vec::new();
        if self.eat(':') {
            loop {
                ret.push(self.union());
                if !self.eat(',') {
                    break;
                }
            }
        }
        Type::Function { params, ret }
    }

    /// A function parameter: an optional `name:` prefix then a type.
    fn param_type(&mut self) -> Type {
        self.skip_ws();
        // `...` vararg parameter.
        if self.peek() == Some('.') {
            while self.peek() == Some('.') {
                self.pos += 1;
            }
            // Optional `: T` after `...`.
            if self.eat(':') {
                return self.union();
            }
            return Type::Any;
        }
        // Look ahead for a `name:` label (not `::` and not a generic `<`).
        let save = self.pos;
        if matches!(self.peek(), Some(c) if is_name_start(c)) {
            let _ = self.name();
            self.skip_ws();
            if self.peek() == Some(':') {
                self.pos += 1;
                return self.union();
            }
            // No label — rewind and parse the name as a type.
            self.pos = save;
        }
        self.union()
    }

    /// `{ k: T, [K]: V, ... }` — modelled coarsely as a table or dict.
    fn table_literal(&mut self) -> Type {
        // Consume the brace and everything to the matching close; we model
        // the shape as a plain table (field-level checking is out of scope
        // for this slice — see plan "Out of scope").
        if !self.eat('{') {
            return Type::Any;
        }
        let mut depth = 1;
        while let Some(c) = self.peek() {
            self.pos += 1;
            match c {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return Type::Table;
                    }
                }
                _ => {}
            }
        }
        Type::Any
    }
}

/// Flatten nested unions and drop duplicates while preserving order.
fn flatten_union(members: Vec<Type>) -> Type {
    let mut flat: Vec<Type> = Vec::new();
    for m in members {
        match m {
            Type::Union(inner) => {
                for t in inner {
                    if !flat.contains(&t) {
                        flat.push(t);
                    }
                }
            }
            other => {
                if !flat.contains(&other) {
                    flat.push(other);
                }
            }
        }
    }
    if flat.len() == 1 {
        // len == 1 just checked; `Type::Any` is the unreachable-case default.
        flat.pop().unwrap_or(Type::Any)
    } else {
        Type::Union(flat)
    }
}

fn is_name_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_'
}

fn is_name_continue(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '.'
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn primitives() {
        assert_eq!(parse_type("string"), Type::String);
        assert_eq!(parse_type(" number "), Type::Number);
        assert_eq!(parse_type("integer"), Type::Number);
        assert_eq!(parse_type("nil"), Type::Nil);
        assert_eq!(parse_type("any"), Type::Any);
    }

    #[test]
    fn named_and_generic_left_as_named() {
        assert_eq!(parse_type("Unit"), Type::Named("Unit".to_string()));
    }

    #[test]
    fn optional_and_array() {
        assert_eq!(parse_type("string?"), Type::Optional(Box::new(Type::String)));
        assert_eq!(parse_type("number[]"), Type::Array(Box::new(Type::Number)));
    }

    #[test]
    fn union_flattens() {
        assert_eq!(
            parse_type("string|number"),
            Type::Union(vec![Type::String, Type::Number])
        );
        assert_eq!(
            parse_type("string|number|string"),
            Type::Union(vec![Type::String, Type::Number])
        );
    }

    #[test]
    fn table_generic() {
        assert_eq!(
            parse_type("table<string, number>"),
            Type::Dict {
                key: Box::new(Type::String),
                value: Box::new(Type::Number)
            }
        );
        assert_eq!(parse_type("table"), Type::Table);
    }

    #[test]
    fn function_type() {
        assert_eq!(
            parse_type("fun(a: string): number"),
            Type::Function {
                params: vec![Type::String],
                ret: vec![Type::Number]
            }
        );
        assert_eq!(
            parse_type("fun()"),
            Type::Function {
                params: vec![],
                ret: vec![]
            }
        );
    }

    #[test]
    fn literals() {
        assert_eq!(parse_type("\"north\""), Type::LiteralString("north".to_string()));
        assert_eq!(parse_type("42"), Type::LiteralNumber("42".to_string()));
    }

    #[test]
    fn malformed_is_any_never_panics() {
        assert_eq!(parse_type(""), Type::Any);
        assert_eq!(parse_type("table<string"), Type::Any);
        assert_eq!(parse_type("fun(a:"), Type::Any);
        assert_eq!(parse_type("fun("), Type::Any);
        assert_eq!(parse_type(">>>"), Type::Any);
    }
}
