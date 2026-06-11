# CONFORMANCE/format — formatter goldens (SPEC.md §7)

One case per house-style rule (decisions/006): `name.lua` is the input,
`name.formatted.lua` the hand-written expected output. All cases run with
the default config (4 spaces, double quotes, 100 columns, trailing comma in
multiline tables).

Conventions (inherited from `CONFORMANCE/README.md`):

- Filenames start with the SPEC.md section exercised (§7), then a slug.
- Expected outputs are written by hand from decisions/006 — never copied
  from the implementation.
- Every expected output must itself be a fixed point of the formatter
  (idempotency is asserted over the expected files, not just the inputs).
