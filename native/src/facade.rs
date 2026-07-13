//! tealr-style binding facade: register an mlua surface and record its
//! `.d.lua` type at the *same* call site, so the live `dcs_studio` module and
//! its generated type definitions cannot drift.
//!
//! The recorded model and the EmmyLua emitter are the lua-free
//! [`crate::luadef`]; this is the mlua-side recorder that feeds it.
//! A free function is *fused* — [`Sub::func`] both `create_function`s it and
//! records its signature. A userdata handle keeps its `impl UserData`
//! registration (the methods live there) and is *recorded* through
//! [`Sub::proxy`] / [`Userdata`], exactly as a hand-written `create_proxy`
//! would register it. Either way, every key on the live table has a recorded
//! type — enforced by the mlua-gated coverage test.

use crate::luadef::{ClassDoc, FieldDoc, FnDoc, ModuleDoc, Param, Ret};
use mlua::prelude::{LuaTable, LuaValue};
use mlua::{FromLuaMulti, IntoLua, IntoLuaMulti, Lua, Result, UserData};

/// Maps a Rust binding type to its EmmyLua type string. The surface type, not
/// the Rust type: every string-shaped binding collapses to `string`, every
/// numeric one to `number`, and every dynamic value to `any`.
pub trait LuaType {
    fn lua_type() -> String;
}

macro_rules! lua_type {
    ($name:literal => $($ty:ty),+ $(,)?) => {
        $(impl LuaType for $ty { fn lua_type() -> String { $name.to_string() } })+
    };
}

lua_type!("string" => String, mlua::String, &str, Vec<u8>);
lua_type!("number" => f64, f32, i64, i32, u64, u32, usize, isize);
lua_type!("boolean" => bool);
lua_type!("nil" => ());
lua_type!("any" => LuaValue, mlua::Table, mlua::Function, mlua::MultiValue, mlua::AnyUserData);

impl<T: LuaType> LuaType for Option<T> {
    fn lua_type() -> String {
        format!("{}?", T::lua_type())
    }
}

/// The whole `dcs_studio` module surface: the root exports table plus a
/// recorder for its class (`dcs_studio`) and every sub-namespace / userdata
/// class it contains.
pub struct Surface<'l> {
    lua: &'l Lua,
    exports: &'l LuaTable,
    root: ClassDoc,
    /// Sub-namespace + userdata classes, emitted ahead of the root that fields
    /// them.
    extra: Vec<ClassDoc>,
}

impl<'l> Surface<'l> {
    /// Begin recording against the module's `exports` table. `root_name` is the
    /// class the emitted file returns (`"dcs_studio"`).
    pub fn new(lua: &'l Lua, exports: &'l LuaTable, root_name: &str, doc: &str) -> Self {
        let mut root = ClassDoc::new(root_name);
        root.doc = doc.to_string();
        Self {
            lua,
            exports,
            root,
            extra: Vec::new(),
        }
    }

    /// Set a constant on the exports table and record it as a `@field` on the
    /// root class, with the EmmyLua type inferred from the value via
    /// [`LuaType`].
    pub fn constant<V: LuaType + IntoLua>(
        &mut self,
        name: &str,
        doc: &str,
        value: V,
    ) -> Result<&mut Self> {
        self.constant_as(name, &V::lua_type(), doc, value)
    }

    /// Like [`Surface::constant`] but with an explicit EmmyLua type string, for
    /// a value whose surface type differs from its Rust type.
    pub fn constant_as(
        &mut self,
        name: &str,
        ty: &str,
        doc: &str,
        value: impl IntoLua,
    ) -> Result<&mut Self> {
        self.exports.set(name, value)?;
        self.root.fields.push(FieldDoc {
            name: name.to_string(),
            ty: ty.to_string(),
            doc: doc.to_string(),
        });
        Ok(self)
    }

    /// Declare a sub-namespace (a sub-table such as `json` / `logger`). The
    /// closure registers + records the sub-namespace's surface on a [`Sub`];
    /// the finished sub-table is set on the exports table and a `@field
    /// <name>: <root>.<name>` is recorded on the root class.
    pub fn submodule(
        &mut self,
        name: &str,
        doc: &str,
        build: impl FnOnce(&mut Sub) -> Result<()>,
    ) -> Result<&mut Self> {
        let full_name = format!("{}.{name}", self.root.name);
        let table = self.lua.create_table()?;
        let mut class = ClassDoc::new(&full_name);
        class.doc = doc.to_string();
        let mut sub = Sub {
            lua: self.lua,
            table,
            class,
            full_name: full_name.clone(),
            nested: Vec::new(),
        };
        build(&mut sub)?;
        let Sub {
            table,
            class,
            nested,
            ..
        } = sub;
        self.exports.set(name, table)?;
        self.root.fields.push(FieldDoc {
            name: name.to_string(),
            ty: full_name,
            doc: doc.to_string(),
        });
        // Userdata classes first (leaves), then the sub-namespace that fields them.
        self.extra.extend(nested);
        self.extra.push(class);
        Ok(self)
    }

    /// Record a function on the root class without registering it — for a
    /// binding whose body is wired up after the doc is assembled (e.g.
    /// `emit_dlua`, which needs the finished [`ModuleDoc`]). The caller sets the
    /// actual closure on the exports table itself.
    pub fn record_root_fn(
        &mut self,
        name: &str,
        params: &[Param],
        returns: &[Ret],
        doc: &str,
    ) -> &mut Self {
        self.root.functions.push(FnDoc {
            name: name.to_string(),
            params: params.to_vec(),
            returns: returns.to_vec(),
            doc: doc.to_string(),
            is_method: false,
        });
        self
    }

