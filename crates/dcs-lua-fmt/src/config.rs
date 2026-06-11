//! Formatter configuration (SPEC.md §7). Deserialises straight from the
//! `dcs-studio.toml` `[format]` section; every field defaults so an absent
//! section (or field) formats with house style (decisions/006).

use serde::Deserialize;

/// Indentation character choice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IndentStyle {
    Space,
    Tab,
}

/// Preferred quote for short strings; a string whose content contains the
/// preferred quote keeps its original quotes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QuoteStyle {
    Double,
    Single,
}

/// Trailing-comma policy for multiline tables; single-line tables never
/// carry one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrailingComma {
    Multiline,
    Never,
}

/// All formatter options (SPEC.md §7 config table).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct FormatConfig {
    /// Spaces per indent level (clamped to 1..=16); ignored for tabs.
    pub indent_width: u8,
    pub indent_style: IndentStyle,
    pub quote_style: QuoteStyle,
    /// Column budget; lines with nothing breakable may exceed it.
    pub max_width: usize,
    pub trailing_comma: TrailingComma,
}

impl Default for FormatConfig {
    fn default() -> Self {
        Self {
            indent_width: 4,
            indent_style: IndentStyle::Space,
            quote_style: QuoteStyle::Double,
            max_width: 100,
            trailing_comma: TrailingComma::Multiline,
        }
    }
}

impl FormatConfig {
    /// One indent level as text.
    #[must_use]
    pub(crate) fn indent_unit(&self) -> String {
        match self.indent_style {
            IndentStyle::Space => " ".repeat(usize::from(self.indent_width.clamp(1, 16))),
            IndentStyle::Tab => "\t".to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_house_style() {
        let config = FormatConfig::default();
        assert_eq!(config.indent_width, 4);
        assert_eq!(config.indent_style, IndentStyle::Space);
        assert_eq!(config.quote_style, QuoteStyle::Double);
        assert_eq!(config.max_width, 100);
        assert_eq!(config.trailing_comma, TrailingComma::Multiline);
    }

    #[test]
    fn indent_width_clamps() {
        let config = FormatConfig {
            indent_width: 0,
            ..FormatConfig::default()
        };
        assert_eq!(config.indent_unit(), " ");
    }
}
