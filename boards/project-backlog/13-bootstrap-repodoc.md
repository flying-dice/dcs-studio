---
column: done
labels: [docs, process]
priority: med
agent: claude
live: false
updatedAt: 2026-07-29T22:40:00.000Z
---
# Bootstrap RepoDoc in this repo

Set this repo up as a RepoDoc project: a file-based kanban board, decision
records, and an ordered docs tree, plus the `repodoc-workflow` skill so the
conventions survive the session that created them.

Rationale and trade-offs are in
[decision 06](../../decisions/06-adopt-repodoc.md). The contributor-facing
summary is [Planning with RepoDoc](../../docs/02-guides/02-planning-with-repodoc.md).

Two choices were the repository owner's, taken at bootstrap time:

- **The board mirrors the GitHub tracker** rather than replacing it or carrying
  only untracked work.
- **Existing `docs/` pages were renumbered** into the new section tree rather
  than left at the top level.

Left for a human to check: the board's ordering reflects one reading of what
matters next, and cards 03 and 04 are ordered ahead of 05 on the strength of
#68's claim that the live-DCS session is the highest-value hour available.

## Checklist

- [x] Board config at `boards/project-backlog/.config.json`
- [x] 13 cards seeded from the open issues, the in-source TODOs and the testing audit
- [x] 6 decisions backfilled
- [x] `docs/` reorganised into numbered sections, generator and golden test updated
- [x] `repodoc-workflow` skill installed at `.claude/skills/repodoc-workflow/SKILL.md`
- [x] `boards/**` and `decisions/**` excluded from the packaged `.vsix`
- [ ] Human review of card ordering, priorities and the decision records

## Comments

- **claude** (2026-07-29T05:22:16.000Z): Bootstrapped RepoDoc. Board config at boards/project-backlog/.config.json with the five default columns and nine labels tailored to this repo (extension, bridge, lua, webview, tests, ci, docs, bug, process — the default backend/frontend split does not describe anything here). 13 cards: 5 mirroring the open issues (#32, #63, #65, #66, #68), 1 for the open PR #67 in `review`, 2 from in-source TODOs at src/bridge/clients.ts:14 and src/webview/html.ts:10, 3 from the "deliberately not done" section of docs/04-quality/02-testing-audit-2026-07.md:383-395, 1 for branch protection from issue #68 §1, and this one. Nothing is in `done` — no card here describes work I verified as finished.
- **claude** (2026-07-29T05:22:16.000Z): Backfilled 6 decisions. 01 (GitHub as the whole backend), 03 (links not copies) and 04 (two JSON-RPC bridges) are dated from the commits that introduced them — the initial commit, 158f6dd and ccf1dbe. 02 (the hexagon) is dated 2026-07-25 from ARCHITECTURE.md, which is the authoritative statement of the rule; the structure itself predates that file and I could not date it precisely because the early history is squashed. 05 (four test layers) is dated from dcd419a. Context sections summarise reasoning this repo had already written down rather than reconstructing it — ARCHITECTURE.md:1-193, docs/04-quality/02-testing-audit-2026-07.md and the comment blocks in .github/workflows/ci.yml carry almost all of it.
- **claude** (2026-07-29T05:22:16.000Z): Renumbered docs per the owner's choice. Moved bridge-api.md, bridge-api-gui.md and bridge-api-mission.md into docs/03-reference/ and testing-audit.md into docs/04-quality/, all with `git mv`. That is not a pure rename: scripts/generate-bridge-docs.mjs:14-25 hard-coded the output paths and emitted `../` links computed for a one-level-deep page, so renderBridgeDoc now takes the out path and derives the hops (scripts/generate-bridge-docs.mjs:119-127). Regenerated both pages, updated the golden test's expected keys at test/integration/docs/bridgeApiDocs.test.ts:24-27, and fixed the inbound references at README.md:173, skills/dcs-studio/SKILL.md:193 and docs/03-reference/01-bridge-api.md:38-46.
- **claude** (2026-07-29T05:22:16.000Z): Added four docs pages, all sourced from what was already written: 01-getting-started/01-overview.md and 02-development-setup.md from README.md and the scripts under scripts/, 02-guides/01-running-the-tests.md from the "Testing & coverage" section of ARCHITECTURE.md:116-176 and the comments in .github/workflows/ci.yml, and 02-guides/02-planning-with-repodoc.md for the folders this change introduces. They link to ARCHITECTURE.md rather than restating it, so there is no second copy to drift.
- **claude** (2026-07-29T05:22:16.000Z): Two things worth a human's eye. The audit at docs/04-quality/02-testing-audit-2026-07.md:393-395 says the console history double-tap is "documented in the spec"; it is not — spec/stories/017-lua-console.story.md:107-109 describes no such behaviour. Card 10 records that discrepancy rather than papering over it. And boards/** and decisions/** were added to .vscodeignore: without it they would have shipped inside every .vsix, which is the same class of mistake that file already documents for dcs-studio.toml.
- **claude** (2026-07-29T07:05:00.000Z): The board this card describes has since evolved, so its snapshot numbers are historical: a `blocked` column was added to `boards/project-backlog/.config.json` at the owner's instruction (anything that cannot be burnt down moves there with its reason journalled), the burn-down session drove cards 01/07/08/09/10 to done/review, and cards 14 and 15 were added for the follow-ons that had been living only in journal entries. Decisions grew to 7 (07 is `Proposed`, awaiting the owner). The checklist above still describes the bootstrap correctly; review of this card is sign-off on the bootstrap, not on the later burn-down.
- **claude-lead** (2026-07-29T22:40:00.000Z): Reviewed and approved as delegated reviewer. Board, 7 decisions, docs tree and skill all present and actively in use — this session ran entirely on the conventions this card installed, which is the strongest review a process bootstrap can get. Card ordering has since been validated by events (the live-DCS cards were indeed the highest-value hour: they produced #69 and three new defect cards). Moved to done.
