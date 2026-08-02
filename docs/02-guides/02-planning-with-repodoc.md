# Planning with RepoDoc

Planning state for this repo lives in files, not in a service. Three folders at
the repo root:

```
boards/project-backlog/.config.json   columns and labels
boards/project-backlog/NN-slug.md     one card per file
decisions/NN-slug.md                  one decision record per file
docs/NN-section/NN-page.md            this tree
```

A VS Code extension renders them and updates live as they change, but it only
reads what is written — the files are the product. Nothing installs, and there is
no CLI.

The choice to adopt this, and what it costs, is
[decision 06](../../decisions/06-adopt-repodoc.md).

## How this repo uses it

**The board mirrors the GitHub issue tracker; it does not replace it.** Cards
that correspond to an issue link back to it. Issues stay the place discussion
happens and the source of truth for issue state; the board is the source of truth
for what contributors here are doing next. The board also carries work no issue
tracks — in-source TODOs, and the items the
[2026-07 testing audit](../04-quality/02-testing-audit-2026-07.md) recorded as
deliberately not done.

If you close an issue, close its card. If you open an issue that changes what
happens next, add a card.

**Decisions are append-only.** Never renumber, never rewrite the reasoning in an
existing record. A choice that replaces an earlier one gets a new record, and the
old one's `status` becomes `Superseded`.

**Cards carry a journal.** Each card's `## Comments` section is an append-only
narrative of what happened and why, with `path:line` references that render as
one-click links. It is what the next contributor — or the next agent — reads to
understand a card without re-deriving its history. This repo adopted RepoDoc
partly because that history was previously being written into merged pull
requests and handover issues, where nothing could find it.

## Working a card

The full conventions — claiming a card, keeping `live`/`status`/`progress`
honest, workflow gates, custom fields — are in the `repodoc-workflow` skill at
`.claude/skills/repodoc-workflow/SKILL.md`. Read it before picking up a card.

The short version:

1. Set `column: doing`, `live: true`, a one-line `status`, and your name in
   `agent:`.
2. Keep `status` and `progress` current while you work; tick checklist items;
   journal meaningful progress to `## Comments`.
3. When done, set `column: review` (a human moves it to `done`), set
   `live: false`, and drop `status`/`progress`.
4. Bump `updatedAt` on every change.

Two formatting rules that bite: frontmatter lists must use the inline form —
`labels: [bug, ci]`, never block-style YAML — and the `NN-` prefix is the card's
position across the **whole board**, not within its column.

## Note for packaging

`boards/**` and `decisions/**` are excluded from the `.vsix` in `.vscodeignore`.
They are contributor-facing, like `ARCHITECTURE.md`, and nothing in the extension
reads them. A new top-level planning folder needs the same treatment.
