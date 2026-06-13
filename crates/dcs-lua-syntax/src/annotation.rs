//! The annotation block parser (SPEC.md §4).
//!
//! Turns a contiguous `---` doc run (already marker-stripped, in source
//! order) into a structured [`AnnotationBlock`]. Type-carrying tags
//! (`@param`, `@return`, `@type`, `@class`, `@field`, `@alias`, `@enum`)
//! feed the type checker; the rest are recognised so they do not leak into
//! the doc body. Total: an unknown tag is ignored and a malformed type
//! expression degrades to [`Type::Any`] (via [`crate::type_expr::parse_type`]).

use crate::ty::Type;
use crate::type_expr::parse_type;

/// One `@param name type` declaration. `optional` is the `name?` form.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParamAnno {
    pub name: String,
    pub ty: Type,
    pub optional: bool,
}

/// One `@field name type` of a `@class`. An index field `[K]` renders its
/// key type into `name` surrounded by brackets. `optional` is the `name?` form.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FieldAnno {
    pub name: String,
    pub ty: Type,
    pub optional: bool,
}

/// A structured `---` doc run attached to the following declaration.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AnnotationBlock {
    pub params: Vec<ParamAnno>,
    pub returns: Vec<Type>,
    pub var_type: Option<Type>,
    pub class_name: Option<String>,
    pub class_parent: Option<String>,
    pub fields: Vec<FieldAnno>,
    pub alias_name: Option<String>,
    pub alias_type: Option<Type>,
    pub enum_name: Option<String>,
    pub generics: Vec<String>,
    pub is_meta: bool,
    /// The free-text doc body (non-tag lines), joined and trimmed.
    pub doc: String,
}

impl AnnotationBlock {
    /// The declared type of parameter `name`, if annotated.
    #[must_use]
    pub fn param_type(&self, name: &str) -> Option<&ParamAnno> {
        self.params.iter().find(|p| p.name == name)
    }

    /// Whether the block carries any tag at all (vs. being a plain comment).
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.params.is_empty()
            && self.returns.is_empty()
            && self.var_type.is_none()
            && self.class_name.is_none()
            && self.fields.is_empty()
            && self.alias_name.is_none()
            && self.enum_name.is_none()
            && self.generics.is_empty()
            && !self.is_meta
    }
}

/// Parse a contiguous doc run into an [`AnnotationBlock`].
#[must_use]
pub fn parse_block(lines: &[&str]) -> AnnotationBlock {
    let mut block = AnnotationBlock::default();
    let mut doc_lines: Vec<String> = Vec::new();

    for raw in lines {
        let line = raw.trim();
        let Some(rest) = line.strip_prefix('@') else {
            if !line.is_empty() {
                doc_lines.push(line.to_string());
            }
            continue;
        };
        let (tag, args) = split_first_word(rest);
        match tag {
            "param" => {
                if let Some(p) = parse_param(args) {
                    block.params.push(p);
                }
            }
            "return" => {
                // `@return type [name]` — take the leading type expression.
                let (ty_text, _) = split_first_word(args);
                block.returns.push(parse_type(ty_text));
            }
            "type" => {
                let (ty_text, _) = split_first_word(args);
                block.var_type = Some(parse_type(ty_text));
            }
            "class" => parse_class(args, &mut block),
            "field" => {
                if let Some(f) = parse_field(args) {
                    block.fields.push(f);
                }
            }
            "alias" => {
                let (name, ty_text) = split_first_word(args);
                if !name.is_empty() {
                    block.alias_name = Some(name.to_string());
                    if !ty_text.trim().is_empty() {
                        block.alias_type = Some(parse_type(ty_text.trim()));
                    }
                }
            }
            "enum" => {
                let (name, _) = split_first_word(args);
                if !name.is_empty() {
                    block.enum_name = Some(name.to_string());
                }
            }
            "generic" => {
                // `@generic T [: parent] [, U]` — collect the parameter names.
                for part in args.split(',') {
                    let name = part.split(':').next().unwrap_or("").trim();
                    if !name.is_empty() {
                        block.generics.push(name.to_string());
                    }
                }
            }
            "meta" => block.is_meta = true,
            // Recognised-but-not-yet-gating tags: consumed so they do not
            // pollute the doc body. Unknown tags fall here too and are dropped.
            _ => {}
        }
    }

    rewrite_generics(&mut block);
    block.doc = doc_lines.join("\n").trim().to_string();
    block
}

/// `@param name[?] type` (the type runs to end of line).
fn parse_param(args: &str) -> Option<ParamAnno> {
    let (name_tok, ty_text) = split_first_word(args);
    if name_tok.is_empty() {
        return None;
    }
    let (name, optional) = strip_optional(name_tok);
    Some(ParamAnno {
        name: name.to_string(),
        ty: parse_type(ty_text.trim()),
        optional,
    })
}

