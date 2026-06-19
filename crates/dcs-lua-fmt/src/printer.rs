//! Trivia-anchored printer over the shared AST (SPEC.md §7,
//! decisions/006).
//!
//! The printer walks the tree in source order with one cursor into the
//! lexed trivia stream: comments flush before the statement (or table
//! field) they precede, same-line comments stay trailing, blank-line runs
//! survive capped at two. Width handling is flat-first: every expression
//! has a canonical single-line rendering; when that rendering overflows
//! the budget (or is impossible — a function literal with a body, a table
//! holding comments or written multiline), the outermost breakable
//! construct breaks, one field or argument per line. Deterministic by
//! construction: no maps, no environment — same input, same output.

use dcs_lua_syntax::Span;
use dcs_lua_syntax::ast::{
    Ast, BinOp, ExprId, ExprKind, FuncBody, FuncName, Parsed, StatId, StatKind, TableField, UnOp,
};
use dcs_lua_syntax::token::{SpannedTrivia, Trivia};

use crate::config::{FormatConfig, TrailingComma};
use crate::strings;

/// Cap on preserved consecutive blank lines (decisions/006).
const MAX_BLANK_LINES: u32 = 2;

/// Print the whole chunk.
pub(crate) fn print(
    src: &str,
    parsed: &Parsed,
    trivia: &[SpannedTrivia],
    config: &FormatConfig,
) -> String {
    let mut printer = Printer::new(src, parsed, trivia, config);
    let body = parsed.ast.block(parsed.chunk.body);
    printer.print_stats(&body.stats, 0);
    printer.flush_trivia(u32::MAX, 0, body.stats.is_empty(), true);
    printer.out
}

/// Print one statement run for range formatting: trivia cursor starts at
/// the splice boundary and the final newline is trimmed so the run sits
/// flush against the untouched tail. `first_separated` says the run's
/// first statement needs no `;` merge guard: it starts its block (where
/// Lua 5.1 rejects a leading `;` — `;` is admitted solely after a
/// statement), or the untouched prefix already ends with a `;` separator
/// (doubling it would print `;;`, which PUC Lua rejects).
#[expect(
    clippy::too_many_arguments,
    reason = "the splice parameters are one explicit set with a single caller"
)]
pub(crate) fn print_run(
    src: &str,
    parsed: &Parsed,
    trivia: &[SpannedTrivia],
    config: &FormatConfig,
    stats: &[StatId],
    depth: usize,
    splice_start: u32,
    first_separated: bool,
) -> String {
    let mut printer = Printer::new(src, parsed, trivia, config);
    printer.ti = trivia.partition_point(|t| t.span.start < splice_start);
    printer.print_stat_run(stats, depth, first_separated);
    if printer.out.ends_with(printer.newline) {
        let len = printer.out.len() - printer.newline.len();
        printer.out.truncate(len);
    }
    printer.out
}

struct Printer<'a> {
    src: &'a str,
    ast: &'a Ast,
    trivia: &'a [SpannedTrivia],
    config: &'a FormatConfig,
    newline: &'static str,
    unit: String,
    out: String,
    /// Cursor into `trivia`; advances monotonically in source order.
    ti: usize,
}

impl<'a> Printer<'a> {
    fn new(
        src: &'a str,
        parsed: &'a Parsed,
        trivia: &'a [SpannedTrivia],
        config: &'a FormatConfig,
    ) -> Self {
        Self {
            src,
            ast: &parsed.ast,
            trivia,
            config,
            newline: if src.contains("\r\n") { "\r\n" } else { "\n" },
            unit: config.indent_unit(),
            out: String::with_capacity(src.len() + src.len() / 8),
            ti: 0,
        }
    }

    // ---- low-level emission --------------------------------------------------

    fn push_newline(&mut self) {
        self.out.push_str(self.newline);
    }

    fn push_indent(&mut self, depth: usize) {
        for _ in 0..depth {
            self.out.push_str(&self.unit);
        }
    }

    /// Current column (bytes since the last newline).
    fn current_col(&self) -> usize {
        match self.out.rfind('\n') {
            Some(i) => self.out.len() - i - 1,
            None => self.out.len(),
        }
    }

