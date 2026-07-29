---
status: Accepted
date: 2026-07-29
---
# Decision 06 — Adopt RepoDoc for planning and documentation

## Context

Planning state for this repo lived in three places that do not talk to each
other: GitHub issues, long-form prose inside merged pull requests, and handover
issues written at the end of a session. [Issue #68](https://github.com/flying-dice/dcs-studio/issues/68)
is the clearest symptom — a hand-written handover of "everything waiting on a
human", produced because a closed PR is not a tracker and the next session had
nowhere else to read from.

Two of its notes make the cost concrete: "**No session is watching #67**", and
that context which mattered was recorded only in a PR description. Decisions had
the same problem in the other direction — the reasoning behind the hexagon, the
link-based install model and the four gates was real and well written, but spread
across `ARCHITECTURE.md`, CI comments and issue threads, with no record that says
"this was a choice, here is what it costs".

Requested by the repository owner (jonathan.turnock@gmail.com) in this session.

## Decision

Adopt RepoDoc: the kanban board, decision records and documentation live as plain
files in the repo, under `boards/`, `decisions/` and `docs/`. A VS Code extension
renders them, but the files are the product — there is nothing to install and no
CLI.

The board mirrors the GitHub issue tracker rather than replacing it, chosen
explicitly by the owner when this was set up. Every card that corresponds to an
issue links back to it; **GitHub stays the place discussion happens and the
source of truth for issue state.** The board additionally carries work the
tracker does not: in-source TODOs, and the items the testing audit recorded as
deliberately not done.

Day-to-day conventions are governed by the `repodoc-workflow` skill, installed at
`.claude/skills/repodoc-workflow/SKILL.md`.

## Consequences

- Planning state is versioned, reviewable in a diff, and available offline to any
  agent or contributor with a checkout — no API call, no auth.
- Work is claimed and progressed by **editing files**: column, `live`, `status`,
  `progress`, and an append-only `## Comments` journal on each card.
- Decisions are append-only and never renumbered. A superseded decision gets a
  new record, not an edit.
- Mirroring a tracker means two places can disagree. The rule that keeps that
  bounded: the issue is authoritative for state and discussion, the card is
  authoritative for what this repo's contributors are doing next. A card whose
  issue closes should be closed too.
- `boards/**` and `decisions/**` are excluded from the packaged `.vsix`
  (`.vscodeignore`) — they are contributor-facing, like `ARCHITECTURE.md`, and
  nothing in the extension reads them.
- `docs/` was reorganised into numbered sections so the rendered sidebar has a
  deliberate order. That moved four existing pages, and the bridge-doc generator,
  its golden test and the README references moved with them.
