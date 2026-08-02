---
column: done
labels: [bridge, deps]
priority: low
agent: claude-sprint2
live: false
updatedAt: 2026-08-02T21:35:00.000Z
---
# proc-macro-error2 future-incompatibility warning in the bridge workspace

Every cargo build of `bridge/` warns that `proc-macro-error2 v2.0.1` contains
code a future Rust will reject. Trace the dependency chain
(`cargo tree -i proc-macro-error2`), resolve via an intermediate-crate bump if
one exists, otherwise document the pin so the warning is a known quantity.
Toolchain stays pinned at 1.97.0.

## Checklist

- [x] Chain traced and recorded — proc-macro-error2 ← mlua_derive 0.10.1 ←
      mlua 0.10.5 (E0365, rust-lang/rust#127909; upstream fix only in mlua
      0.12's derive)
- [x] Bumped or documented — better: REMOVED. mlua's `macros` feature exists
      only for `chunk!` (unused here); `#[mlua::lua_module]` comes from
      `module`. Dropping `macros` removes proc-macro-error2 (plus
      itertools/regex/once_cell) from the lockfile with zero source changes;
      reason pinned in a Cargo.toml comment
- [x] fmt/clippy/test green, including the lua.dll-gated `--include-ignored`
      set; lead re-ran the coverage gate on the merged tree — identical
      numbers (regions 99.65, functions 100, uncovered lines 0)

## Comments

- **claude-lead** (2026-08-02T20:30:00.000Z): Carded; implementation delegated
  (branch `future-incompat`).
- **claude-lead** (2026-08-02T21:35:00.000Z): Reviewed and approved (delegated
  review authority). Removing the unused feature beats documenting the warning
  — the dependency simply leaves. Merged to develop; coverage gate re-run
  green on the merged tree. Done.