    /// A comment, verbatim from the source (original markers, long-bracket
    /// level, interior line breaks); a CRLF file's trailing `\r` on line
    /// comments is shed because the printer emits its own line endings.
    fn push_comment_slice(&mut self, span: Span) {
        // A degenerate span (start>end, or end past EOF) can reach the printer
        // on a warning-only parse that slipped past format()'s error gate;
        // `.get` yields None rather than panicking — the same total-formatter
        // contract the inlay close-paren guard upholds.
        let slice = self
            .src
            .get(span.start as usize..span.end as usize)
            .unwrap_or("");
        self.out.push_str(slice.trim_end_matches('\r'));
    }

    /// No line break between byte offsets `from` and `to` in the source.
    fn same_line(&self, from: u32, to: u32) -> bool {
        let (from, to) = (from as usize, to as usize);
        from <= to && to <= self.src.len() && !self.src[from..to].contains('\n')
    }

    /// Any comment strictly inside `(lo, hi)`. Blank-line trivia is
    /// ignored: layout inside an otherwise-empty construct belongs to the
    /// printer, and counting it would make collapsing non-idempotent.
    // `from` is a `partition_point` result, so 0 <= from <= len — `trivia[from..]`
    // is always a valid (possibly empty) slice.
    #[allow(clippy::indexing_slicing)]
    fn has_comment_in(&self, lo: u32, hi: u32) -> bool {
        let from = self.trivia.partition_point(|t| t.span.start <= lo);
        self.trivia[from..]
            .iter()
            .take_while(|t| t.span.start < hi)
            .any(|t| !matches!(t.trivia, Trivia::BlankLines { .. }))
    }

    // ---- trivia anchoring ------------------------------------------------------

    /// Emit all pending trivia before `limit`: comments on their own line
    /// at `depth`, blank-line runs capped at [`MAX_BLANK_LINES`]. `lead`
    /// drops blanks at a block's start; `block_end` drops trailing blanks.
    fn flush_trivia(&mut self, limit: u32, depth: usize, lead: bool, block_end: bool) {
        let mut pending = 0u32;
        let mut emitted = false;
        while let Some(t) = self.trivia.get(self.ti) {
            if t.span.start >= limit {
                break;
            }
            if let Trivia::BlankLines { count } = &t.trivia {
                pending = (pending + count).min(MAX_BLANK_LINES);
            } else {
                if pending > 0 && (emitted || !lead) {
                    for _ in 0..pending {
                        self.push_newline();
                    }
                }
                pending = 0;
                self.push_indent(depth);
                self.push_comment_slice(t.span);
                self.push_newline();
                emitted = true;
            }
            self.ti += 1;
        }
        if pending > 0 && !block_end && (emitted || !lead) {
            for _ in 0..pending {
                self.push_newline();
            }
        }
    }

    /// Attach comments to the line just printed: every comment still
    /// pending inside the printed span (a comment from an expression
    /// position) and any comment on the same source line after it. After
    /// a line comment nothing else can ride the line; later pending
    /// comments flush on their own lines before the next statement.
    fn trailing_comments(&mut self, end: u32) {
        while let Some(t) = self.trivia.get(self.ti) {
            let is_comment = !matches!(t.trivia, Trivia::BlankLines { .. });
            let inside = t.span.start < end;
            if !(inside || (is_comment && self.same_line(end, t.span.start))) {
                break;
            }
            if is_comment {
                let ends_line = matches!(
                    t.trivia,
                    Trivia::LineComment { .. } | Trivia::DocComment { .. }
                );
                self.out.push(' ');
                self.push_comment_slice(t.span);
                self.ti += 1;
                if ends_line {
                    break;
                }
            } else {
                // A blank gap inside a statement is layout the printer owns.
                self.ti += 1;
            }
        }
    }

    // ---- statements --------------------------------------------------------------

    fn print_stats(&mut self, stats: &[StatId], depth: usize) {
        self.print_stat_run(stats, depth, true);
    }

    /// `first_separated`: the first of `stats` must not gain the `;` merge
    /// guard — it is its block's first statement (Lua 5.1's
    /// `chunk ::= {stat [';']}` admits `;` only *after* a statement, and
    /// PUC Lua rejects a block-start `;`), or, in range mode, the
    /// untouched prefix already carries the separator.
    fn print_stat_run(&mut self, stats: &[StatId], depth: usize, first_separated: bool) {
        for (i, &sid) in stats.iter().enumerate() {
            let span = self.ast.stat(sid).span;
            self.flush_trivia(span.start, depth, i == 0, false);
            self.push_indent(depth);
            self.print_stat(sid, depth, first_separated && i == 0);
            self.trailing_comments(span.end);
            self.push_newline();
        }
    }

