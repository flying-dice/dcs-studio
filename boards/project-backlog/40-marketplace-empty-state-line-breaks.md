---
column: done
labels: [bug, webview]
priority: med
agent: claude
live: false
review-verdict: clean
pr: https://github.com/flying-dice/dcs-studio/pull/81
peer-reviewed: yes
updatedAt: 2026-08-05T19:07:50.000Z
---
# Marketplace empty state splits its sentence around the topic chips

[Issue #70](https://github.com/flying-dice/dcs-studio/issues/70), from QA of the
v0.17.0 release artifact. Browse Mods, signed in with zero tagged repos, renders
the empty-state copy across five lines — one per DOM node:

```
No public repos are tagged
dcs-studio
yet. Publish one by adding the
dcs-studio
topic to a GitHub repo.
```

`.empty` in `media/marketplace.css:310-319` is `display: flex; flex-direction:
column; gap: 12px`, which the product-error state at `media/marketplace.js:387`
needs — it stacks a message over a Try-again button. But the list-empty state at
`media/marketplace.js:300` puts bare text nodes and two `<span class="mono">`
chips *directly* inside `.empty`, so each becomes its own flex row.

The same defect hits the three spinner states (`media/marketplace.js:208`,
`:296`, `:380`): `.spin` is `display: inline-block`, but as a direct flex child
it is blockified, so the spinner sits on its own row 12px above its label.

Fix is per the issue: wrap each state's content in a single `<p>` so it is one
flex item and the inline chips stay inline. The flex column stays — it is
correct for the states that genuinely stack children.

## Checklist

- [x] Wrap the list-empty sentence in a `<p>`
- [x] Wrap the three spinner states so icon and label share a line
- [x] Reset the `<p>` margin inside `.empty` so the wrapper adds no vertical space
- [x] E2E covers the one-line render, not just the text
- [x] E2E waits for the fixture's scripted replies before pushing its own
- [x] The measurement comes out of the polled call, not a second evaluate
- [x] The three spinner states get a test of their own
- [x] Thresholds chosen from measured values, and two-sided
- [x] Full gate green (`npm run pre-commit`)

## Gates

- [x] static — `npm run lint && npm run typecheck:tests` clean, 307 files (claude, 2026-08-05T18:48:08.000Z)
- [x] coverage — `npm run coverage` green: unit 100% (2076 stmts), integration 100% (2062 stmts), e2e 100% across 14 webview scripts (claude, 2026-08-05T18:48:08.000Z)
- [x] code-review — bounced once for a flaky test, clean on the second pass; findings and fixes journaled below (claude, 2026-08-05T18:48:08.000Z)
- [x] pr-open — PR #81 against develop (claude, 2026-08-05T18:48:08.000Z)
- [x] ci — all six checks pass on #81: compile+lint, unit, integration, e2e, Rust bridge, Windows (claude, 2026-08-05T18:48:08.000Z)

- [x] peer-reviewed — **approved by Jonathan Turnock** (owner), 2026-08-05T19:07:50.000Z. Recorded by claude at their explicit instruction because they could not edit the file; the decision is theirs, the keystrokes are not. An agent must not reach this line any other way.

## Comments

- **claude** (2026-08-05T18:00:16.000Z): Picked this up as the first of the v0.17.0 QA batch (#70-#80), working them in issue order. Confirmed the root cause reading `media/marketplace.css:310-319` against the four `.empty` call sites in `media/marketplace.js` — only `:301` ("No mods match your search.") is a lone text node and renders correctly today. The three spinner states share the defect with the reported one, so they are in scope here rather than left for a second pass at the same six lines.
- **claude** (2026-08-05T18:05:26.000Z): Fixed. All five states now wrap their copy in one `<p>` — `media/marketplace.js:208` (Connecting), `:298` (Searching GitHub), `:302-303` (the reported empty grid and the no-match sibling) and `:385` (Loading product). The product error at `:392` already had a `<p>` and was the one state rendering correctly. Added `.empty p { margin: 0 }` at `media/marketplace.css:320-328`, which the issue did not call for but the wrapper needs: without it the paragraph's default 1em margins stack on top of the column's own 12px `gap`, and the same reset tidies the product-error `<p>` that has been carrying them all along. The full rationale sits in the CSS next to `.empty` — that is where the flex column that causes it lives — with a short pointer at `media/marketplace.js:294-295`.
- **claude** (2026-08-05T18:05:26.000Z): Covered by `tests/marketplace.spec.ts:262-297`, which asserts geometry rather than copy: the two `.mono` chips share a baseline (delta < 2px) and the block is one line tall, not five rows plus four gaps. That distinction is the point of the test — the neighbouring `toContainText("dcs-studio")` assertion at `:258` passed for the entire life of the bug. Verified it fails on the unfixed markup (chip delta 56px) before accepting the green. Both boxes are read in a single `page.evaluate` because the auth and listings pushes each re-render, and a locator measured across that seam returns null for a detached node. Gate: lint, `typecheck:tests`, 1428 unit, 914 integration, 267 e2e, and `coverage:e2e` at 100% across 14 webview scripts — all green.
- **claude** (2026-08-05T18:31:43.000Z): Back to todo — local code review rejected it. The fix itself passed: the five wrapped states are sound, `.empty p` is scoped to a stylesheet only `src/marketplace/panel.ts` and `media/marketplace.js` load, and nothing else depends on the changed markup. **The new test is flaky, and I shipped it green without checking.** Two findings, both in `tests/marketplace.spec.ts`:
  1. `:271` — the test clicks `browse-anon-btn` and pushes its own `auth`/`listings` immediately, without waiting for the fixture's scripted replies. `previews/fixtures/marketplace.js:577-580` answers `browseAnon` with `listings:busy` at +10ms and 12 `listings` at +500ms. So the busy push lands ~7ms AFTER my pushes and flips `gridHtml` from `list-empty` to `list-loading`, then the 12 listings refill the grid and `list-empty` never returns — the poll at `:286` spends its 5s and times out. The sibling test at `:248` has the sync point mine dropped: `toHaveCount(12)` at `:254`.
  2. `:287` — `const g = (await geometry())!` measures a second time after the poll already succeeded, so the `!` papers over the same race arriving from the other side. It also makes the comment directly above it ("One evaluate, not two") false.
- **claude** (2026-08-05T18:31:43.000Z): Confirmed the mechanism before fixing rather than taking the review on trust. Serially the test finishes in ~150ms, comfortably inside the +10ms..+500ms window, so `--repeat-each=10 --workers=1` passed 10/10 and proved nothing. Under contention it is stark: `--repeat-each=24 --workers=6 --retries=0` gives **12 failed, 12 passed**. CI's `retries: 2` would have filed this as a retry-flake for someone else to chase.
- **claude** (2026-08-05T18:40:23.000Z): Both findings fixed in `tests/marketplace.spec.ts`. The test now drains the fixture with `toHaveCount(12)` before pushing anything of its own (`:326`), and the measurement moved into a `page.waitForFunction` that polls in the browser and hands back the value it settled on — one layout, one read, no second evaluate to straddle a re-render. `--repeat-each=48 --workers=8 --retries=0`: 48/48, against 12/24 failing before.
- **claude** (2026-08-05T18:40:23.000Z): Second review pass on my own fix found three more things, all now closed. (1) **Test gap of my own making** — I changed the three spinner states but only tested the empty-grid one, so the coverage gate proved those lines execute while nothing proved they lay out on one row. Added `:339-357`, which drives `list-loading` and fails at 46px on the unwrapped markup. (2) **The 40px ceiling was badly placed** — measured the real values rather than keep guessing: one line is 17, the smallest stacked layout is 46 (two line boxes plus the column's 12px gap). 40 left only 6px of headroom, so a runner with smaller font metrics could have passed on broken markup. It is 30 now, which still catches stacking at a 13px line box and still tolerates the copy wrapping. (3) **A false-green hole in my helper** — a state present but not laid out measures 0, `contentHeight` goes to -160, and every ceiling passes. The wait now requires a non-zero height, so that case times out by name instead.
- **claude** (2026-08-05T18:40:23.000Z): Shared `measureEmptyState` at `tests/marketplace.spec.ts:5-51` backs both tests. It is deliberately structure-blind — it looks for spans, never for the `<p>` that fixes the bug — so broken markup fails an assertion with a number in it rather than timing out. Verified both tests still fail on their own reverted markup before accepting green: chip spread 56 (ceiling 2) and spinner height 46 (ceiling 30). Gate: lint, `typecheck:tests`, 1428 unit, 914 integration, 268 e2e, `coverage:e2e` 100% across 14 webview scripts.
- **claude** (2026-08-05T18:48:08.000Z): Merged as `19f5f17` and the branch is deleted. **#70 is still open on GitHub** — the PR said `Closes #70`, but GitHub only auto-closes on merge into the DEFAULT branch, and this went to `develop`. It will close when develop ships to `main`; nobody needs to close it by hand. Retro-fitted this card to the review gates added to `.config.json` in the same sweep, since it is the worked example the guide points at.