    /// Consume the recorder and return the assembled [`ModuleDoc`] (sub-classes
    /// first, root last).
    pub fn finish(self) -> ModuleDoc {
        let root_name = self.root.name.clone();
        let mut classes = self.extra;
        classes.push(self.root);
        ModuleDoc {
            root: root_name,
            classes,
        }
    }
}

/// Records (and, for free functions, registers) one sub-namespace's surface.
pub struct Sub<'l> {
    lua: &'l Lua,
    table: LuaTable,
    class: ClassDoc,
    full_name: String,
    nested: Vec<ClassDoc>,
}

impl Sub<'_> {
    /// Register an infallible free function and record its `.d.lua` signature.
    ///
    /// `params` and `returns` are the recorded EmmyLua surface; `f` is the mlua
    /// body. Most bridge functions use the `(value, err)` multi-return idiom,
    /// so `returns` is explicit rather than derived from a single Rust type.
    pub fn func<A, R>(
        &mut self,
        name: &str,
        params: &[Param],
        returns: &[Ret],
        doc: &str,
        f: impl Fn(&Lua, A) -> Result<R> + Send + 'static,
    ) -> Result<&mut Self>
    where
        A: FromLuaMulti,
        R: IntoLuaMulti,
    {
        self.table.set(name, self.lua.create_function(f)?)?;
        self.class.functions.push(FnDoc {
            name: name.to_string(),
            params: params.to_vec(),
            returns: returns.to_vec(),
            doc: doc.to_string(),
            is_method: false,
        });
        Ok(self)
    }

    /// Record a userdata handle type that is *constructed by a factory
    /// function* (e.g. `sqlite.open(path) -> Db`) rather than a `.new` proxy.
    /// Only records the `@class` + its methods for the `.d.lua` (so a returned
    /// handle gets completion); the type's runtime methods live in its own
    /// `impl UserData`, and no proxy table is set on the sub-namespace.
    pub fn record_userdata(
        &mut self,
        type_name: &str,
        doc: &str,
        build: impl FnOnce(&mut Userdata),
    ) -> &mut Self {
        let class_name = format!("{}.{type_name}", self.full_name);
        let mut ud = Userdata {
            class: {
                let mut c = ClassDoc::new(&class_name);
                c.doc = doc.to_string();
                c
            },
        };
        build(&mut ud);
        self.nested.push(ud.class);
        self
    }

    /// Register a userdata constructor proxy under `name` (so
    /// `<sub>.<name>.new(...)` reaches the type's `impl UserData`) and record
    /// the userdata type as its own class. The closure declares the type's
    /// methods + constructors on a [`Userdata`]; their runtime registration
    /// stays in `impl UserData`, untouched.
    pub fn proxy<T: UserData + 'static>(
        &mut self,
        name: &str,
        doc: &str,
        build: impl FnOnce(&mut Userdata),
    ) -> Result<&mut Self> {
        self.table.set(name, self.lua.create_proxy::<T>()?)?;
        let class_name = format!("{}.{name}", self.full_name);
        let mut ud = Userdata {
            class: {
                let mut c = ClassDoc::new(&class_name);
                c.doc = doc.to_string();
                c
            },
        };
        build(&mut ud);
        // The proxy is reachable as a field of this sub-namespace.
        self.class.fields.push(FieldDoc {
            name: name.to_string(),
            ty: class_name,
            doc: doc.to_string(),
        });
        self.nested.push(ud.class);
        Ok(self)
    }
}

/// Records the method + constructor surface of one userdata handle type. The
/// receiver (`self`) of a method is implicit and not listed in `params`.
pub struct Userdata {
    class: ClassDoc,
}

impl Userdata {
    /// Record one `:method(...)` (implicit `self` receiver).
    pub fn method(&mut self, name: &str, params: &[Param], returns: &[Ret], doc: &str) -> &mut Self {
        self.class.functions.push(FnDoc {
            name: name.to_string(),
            params: params.to_vec(),
            returns: returns.to_vec(),
            doc: doc.to_string(),
            is_method: true,
        });
        self
    }

    /// Record one `.constructor(...)` (associated, no `self`) — e.g. `new`.
    pub fn constructor(
        &mut self,
        name: &str,
        params: &[Param],
        returns: &[Ret],
        doc: &str,
    ) -> &mut Self {
        self.class.functions.push(FnDoc {
            name: name.to_string(),
            params: params.to_vec(),
            returns: returns.to_vec(),
            doc: doc.to_string(),
            is_method: false,
        });
        self
    }
}

/// Sugar for a required (`name: ty`) parameter.
pub fn p(name: &str, ty: &str) -> Param {
    Param::new(name, ty, false)
}

/// Sugar for an optional (`name?: ty`) parameter.
pub fn p_opt(name: &str, ty: &str) -> Param {
    Param::new(name, ty, true)
}

/// Sugar for one return value.
pub fn r(ty: &str) -> Ret {
    Ret::new(ty)
}

/// Sugar for one named return value (`---@return ty name`).
pub fn r_named(ty: &str, name: &str) -> Ret {
    Ret::named(ty, name)
}
