//! Short-string quote normalisation and escape-aware decoding (SPEC.md §2
//! escape set, §7 quoting rule).

use crate::config::QuoteStyle;

/// Render a string literal under the quote preference. Long-bracket
/// strings and strings already using the preferred quote are verbatim; a
/// string whose content contains the preferred quote (escaped or not)
/// keeps its original quotes; otherwise the delimiters swap and a now-
/// redundant escape of the old quote relaxes (`'don\'t'` → `"don't"`).
#[must_use]
pub(crate) fn normalize(raw: &str, style: QuoteStyle) -> String {
    let bytes = raw.as_bytes();
    let (old, new) = match style {
        QuoteStyle::Double => (b'\'', b'"'),
        QuoteStyle::Single => (b'"', b'\''),
    };
    if bytes.first() != Some(&old) || bytes.len() < 2 || bytes.last() != Some(&old) {
        return raw.to_string();
    }
    let content = &raw[1..raw.len() - 1];
    if content.bytes().any(|b| b == new) {
        return raw.to_string();
    }
    let mut out = String::with_capacity(raw.len());
    out.push(char::from(new));
    let mut iter = content.bytes();
    while let Some(byte) = iter.next() {
        if byte == b'\\' {
            match iter.next() {
                Some(escaped) if escaped == old => out.push(char::from(old)),
                Some(escaped) => {
                    out.push('\\');
                    out.push(char::from(escaped));
                }
                None => out.push('\\'),
            }
        } else {
            out.push(char::from(byte));
        }
    }
    out.push(char::from(new));
    out
}

/// Decode a short string literal's raw text (delimiters included) to its
/// runtime byte value, per the Lua 5.1 escape set. Unknown escapes decode
/// to the escaped byte — both sides of a comparison use the same rule.
#[must_use]
pub(crate) fn decode_short(raw: &str) -> Vec<u8> {
    let bytes = raw.as_bytes();
    if bytes.len() < 2 {
        return bytes.to_vec();
    }
    let content = &bytes[1..bytes.len() - 1];
    let mut out = Vec::with_capacity(content.len());
    let mut i = 0;
    while i < content.len() {
        let byte = content[i];
        if byte != b'\\' {
            out.push(byte);
            i += 1;
            continue;
        }
        i += 1;
        let Some(&escaped) = content.get(i) else {
            out.push(b'\\');
            break;
        };
        i += 1;
        match escaped {
            b'a' => out.push(7),
            b'b' => out.push(8),
            b'f' => out.push(12),
            b'n' => out.push(b'\n'),
            b'r' => out.push(b'\r'),
            b't' => out.push(b'\t'),
            b'v' => out.push(11),
            b'0'..=b'9' => {
                let mut value = u32::from(escaped - b'0');
                let mut digits = 1;
                while digits < 3 {
                    match content.get(i) {
                        Some(&d) if d.is_ascii_digit() => {
                            value = value * 10 + u32::from(d - b'0');
                            i += 1;
                            digits += 1;
                        }
                        _ => break,
                    }
                }
                out.push((value & 0xFF) as u8);
            }
            other => out.push(other),
        }
    }
    out
}

/// Whether two string literals denote the same runtime value. Long-bracket
/// literals (either side) must match verbatim — the formatter never
/// rewrites them; short literals compare by decoded bytes.
#[must_use]
pub(crate) fn same_value(a: &str, b: &str) -> bool {
    if a.starts_with('[') || b.starts_with('[') {
        return a == b;
    }
    decode_short(a) == decode_short(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_double_quotes() {
        assert_eq!(normalize("'hi'", QuoteStyle::Double), "\"hi\"");
        assert_eq!(normalize("\"hi\"", QuoteStyle::Double), "\"hi\"");
    }

    #[test]
    fn embedded_target_quote_blocks_the_swap() {
        assert_eq!(
            normalize("'say \"hi\"'", QuoteStyle::Double),
            "'say \"hi\"'"
        );
        assert_eq!(
            normalize("'escaped \\\" too'", QuoteStyle::Double),
            "'escaped \\\" too'"
        );
    }

    #[test]
    fn redundant_escape_relaxes_on_swap() {
        assert_eq!(normalize("'don\\'t'", QuoteStyle::Double), "\"don't\"");
        assert!(same_value("'don\\'t'", "\"don't\""));
    }

    #[test]
    fn other_escapes_survive_verbatim() {
        assert_eq!(
            normalize("'a\\tb\\100c'", QuoteStyle::Double),
            "\"a\\tb\\100c\""
        );
        assert_eq!(decode_short("'a\\tb\\100c'"), b"a\tbdc".to_vec());
    }

    #[test]
    fn long_brackets_are_untouched() {
        assert_eq!(normalize("[[x]]", QuoteStyle::Double), "[[x]]");
        assert!(same_value("[==[x]==]", "[==[x]==]"));
        assert!(!same_value("[[x]]", "\"x\""));
    }

    #[test]
    fn single_preference_mirrors() {
        assert_eq!(normalize("\"hi\"", QuoteStyle::Single), "'hi'");
        assert_eq!(normalize("\"don't\"", QuoteStyle::Single), "\"don't\"");
    }
}