    #[expect(clippy::too_many_lines, reason = "one arm per statement form")]
    // Assign always has >= 1 target and If always has >= 1 arm by parser
    // construction, so `targets[0]`/`arms[0]`/`arms[1..]` cannot be out of bounds.
    #[allow(clippy::indexing_slicing)]
    fn print_stat(&mut self, sid: StatId, depth: usize, separated: bool) {
        let ast = self.ast;
        let span = ast.stat(sid).span;
        match &ast.stat(sid).kind {
            StatKind::Assign { targets, values } => {
                if !separated && self.starts_with_paren(targets[0]) {
                    self.out.push(';');
                }
                self.emit_expr_list(targets, depth);
                self.out.push_str(" = ");
                self.emit_expr_list(values, depth);
            }
            StatKind::LocalAssign { names, values } => {
                self.out.push_str("local ");
                self.push_name_list(names);
                if !values.is_empty() {
                    self.out.push_str(" = ");
                    self.emit_expr_list(values, depth);
                }
            }
            StatKind::CallStat { call } => {
                if !separated && self.starts_with_paren(*call) {
                    self.out.push(';');
                }
                self.emit_expr(*call, depth);
            }
            StatKind::Do { body } => {
                if self.block_collapses(*body, span) {
                    self.out.push_str("do end");
                } else {
                    self.out.push_str("do");
                    self.emit_block_body(*body, depth);
                    self.out.push_str("end");
                }
            }
            StatKind::While { cond, body } => {
                self.out.push_str("while ");
                self.emit_expr(*cond, depth);
                if self.block_collapses(*body, span) {
                    self.out.push_str(" do end");
                } else {
                    self.out.push_str(" do");
                    self.emit_block_body(*body, depth);
                    self.out.push_str("end");
                }
            }
            StatKind::Repeat { body, cond } => {
                if self.block_collapses(*body, span) {
                    self.out.push_str("repeat until ");
                } else {
                    self.out.push_str("repeat");
                    self.emit_block_body(*body, depth);
                    self.out.push_str("until ");
                }
                self.emit_expr(*cond, depth);
            }
            StatKind::If { arms, else_body } => {
                let collapses = arms.len() == 1
                    && else_body.is_none()
                    && self.block_collapses(arms[0].body, span);
                self.out.push_str("if ");
                self.emit_expr(arms[0].cond, depth);
                if collapses {
                    self.out.push_str(" then end");
                    return;
                }
                self.out.push_str(" then");
                self.emit_block_body(arms[0].body, depth);
                for arm in &arms[1..] {
                    self.out.push_str("elseif ");
                    self.emit_expr(arm.cond, depth);
                    self.out.push_str(" then");
                    self.emit_block_body(arm.body, depth);
                }
                if let Some(else_body) = else_body {
                    self.out.push_str("else");
                    self.emit_block_body(*else_body, depth);
                }
                self.out.push_str("end");
            }
            StatKind::NumericFor {
                name,
                low,
                high,
                step,
                body,
            } => {
                self.out.push_str("for ");
                self.out.push_str(&name.text);
                self.out.push_str(" = ");
                self.emit_expr(*low, depth);
                self.out.push_str(", ");
                self.emit_expr(*high, depth);
                if let Some(step) = step {
                    self.out.push_str(", ");
                    self.emit_expr(*step, depth);
                }
                self.finish_loop_body(*body, span, depth);
            }
            StatKind::GenericFor { names, exprs, body } => {
                self.out.push_str("for ");
                self.push_name_list(names);
                self.out.push_str(" in ");
                self.emit_expr_list(exprs, depth);
                self.finish_loop_body(*body, span, depth);
            }
            StatKind::FunctionDecl { name, func } => {
                self.out.push_str("function ");
                self.push_func_name(name);
                self.emit_func_tail(func, depth);
            }
            StatKind::LocalFunction { name, func } => {
                self.out.push_str("local function ");
                self.out.push_str(&name.text);
                self.emit_func_tail(func, depth);
            }
            StatKind::Return { values } => {
                self.out.push_str("return");
                if !values.is_empty() {
                    self.out.push(' ');
                    self.emit_expr_list(values, depth);
                }
            }
            StatKind::Break => self.out.push_str("break"),
        }
    }

    /// ` do` + body + `end` for both `for` forms.
    fn finish_loop_body(&mut self, body: dcs_lua_syntax::ast::BlockId, span: Span, depth: usize) {
        if self.block_collapses(body, span) {
            self.out.push_str(" do end");
        } else {
            self.out.push_str(" do");
            self.emit_block_body(body, depth);
            self.out.push_str("end");
        }
    }