/// `@field name[?] type` or `@field [keyType] type`.
fn parse_field(args: &str) -> Option<FieldAnno> {
    let args = args.trim();
    if let Some(after) = args.strip_prefix('[') {
        // `[keyType] valueType`
        let (key, rest) = after.split_once(']')?;
        return Some(FieldAnno {
            name: format!("[{}]", key.trim()),
            ty: parse_type(rest.trim()),
            optional: false,
        });
    }
    let (name_tok, ty_text) = split_first_word(args);
    if name_tok.is_empty() {
        return None;
    }
    let (name, optional) = strip_optional(name_tok);
    Some(FieldAnno {
        name: name.to_string(),
        ty: parse_type(ty_text.trim()),
        optional,
    })
}

/// `@class Name [: Parent]`.
fn parse_class(args: &str, block: &mut AnnotationBlock) {
    let args = args.trim();
    if let Some((name, parent)) = args.split_once(':') {
        let name = name.trim();
        if !name.is_empty() {
            block.class_name = Some(name.to_string());
            let parent = parent.trim();
            if !parent.is_empty() {
                block.class_parent = Some(parent.to_string());
            }
        }
    } else if !args.is_empty() {
        let (name, _) = split_first_word(args);
        block.class_name = Some(name.to_string());
    }
}

/// Rewrite `Named(n)` into `Generic(n)` for every `n` in the block's
/// `@generic` parameter set, recursively.
fn rewrite_generics(block: &mut AnnotationBlock) {
    if block.generics.is_empty() {
        return;
    }
    let generics = block.generics.clone();
    for p in &mut block.params {
        rewrite_ty(&mut p.ty, &generics);
    }
    for r in &mut block.returns {
        rewrite_ty(r, &generics);
    }
    if let Some(t) = &mut block.var_type {
        rewrite_ty(t, &generics);
    }
}

fn rewrite_ty(ty: &mut Type, generics: &[String]) {
    match ty {
        Type::Named(name) if generics.iter().any(|g| g == name) => {
            *ty = Type::Generic(name.clone());
        }
        Type::Array(inner) | Type::Optional(inner) => rewrite_ty(inner, generics),
        Type::Dict { key, value } => {
            rewrite_ty(key, generics);
            rewrite_ty(value, generics);
        }
        Type::Union(members) => {
            for m in members {
                rewrite_ty(m, generics);
            }
        }
        Type::Function { params, ret } => {
            for p in params {
                rewrite_ty(p, generics);
            }
            for r in ret {
                rewrite_ty(r, generics);
            }
        }
        _ => {}
    }
}

/// Split off the leading `?` optional marker from a parameter/field name.
fn strip_optional(tok: &str) -> (&str, bool) {
    tok.strip_suffix('?').map_or((tok, false), |base| (base, true))
}

/// Split `s` into its first whitespace-delimited word and the remainder
/// (remainder keeps interior spacing, leading whitespace trimmed).
fn split_first_word(s: &str) -> (&str, &str) {
    let s = s.trim_start();
    match s.find(char::is_whitespace) {
        Some(i) => (&s[..i], s[i..].trim_start()),
        None => (s, ""),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn param_and_return() {
        let b = parse_block(&["@param msg string", "@return boolean"]);
        assert_eq!(b.params.len(), 1);
        assert_eq!(b.params[0].name, "msg");
        assert_eq!(b.params[0].ty, Type::String);
        assert_eq!(b.returns, vec![Type::Boolean]);
    }

    #[test]
    fn optional_param() {
        let b = parse_block(&["@param name? string"]);
        assert!(b.params[0].optional);
        assert_eq!(b.params[0].ty, Type::String);
    }

    #[test]
    fn class_with_parent_and_fields() {
        let b = parse_block(&["@class Dog : Animal", "@field name string", "@field age? number"]);
        assert_eq!(b.class_name.as_deref(), Some("Dog"));
        assert_eq!(b.class_parent.as_deref(), Some("Animal"));
        assert_eq!(b.fields.len(), 2);
        assert!(b.fields[1].optional);
    }

    #[test]
    fn alias_and_enum() {
        let b = parse_block(&["@alias Color string"]);
        assert_eq!(b.alias_name.as_deref(), Some("Color"));
        assert_eq!(b.alias_type, Some(Type::String));
        let e = parse_block(&["@enum Heading"]);
        assert_eq!(e.enum_name.as_deref(), Some("Heading"));
    }

    #[test]
    fn generic_param_becomes_generic_type() {
        let b = parse_block(&["@generic T", "@param x T", "@return T"]);
        assert_eq!(b.params[0].ty, Type::Generic("T".to_string()));
        assert_eq!(b.returns, vec![Type::Generic("T".to_string())]);
    }

    #[test]
    fn doc_text_and_meta() {
        let b = parse_block(&["A logger.", "@meta", "@param msg string"]);
        assert!(b.is_meta);
        assert_eq!(b.doc, "A logger.");
        assert!(!b.is_empty());
    }

    #[test]
    fn unknown_tag_dropped_total() {
        let b = parse_block(&["@nonsense whatever", "@param msg string"]);
        assert_eq!(b.params.len(), 1);
        assert_eq!(b.doc, "");
    }
}
