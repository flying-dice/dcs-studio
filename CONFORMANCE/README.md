# CONFORMANCE/ — the executable contract

One directory per spec layer. The spec leads; expected outputs are
hand-written, never copied from the implementation.

| Layer | Exercises | Input | Expected |
| --- | --- | --- | --- |
| `lexical/` | SPEC.md §2 tokenisation | `name.lua` | `name.tokens` |
| `syntax/` | SPEC.md §2 grammar, §3 recovery | `name.lua` (accept) / `name.reject` | — / `name.reject.expected` |
| `annot/` | SPEC.md §4 annotation grammar | deferred until the annotation parser lands (plan Phase 3) | |
| `static/` | SPEC.md §5 resolution, profiles | `name.lua` | `name.diagnostics` |

Conventions:

- Filenames start with the `SPEC.md` section exercised, then a slug:
  `lexical/2-long-string-levels.lua`.
- One rule per case; a case exercising five rules is five cases.
- `static/` expected files list one diagnostic code per line; an empty file
  means well-formed; matching is order-independent.
- `syntax/` reject expectations are a one-line error category in prose, not
  exact message text.

What conformance does not test: performance, diagnostic message wording,
recovery tree shape (only that a tree exists and the right codes surface).