    /// An empty, comment-free body collapses onto the header line.
    fn block_collapses(&mut self, body: dcs_lua_syntax::ast::BlockId, stat_span: Span) -> bool {
        self.ast.block(body).stats.is_empty()
            && !self.has_comment_in(stat_span.start, stat_span.end)
    }

    /// Newline, the body's statements one level deeper, pending comments
    /// before the terminator, and the indent for the closing keyword.
    fn emit_block_body(&mut self, body: dcs_lua_syntax::ast::BlockId, depth: usize) {
        self.push_newline();
        let block = self.ast.block(body);
        self.print_stats(&block.stats, depth + 1);
        self.flush_trivia(block.span.end, depth + 1, block.stats.is_empty(), true);
        self.push_indent(depth);
    }

    /// `(params)` then either ` end` (empty, comment-free) or the body.
    fn emit_func_tail(&mut self, func: &FuncBody, depth: usize) {
        self.out.push('(');
        self.out.push_str(&params_text(func));
        self.out.push(')');
        if self.ast.block(func.body).stats.is_empty()
            && !self.has_comment_in(func.span.start, func.span.end)
        {
            self.out.push_str(" end");
        } else {
            self.emit_block_body(func.body, depth);
            self.out.push_str("end");
        }
    }

    fn push_name_list(&mut self, names: &[dcs_lua_syntax::ast::Name]) {
        for (i, name) in names.iter().enumerate() {
            if i > 0 {
                self.out.push_str(", ");
            }
            self.out.push_str(&name.text);
        }
    }

    fn push_func_name(&mut self, name: &FuncName) {
        for (i, segment) in name.segments.iter().enumerate() {
            if i > 0 {
                self.out.push('.');
            }
            self.out.push_str(&segment.text);
        }
        if let Some(method) = &name.method {
            self.out.push(':');
            self.out.push_str(&method.text);
        }
    }

    /// Whether the statement's first printed character would be `(` — it
    /// then needs a leading `;` so dropped separators cannot merge it into
    /// the previous statement (decisions/006). Suppressed at a block's
    /// start, where no previous statement exists and Lua 5.1 rejects `;`.
    fn starts_with_paren(&self, mut id: ExprId) -> bool {
        loop {
            match &self.ast.expr(id).kind {
                ExprKind::Paren(_) => return true,
                ExprKind::Call { callee, .. } => id = *callee,
                ExprKind::MethodCall { obj, .. }
                | ExprKind::Field { obj, .. }
                | ExprKind::Index { obj, .. } => id = *obj,
                _ => return false,
            }
        }
    }

    // ---- expressions ----------------------------------------------------------------

    fn emit_expr_list(&mut self, exprs: &[ExprId], depth: usize) {
        for (i, &expr) in exprs.iter().enumerate() {
            if i > 0 {
                self.out.push_str(", ");
            }
            self.emit_expr(expr, depth);
        }
    }

    /// Flat-first: the canonical single-line form when it exists and fits;
    /// otherwise break at this node and recurse.
    fn emit_expr(&mut self, id: ExprId, depth: usize) {
        let flat = self.flat_expr(id);
        if let Some(text) = &flat
            && self.current_col() + text.len() <= self.config.width_budget()
        {
            self.out.push_str(text);
            return;
        }
        let ast = self.ast;
        match &ast.expr(id).kind {
            ExprKind::Table { fields } => {
                self.emit_table_multiline(ast.expr(id).span, fields, depth);
            }
            ExprKind::Call { callee, args } => {
                self.emit_expr(*callee, depth);
                self.emit_broken_args(args, depth);
            }
            ExprKind::MethodCall { obj, method, args } => {
                self.emit_expr(*obj, depth);
                self.out.push(':');
                self.out.push_str(&method.text);
                self.emit_broken_args(args, depth);
            }
            ExprKind::Function(func) => {
                self.out.push_str("function(");
                self.out.push_str(&params_text(func));
                self.out.push(')');
                self.emit_block_body(func.body, depth);
                self.out.push_str("end");
            }
            ExprKind::Paren(inner) => {
                self.out.push('(');
                self.emit_expr(*inner, depth);
                self.out.push(')');
            }
            ExprKind::Binary { op, lhs, rhs } => {
                self.emit_expr(*lhs, depth);
                self.out.push(' ');
                self.out.push_str(bin_op_text(*op));
                self.out.push(' ');
                self.emit_expr(*rhs, depth);
            }
            ExprKind::Unary { op, operand } => {
                self.out.push_str(un_op_text(*op));
                let at = self.out.len();
                self.emit_expr(*operand, depth);
                if *op == UnOp::Neg && self.out.as_bytes().get(at) == Some(&b'-') {
                    self.out.insert(at, ' ');
                }
            }
            ExprKind::Field { obj, name } => {
                self.emit_expr(*obj, depth);
                self.out.push('.');
                self.out.push_str(&name.text);
            }
            ExprKind::Index { obj, key } => {
                self.emit_expr(*obj, depth);
                self.out.push('[');
                let at = self.out.len();
                self.emit_expr(*key, depth);
                self.pad_long_bracket_key(at);
                self.out.push(']');
            }
            // Leaves always have a flat form; reaching here means it
            // overflowed the budget with nothing breakable — emit anyway.
            _ => self.out.push_str(&flat.unwrap_or_default()),
        }
    }

