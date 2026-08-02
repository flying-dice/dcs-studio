---
status: Accepted
date: 2026-07-25
---
# Decision 02 — A hexagonal core with an automatically checked boundary

## Context

A VS Code extension pulls everything toward `vscode`: panels, commands, config,
auth, and the filesystem all arrive through it. Left alone, the rules that
matter — which link strategy applies across volumes, how a manifest resolves a
destination, when a release may be re-cut — end up welded to an API that can only
be exercised inside a running editor.

The testing audit measured what that costs: 62% of shipped lines had no test that
imported them, and the panels holding most of the decision logic were at zero
(`docs/04-quality/02-testing-audit-2026-07.md:18-27`, `:68-76`).

Dated from `ARCHITECTURE.md`, which is the authoritative statement of the rule
and calls itself that in its first line. The structure predates the document.

## Decision

`src/core/` is a hexagon. `core/domain/` is pure functions and types,
`core/app/` is use-case services, and `core/ports/` is TypeScript interfaces
describing what core needs from the world. Everything that touches the outside —
`src/adapters/**` and each `<feature>/` folder — implements those ports.
`src/extension.ts` is the only place the two are wired.

The dependency rule is not a convention: `core/**` may import other `core/**`
modules and `node:path` and nothing else, and
`test/integration/architecture/boundaries.test.ts` walks the tree and fails the
build on any forbidden import. Feature-to-concrete-adapter crossings are held by
the same check, whose known-crossings list is now empty (PR #67, issue #61).

Ports stay minimal and intent-level; no shell or HTTP detail leaks into a
signature. Services take their ports by constructor injection as a plain object —
no DI framework.

## Consequences

- Domain rules are testable with no editor, no display and no DCS, which is what
  makes the unit layer's 100% gate affordable.
- Swapping a backend is one adapter plus one line in the composition root, and
  the marketplace contract suite (`test/support/`) keeps that a checked claim
  rather than an aspiration.
- The rule has teeth, so it also has cost: a genuine new boundary means writing a
  port file, and "just import it" is not available even when it would be quicker.
- Ports proliferate for things that look trivial — `ClockPort`, `SchedulerPort`,
  `EnvPort` — because time, timers and the environment all feed logic somewhere.
- An abstraction with no second caller is deliberately *not* introduced: there is
  no `NotifierPort`, and `src/errors.ts` is the notifier path until a core service
  first has to surface a message it cannot express as a return value.
