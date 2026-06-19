//! Byte spans and the offset → line/column index.

use serde::Serialize;

/// A half-open byte range `[start, end)` into one file's source.
///
/// Offsets are bytes, not characters; line/column pairs are derived via
/// [`LineIndex`] only at the rendering edge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
pub struct Span {
    pub start: u32,
    pub end: u32,
}

impl Span {
    #[must_use]
    pub fn new(start: u32, end: u32) -> Self {
        Self { start, end }
    }

    /// The empty span at `offset` — used for end-of-input diagnostics.
    #[must_use]
    pub fn empty(offset: u32) -> Self {
        Self::new(offset, offset)
    }
}

/// Precomputed newline offsets turning a byte offset into a 1-based
/// `(line, column)` pair in `O(log n)`. Columns count bytes from the line
/// start, matching the conformance token goldens.
#[derive(Debug)]
pub struct LineIndex {
    line_starts: Vec<u32>,
    len: u32,
}

impl LineIndex {
    #[must_use]
    pub fn new(src: &str) -> Self {
        let mut line_starts = vec![0];
        line_starts.extend(
            src.bytes()
                .enumerate()
                .filter(|&(_, b)| b == b'\n')
                .map(|(i, _)| i as u32 + 1),
        );
        Self {
            line_starts,
            len: src.len() as u32,
        }
    }

    /// The 1-based `(line, column)` for `offset`; an offset past the end
    /// clamps to the end of the source.
    #[must_use]
    // `line` is a `binary_search` result index into `line_starts` (never empty —
    // line 1 starts at 0), so it is always < len; the indexing cannot panic.
    #[allow(clippy::indexing_slicing)]
    pub fn line_col(&self, offset: u32) -> (u32, u32) {
        let offset = offset.min(self.len);
        let line = match self.line_starts.binary_search(&offset) {
            Ok(exact) => exact,
            Err(insert) => insert - 1,
        };
        let col = offset - self.line_starts[line];
        (line as u32 + 1, col + 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_col_is_one_based_and_clamps() {
        let index = LineIndex::new("ab\ncd\n");
        assert_eq!(index.line_col(0), (1, 1));
        assert_eq!(index.line_col(1), (1, 2));
        assert_eq!(index.line_col(3), (2, 1));
        assert_eq!(index.line_col(6), (3, 1));
        assert_eq!(index.line_col(99), (3, 1));
    }
}
