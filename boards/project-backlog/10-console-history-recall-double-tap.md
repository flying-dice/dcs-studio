---
column: backlog
labels: [bug, webview]
priority: low
updatedAt: 2026-07-29T05:22:16.000Z
---
# Console history recall needs a double tap on ↑

Recorded in `docs/04-quality/01-testing-audit.md:393-395` as known and
deliberately unfixed.

`media/console.js:187` resets `histIdx = history.length` after each run, and the
↑ handler at `media/console.js:197-200` does `histIdx = Math.max(0, histIdx - 1)`
before reading. So the first press lands on the entry just pushed rather than the
one before it. The obvious fix moves the problem to ↓
(`media/console.js:202-208`); fixing both directions needs a history-navigation
mode flag, which changes multi-line editing ergonomics — that is why it is
parked.

The audit says this is "documented in the spec". It is not: the History scenario
at `spec/stories/017-lua-console.story.md:107-109` says only that "previous
entries are recalled (up to 100, duplicates collapsed)" and describes no
double-tap. Whichever way this is resolved, the spec scenario and the behaviour
should end up saying the same thing.

## Checklist

- [ ] Decide: fix both directions with a navigation-mode flag, or specify the current behaviour
- [ ] Make `spec/stories/017-lua-console.story.md` match the outcome
- [ ] Cover it in the e2e layer