    /// `(` args one per line `)` — no trailing comma (illegal in calls).
    /// An empty list never breaks.
    fn emit_broken_args(&mut self, args: &[ExprId], depth: usize) {
        self.out.push('(');
        if args.is_empty() {
            self.out.push(')');
            return;
        }
        self.push_newline();
        for (i, &arg) in args.iter().enumerate() {
            self.push_indent(depth + 1);
            self.emit_expr(arg, depth + 1);
            if i + 1 < args.len() {
                self.out.push(',');
            }
            self.push_newline();
        }
        self.push_indent(depth);
        self.out.push(')');
    }

    fn emit_table_multiline(&mut self, span: Span, fields: &[TableField], depth: usize) {
        self.out.push('{');
        self.push_newline();
        for (i, field) in fields.iter().enumerate() {
            let (start, end) = self.field_span(field);
            self.flush_trivia(start, depth + 1, i == 0, false);
            self.push_indent(depth + 1);
            self.emit_field(field, depth + 1);
            if i + 1 < fields.len() || self.config.trailing_comma == TrailingComma::Multiline {
                self.out.push(',');
            }
            self.trailing_comments(end);
            self.push_newline();
        }
        let rbrace = span.end.saturating_sub(1);
        self.flush_trivia(rbrace, depth + 1, fields.is_empty(), true);
        self.push_indent(depth);
        self.out.push('}');
    }

    fn emit_field(&mut self, field: &TableField, depth: usize) {
        match field {
            TableField::Positional(value) => self.emit_expr(*value, depth),
            TableField::Named { name, value } => {
                self.out.push_str(&name.text);
                self.out.push_str(" = ");
                self.emit_expr(*value, depth);
            }
            TableField::Keyed { key, value } => {
                self.out.push('[');
                let at = self.out.len();
                self.emit_expr(*key, depth);
                self.pad_long_bracket_key(at);
                self.out.push_str("] = ");
                self.emit_expr(*value, depth);
            }
        }
    }

    /// Pad a just-emitted bracketed key (starting at byte `at`) with one
    /// space on each side when the key's own text starts with `[` — only a
    /// long-bracket string can, and `[[[` would lex as a long-bracket
    /// opener (decisions/006).
    fn pad_long_bracket_key(&mut self, at: usize) {
        if self.out.as_bytes().get(at) == Some(&b'[') {
            self.out.insert(at, ' ');
            self.out.push(' ');
        }
    }

    fn field_span(&self, field: &TableField) -> (u32, u32) {
        let ast = self.ast;
        match field {
            TableField::Positional(value) => {
                let span = ast.expr(*value).span;
                (span.start, span.end)
            }
            TableField::Named { name, value } => (name.span.start, ast.expr(*value).span.end),
            TableField::Keyed { key, value } => {
                (ast.expr(*key).span.start, ast.expr(*value).span.end)
            }
        }
    }

    // ---- flat rendering ---------------------------------------------------------------

