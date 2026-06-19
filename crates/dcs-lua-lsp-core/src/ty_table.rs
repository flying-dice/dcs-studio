//! The workspace named-type table.
//!
//! Built from every `@class`, `@alias`, and `@enum` annotation block across
//! the mounted workspace; resolves [`Type::Named`] during compatibility
//! checks. Cheap to rebuild (one pass over cached trivia + parse), so the
//! checker builds it once per `check_types` call.

use std::collections::HashMap;

use dcs_lua_syntax::{FieldAnno, Type};

use crate::annot::all_blocks;
use crate::workspace::Workspace;

/// A `@class` definition: its declared fields and optional parent.
#[derive(Debug, Clone, Default)]
pub struct ClassDef {
    pub parent: Option<String>,
    pub fields: Vec<FieldAnno>,
}

/// The workspace-wide table of named types.
#[derive(Debug, Default)]
pub struct TypeTable {
    classes: HashMap<String, ClassDef>,
    aliases: HashMap<String, Type>,
    enums: std::collections::HashSet<String>,
}

impl TypeTable {
    /// Build the table from every annotation block in the workspace.
    #[must_use]
    pub fn build(workspace: &Workspace) -> Self {
        let mut table = TypeTable::default();
        for (_, entry) in workspace.files() {
            // Every doc-comment run can carry a `@class`/`@alias`/`@enum`,
            // whether or not a declaration follows it — `.d.lua` definition
            // files declare types with no statements beneath them.
            for block in all_blocks(entry) {
                table.absorb(&block);
            }
        }
        table
    }

    fn absorb(&mut self, block: &dcs_lua_syntax::AnnotationBlock) {
        if let Some(name) = &block.class_name {
            let def = self.classes.entry(name.clone()).or_default();
            if block.class_parent.is_some() {
                def.parent.clone_from(&block.class_parent);
            }
            for f in &block.fields {
                if !def.fields.iter().any(|existing| existing.name == f.name) {
                    def.fields.push(f.clone());
                }
            }
        }
        if let Some(name) = &block.alias_name
            && let Some(ty) = &block.alias_type
        {
            self.aliases.insert(name.clone(), ty.clone());
        }
        if let Some(name) = &block.enum_name {
            self.enums.insert(name.clone());
        }
    }

    /// The class definition for `name`, if declared.
    #[must_use]
    pub fn class(&self, name: &str) -> Option<&ClassDef> {
        self.classes.get(name)
    }

    /// The alias target for `name`, if declared.
    #[must_use]
    pub fn alias(&self, name: &str) -> Option<&Type> {
        self.aliases.get(name)
    }

    /// Whether `name` is a declared enum.
    #[must_use]
    pub fn is_enum(&self, name: &str) -> bool {
        self.enums.contains(name)
    }

    /// Whether `name` is known to the table at all.
    #[must_use]
    pub fn is_known(&self, name: &str) -> bool {
        self.classes.contains_key(name) || self.aliases.contains_key(name) || self.is_enum(name)
    }

    /// The `@class` ancestor chain for `name` (including `name` itself).
    #[must_use]
    pub fn ancestry(&self, name: &str) -> Vec<String> {
        let mut chain = vec![name.to_string()];
        let mut current = name.to_string();
        // Guard against cyclic `@class A : A` declarations.
        while let Some(def) = self.classes.get(&current) {
            match &def.parent {
                Some(parent) if !chain.contains(parent) => {
                    chain.push(parent.clone());
                    current = parent.clone();
                }
                _ => break,
            }
        }
        chain
    }
}
