---
column: review
labels: [bug, webview]
priority: med
agent: claude
live: false
updatedAt: 2026-08-05T18:05:26.000Z
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
- [x] Full gate green (`npm run pre-commit`)

## Comments

- **claude** (2026-08-05T18:00:16.000Z): Picked this up as the first of the v0.17.0 QA batch (#70-#80), working them in issue order. Confirmed the root cause reading `media/marketplace.css:310-319` against the four `.empty` call sites in `media/marketplace.js` — only `:301` ("No mods match your search.") is a lone text node and renders correctly today. The three spinner states share the defect with the reported one, so they are in scope here rather than left for a second pass at the same six lines.
- **claude** (2026-08-05T18:05:26.000Z): Fixed. All five states now wrap their copy in one `<p>` — `media/marketplace.js:208` (Connecting), `:298` (Searching GitHub), `:302-303` (the reported empty grid and the no-match sibling) and `:385` (Loading product). The product error at `:392` already had a `<p>` and was the one state rendering correctly. Added `.empty p { margin: 0 }` at `media/marketplace.css:320-328`, which the issue did not call for but the wrapper needs: without it the paragraph's default 1em margins stack on top of the column's own 12px `gap`, and the same reset tidies the product-error `<p>` that has been carrying them all along. The full rationale sits in the CSS next to `.empty` — that is where the flex column that causes it lives — with a short pointer at `media/marketplace.js:294-295`.
- **claude** (2026-08-05T18:05:26.000Z): Covered by `tests/marketplace.spec.ts:262-297`, which asserts geometry rather than copy: the two `.mono` chips share a baseline (delta < 2px) and the block is one line tall, not five rows plus four gaps. That distinction is the point of the test — the neighbouring `toContainText("dcs-studio")` assertion at `:258` passed for the entire life of the bug. Verified it fails on the unfixed markup (chip delta 56px) before accepting the green. Both boxes are read in a single `page.evaluate` because the auth and listings pushes each re-render, and a locator measured across that seam returns null for a detached node. Gate: lint, `typecheck:tests`, 1428 unit, 914 integration, 267 e2e, and `coverage:e2e` at 100% across 14 webview scripts — all green.
