//! The typed Lua 5.1 AST: flat arenas addressed by `u32` newtype ids.
//!
//! Arena storage (`Vec<T>` + `Copy` ids) keeps the tree cache-friendly and
//! serialisable, and sidesteps pointer-graph borrow gymnastics. Every node
//! carries a [`Span`].

use serde::Serialize;

use crate::span::Span;

macro_rules! arena_id {
    ($(#[$doc:meta])* $name:ident) => {
        $(#[$doc])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
        pub struct $name(pub u32);
    };
}

arena_id!(
    /// Index of an [`Expr`] in [`Ast::exprs`].
    ExprId
);
arena_id!(
    /// Index of a [`Stat`] in [`Ast::stats`].
    StatId
);
arena_id!(
    /// Index of a [`Block`] in [`Ast::blocks`].
    BlockId
);

/// The arenas one parsed chunk allocates into.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Ast {
    pub exprs: Vec<Expr>,
    pub stats: Vec<Stat>,
    pub blocks: Vec<Block>,
}

impl Ast {
    pub fn alloc_expr(&mut self, expr: Expr) -> ExprId {
        self.exprs.push(expr);
        ExprId(self.exprs.len() as u32 - 1)
    }

    pub fn alloc_stat(&mut self, stat: Stat) -> StatId {
        self.stats.push(stat);
        StatId(self.stats.len() as u32 - 1)
    }

    pub fn alloc_block(&mut self, block: Block) -> BlockId {
        self.blocks.push(block);
        BlockId(self.blocks.len() as u32 - 1)
    }

    #[must_use]
    pub fn expr(&self, id: ExprId) -> &Expr {
        &self.exprs[id.0 as usize]
    }

    #[must_use]
    pub fn stat(&self, id: StatId) -> &Stat {
        &self.stats[id.0 as usize]
    }

    #[must_use]
    pub fn block(&self, id: BlockId) -> &Block {
        &self.blocks[id.0 as usize]
    }
}

/// One parsed file: the top-level block.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Chunk {
    pub body: BlockId,
    pub span: Span,
}

/// A statement sequence.
#[derive(Debug, Clone, PartialEq)]
pub struct Block {
    pub stats: Vec<StatId>,
    pub span: Span,
}

/// An identifier with its source span.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Name {
    pub text: String,
    pub span: Span,
}

/// A statement and its span.
#[derive(Debug, Clone, PartialEq)]
pub struct Stat {
    pub kind: StatKind,
    pub span: Span,
}

/// The Lua 5.1 statement forms. `CallStat` is an expression statement —
/// only calls are legal there; the parser reports anything else but keeps
/// it in the tree for downstream analysis.
#[derive(Debug, Clone, PartialEq)]
pub enum StatKind {
    Assign {
        targets: Vec<ExprId>,
        values: Vec<ExprId>,
    },
    LocalAssign {
        names: Vec<Name>,
        values: Vec<ExprId>,
    },
    CallStat {
        call: ExprId,
    },
    Do {
        body: BlockId,
    },
    While {
        cond: ExprId,
        body: BlockId,
    },
    Repeat {
        body: BlockId,
        cond: ExprId,
    },
    If {
        arms: Vec<IfArm>,
        else_body: Option<BlockId>,
    },
    NumericFor {
        name: Name,
        low: ExprId,
        high: ExprId,
        step: Option<ExprId>,
        body: BlockId,
    },
    GenericFor {
        names: Vec<Name>,
        exprs: Vec<ExprId>,
        body: BlockId,
    },
    FunctionDecl {
        name: FuncName,
        func: FuncBody,
    },
    LocalFunction {
        name: Name,
        func: FuncBody,
    },
    Return {
        values: Vec<ExprId>,
    },
    Break,
}

/// One `if`/`elseif` arm.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct IfArm {
    pub cond: ExprId,
    pub body: BlockId,
}

/// A function statement's name path: `a.b.c` segments plus an optional
/// trailing `:method` (which implies a leading `self` parameter).
#[derive(Debug, Clone, PartialEq)]
pub struct FuncName {
    pub segments: Vec<Name>,
    pub method: Option<Name>,
}

/// A function literal's signature and body.
#[derive(Debug, Clone, PartialEq)]
pub struct FuncBody {
    pub params: Vec<Name>,
    pub is_vararg: bool,
    pub body: BlockId,
    pub span: Span,
}

/// An expression and its span.
#[derive(Debug, Clone, PartialEq)]
pub struct Expr {
    pub kind: ExprKind,
    pub span: Span,
}

/// The Lua 5.1 expression forms. `Field` is sugar-free `obj.name` access
/// (kept distinct from `Index` so member queries keep the identifier);
/// `Missing` is the recovery placeholder where an expression was required
/// but absent.
#[derive(Debug, Clone, PartialEq)]
pub enum ExprKind {
    Nil,
    True,
    False,
    Vararg,
    Number {
        raw: String,
    },
    Str {
        raw: String,
    },
    Function(FuncBody),
    NameRef(String),
    Field {
        obj: ExprId,
        name: Name,
    },
    Index {
        obj: ExprId,
        key: ExprId,
    },
    Call {
        callee: ExprId,
        args: Vec<ExprId>,
    },
    MethodCall {
        obj: ExprId,
        method: Name,
        args: Vec<ExprId>,
    },
    Paren(ExprId),
    Table {
        fields: Vec<TableField>,
    },
    Binary {
        op: BinOp,
        lhs: ExprId,
        rhs: ExprId,
    },
    Unary {
        op: UnOp,
        operand: ExprId,
    },
    Missing,
}

/// One table-constructor field.
#[derive(Debug, Clone, PartialEq)]
pub enum TableField {
    Positional(ExprId),
    Named { name: Name, value: ExprId },
    Keyed { key: ExprId, value: ExprId },
}

/// Binary operators. `Concat` and `Pow` are right-associative.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum BinOp {
    Add,
    Sub,
    Mul,
    Div,
    Mod,
    Pow,
    Concat,
    Eq,
    Ne,
    Lt,
    Gt,
    Le,
    Ge,
    And,
    Or,
}

/// Unary operators: `not`, `-`, `#`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum UnOp {
    Not,
    Neg,
    Len,
}

/// Parser output: the arenas, the chunk, and every diagnostic collected
/// while lexing and parsing, in source order. Parsing never fails.
#[derive(Debug, Clone, PartialEq)]
pub struct Parsed {
    pub ast: Ast,
    pub chunk: Chunk,
    pub diagnostics: Vec<crate::diagnostic::Diagnostic>,
}
