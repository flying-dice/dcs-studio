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

## Branches

`main` is the only long-lived branch. Work happens on a branch off it and
returns by pull request — there is no integration branch in between. `develop`
was that branch until 2026-08-05 and is retired; a reference to it in an older
card's journal is history, not instruction.

`main` is protected, enforced on admins: the six CI checks, strict (your branch
must be up to date), and one approving review. So a change cannot reach `main`
by push, and cannot reach it on its author's own approval either.

## Getting a card into review

`In Review` has five entry gates in `.config.json`, and they are the review
workflow written down. Evaluate them **before** moving the card, and record each
passing one under the card's `## Gates` heading as
`- [x] <gateId> — <result> (<name>, <ISO time>)`. Never record a line for a run
that did not pass.

| Gate | Kind | What it means |
|---|---|---|
| `static` | `npm run lint && npm run typecheck:tests` | — |
| `coverage` | `npm run coverage` | The three JS layers, serially. Not Rust. |
| `code-review` | field `review-verdict` = `clean` | A local code review found nothing blocking. |
| `pr-open` | field `pr` | The change is a PR against `main`, not a push to it. |
| `ci` | `gh pr checks` | All six checks on that PR — **the only gate that covers Rust and Windows.** |

Run `ci` from the feature branch: bare `gh pr checks` infers the repo from the
remote and the PR from the current branch, and exits 1 with
`no pull requests found for branch "…"` anywhere else. Adding `--repo` makes a
PR argument mandatory, which is not what you want in a gate.

The `coverage` gate deliberately stops at the JavaScript layers. Running
`cargo llvm-cov` locally on a card that never touched `bridge/` is waste, and CI
runs it on the PR regardless — which is why `ci` is a gate rather than a
courtesy, and why the two are not interchangeable.

### The review loop

`review-verdict` is a loop counter, not a checkbox. A local code review that
finds anything blocking sends the card **back to `todo`** — not forward with a
caveat:

1. Set `review-verdict: findings` and `column: todo`.
2. Journal every finding to `## Comments`, with `path:line` for each, including
   the ones you disagree with and why.
3. Pick the card back up, fix, and review again. Re-review the *fix*, not just
   the original complaint — a fix is new code and gets the same scrutiny.
4. Only a pass with nothing blocking earns `review-verdict: clean`.

The bounce is the point. A card whose history shows one clean review is less
trustworthy than one showing a rejection, the findings, and what changed — the
second is evidence the review had teeth. Card
[40](../../boards/project-backlog/40-marketplace-empty-state-line-breaks.md) is
the worked example: rejected for a flaky test, bounced, and a second pass over
the fix found three more holes the first review never reached.

### Getting a card to done

`Done` has one gate: `peer-reviewed` must be `yes`. **That field is a human's to
set.** An agent never sets it, never infers it from an approving comment, and
never sets it on its own work — an agent that can approve itself is not a gate.
Leave the card in `In Review` and say so.

## Note for packaging

`boards/**` and `decisions/**` are excluded from the `.vsix` in `.vscodeignore`.
They are contributor-facing, like `ARCHITECTURE.md`, and nothing in the extension
reads them. A new top-level planning folder needs the same treatment.
