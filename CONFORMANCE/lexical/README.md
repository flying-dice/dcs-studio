# lexical/ — token-stream goldens

Each `name.lua` pairs with `name.tokens`: one line per token, in source
order, terminated by an `EOF` line.

```
KIND@line:col "lexeme"
```

- `line:col` are 1-based; columns count bytes from the line start.
- `lexeme` is the raw source slice; interior `"` and `\` are escaped.
  Long strings and long comments keep their brackets.
- Trivia (comments, blank lines) never appears in the stream; `---` doc
  comments are trivia too (SPEC.md §4 reads them separately).

## Token kinds

- `NAME`, `NUMBER`, `STRING`, `EOF`, `ERROR` (bytes no rule matches; always
  paired with `LUA-E001`).
- Keywords, uppercase: `AND BREAK DO ELSE ELSEIF END FALSE FOR FUNCTION IF
  IN LOCAL NIL NOT OR REPEAT RETURN THEN TRUE UNTIL WHILE`.
- Punctuation: `PLUS MINUS STAR SLASH PERCENT CARET HASH EQEQ NEQ LE GE LT
  GT EQ LPAREN RPAREN LBRACE RBRACE LBRACKET RBRACKET SEMI COLON COMMA DOT
  DOTDOT ELLIPSIS`.
