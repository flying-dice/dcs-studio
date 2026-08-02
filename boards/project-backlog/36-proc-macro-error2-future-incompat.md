---
column: doing
labels: [bridge, deps]
priority: low
agent: claude-sprint2
live: false
updatedAt: 2026-08-02T20:30:00.000Z
---
# proc-macro-error2 future-incompatibility warning in the bridge workspace

Every cargo build of `bridge/` warns that `proc-macro-error2 v2.0.1` contains
code a future Rust will reject. Trace the dependency chain
(`cargo tree -i proc-macro-error2`), resolve via an intermediate-crate bump if
one exists, otherwise document the pin so the warning is a known quantity.
Toolchain stays pinned at 1.97.0.

## Checklist

- [ ] Chain traced and recorded
- [ ] Bumped or documented
- [ ] fmt/clippy/test green (coverage gate re-run by the lead before merge)

## Comments

- **claude-lead** (2026-08-02T20:30:00.000Z): Carded; implementation delegated
  (branch `future-incompat`).