    /// The canonical single-line rendering, or `None` when this expression
    /// is forced multiline: a function literal with a body (or comments),
    /// or a table written multiline / holding comments.
    fn flat_expr(&self, id: ExprId) -> Option<String> {
        let ast = self.ast;
        let expr = ast.expr(id);
        Some(match &expr.kind {
            ExprKind::Nil => "nil".to_string(),
            ExprKind::True => "true".to_string(),
            ExprKind::False => "false".to_string(),
            ExprKind::Vararg => "...".to_string(),
            ExprKind::Number { raw } => raw.clone(),
            ExprKind::Str { raw } => strings::normalize(raw, self.config.quote_style),
            ExprKind::NameRef(name) => name.clone(),
            ExprKind::Function(func) => {
                if !ast.block(func.body).stats.is_empty()
                    || self.has_comment_in(func.span.start, func.span.end)
                {
                    return None;
                }
                format!("function({}) end", params_text(func))
            }
            ExprKind::Field { obj, name } => {
                format!("{}.{}", self.flat_expr(*obj)?, name.text)
            }
            ExprKind::Index { obj, key } => {
                format!(
                    "{}{}",
                    self.flat_expr(*obj)?,
                    bracketed_key(&self.flat_expr(*key)?)
                )
            }
            ExprKind::Call { callee, args } => {
                format!("{}({})", self.flat_expr(*callee)?, self.flat_list(args)?)
            }
            ExprKind::MethodCall { obj, method, args } => format!(
                "{}:{}({})",
                self.flat_expr(*obj)?,
                method.text,
                self.flat_list(args)?
            ),
            ExprKind::Paren(inner) => format!("({})", self.flat_expr(*inner)?),
            ExprKind::Table { fields } => {
                if fields.is_empty() {
                    if self.has_comment_in(expr.span.start, expr.span.end) {
                        return None;
                    }
                    return Some("{}".to_string());
                }
                // A degenerate span (start>end, past EOF) on a warning-only
                // parse must not panic the slice — bail to multi-line (None) if
                // it can't be read.
                let slice = self.src.get(expr.span.start as usize..expr.span.end as usize)?;
                if slice.contains('\n') || self.has_comment_in(expr.span.start, expr.span.end) {
                    return None;
                }
                let mut parts = Vec::with_capacity(fields.len());
                for field in fields {
                    parts.push(match field {
                        TableField::Positional(value) => self.flat_expr(*value)?,
                        TableField::Named { name, value } => {
                            format!("{} = {}", name.text, self.flat_expr(*value)?)
                        }
                        TableField::Keyed { key, value } => format!(
                            "{} = {}",
                            bracketed_key(&self.flat_expr(*key)?),
                            self.flat_expr(*value)?
                        ),
                    });
                }
                format!("{{ {} }}", parts.join(", "))
            }
            ExprKind::Binary { op, lhs, rhs } => format!(
                "{} {} {}",
                self.flat_expr(*lhs)?,
                bin_op_text(*op),
                self.flat_expr(*rhs)?
            ),
            ExprKind::Unary { op, operand } => {
                let operand = self.flat_expr(*operand)?;
                let op = un_op_text(*op);
                if op == "-" && operand.starts_with('-') {
                    format!("- {operand}")
                } else {
                    format!("{op}{operand}")
                }
            }
            // Unreachable in practice: a `Missing` node always rides with
            // an error diagnostic, which fails formatting first.
            ExprKind::Missing => String::new(),
        })
    }

    fn flat_list(&self, exprs: &[ExprId]) -> Option<String> {
        let mut parts = Vec::with_capacity(exprs.len());
        for &expr in exprs {
            parts.push(self.flat_expr(expr)?);
        }
        Some(parts.join(", "))
    }
}

/// `[key]`, space-padded when the key's text itself starts with `[` (a
/// long-bracket string) — `[[[` would lex as a long-bracket opener.
fn bracketed_key(key: &str) -> String {
    if key.starts_with('[') {
        format!("[ {key} ]")
    } else {
        format!("[{key}]")
    }
}

fn params_text(func: &FuncBody) -> String {
    let mut parts: Vec<&str> = func.params.iter().map(|p| p.text.as_str()).collect();
    if func.is_vararg {
        parts.push("...");
    }
    parts.join(", ")
}

fn bin_op_text(op: BinOp) -> &'static str {
    match op {
        BinOp::Add => "+",
        BinOp::Sub => "-",
        BinOp::Mul => "*",
        BinOp::Div => "/",
        BinOp::Mod => "%",
        BinOp::Pow => "^",
        BinOp::Concat => "..",
        BinOp::Eq => "==",
        BinOp::Ne => "~=",
        BinOp::Lt => "<",
        BinOp::Gt => ">",
        BinOp::Le => "<=",
        BinOp::Ge => ">=",
        BinOp::And => "and",
        BinOp::Or => "or",
    }
}

fn un_op_text(op: UnOp) -> &'static str {
    match op {
        UnOp::Not => "not ",
        UnOp::Neg => "-",
        UnOp::Len => "#",
    }
}
