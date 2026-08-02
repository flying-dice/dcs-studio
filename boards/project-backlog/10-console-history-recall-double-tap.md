---
column: done
labels: [bug, webview]
priority: low
agent: claude
live: false
updatedAt: 2026-07-29T22:40:00.000Z
---
# Console history recall needs a double tap on ↑

Recorded in `docs/04-quality/02-testing-audit-2026-07.md:393-395` as known and
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

- [x] Decide: fix both directions with a navigation-mode flag, or specify the current behaviour
- [x] Make `spec/stories/017-lua-console.story.md` match the outcome
- [x] Cover it in the e2e layer

## Comments

- **claude** (2026-07-29T05:55:00.000Z): Fixed both directions. The parked reasoning was half right — a navigation-mode flag is needed, but the ergonomics cost was avoidable, because the real cause of the double tap was the *guard*, not `histIdx`. `media/console.js:212-218` replaces "the caret is at offset 0" with "the caret is on the input's first line" (`atFirstLine`) and mirrors it for ↓ (`atLastLine`); `media/console.js:220-225` (`recall`) leaves the caret at the end of the recalled text, and a one-line entry is on the first *and* the last line at once, so each direction is now one tap per entry. Multi-line snippets are untouched: ↑/↓ stay the caret's until it reaches the first/last line, which is exactly the intent the old offset-0 guard was protecting, and it holds mid-walk too so a recalled multi-line entry stays editable. The transient mode lives at `media/console.js:26-30` (`navigating`/`histIdx`/`draft`) — deliberately NOT in the `vscode.setState` payload at `media/console.js:150`, so a reloaded panel restores only `{history, env, tab}` and always starts a fresh walk. The flag earns its keep on the two things the guard alone cannot do: `media/console.js:238-246` stashes the half-typed draft when a walk begins and `media/console.js:247-253` puts it back when ↓ steps past the newest entry (ending the walk there), and `media/console.js:231-233` + `media/console.js:200` end the walk when the user edits the box or runs a snippet, so the next ↑ restarts from the newest entry instead of resuming a stale position. `run()` no longer touches `histIdx` at all — the walk resets on entry.
- **claude** (2026-07-29T05:55:00.000Z): Spec now states the behaviour it was wrongly credited with. Rewrote the History scenario at `spec/stories/017-lua-console.story.md:108-117` (one tap per entry each way, holds still at the oldest, ↓ past the newest restores the draft and ends the walk) and added `spec/stories/017-lua-console.story.md:119-127`, "History never takes ↑ / ↓ away from a multi-line snippet", in the surrounding Given/When/Then/And style under the same Rule. Corrected the audit's "deliberately not done" bullet at `docs/04-quality/02-testing-audit-2026-07.md:393-402` — it is now struck through, points at this card, and retracts the "documented in the spec" claim.
- **claude** (2026-07-29T05:55:00.000Z): e2e coverage in `tests/console-repl.spec.ts:104-263` — rewrote the walk test (`tests/console-repl.spec.ts:104`) to assert the single tap, and added six: ↓ before a walk starts (`tests/console-repl.spec.ts:136`), ↑ with no history (`tests/console-repl.spec.ts:149`), draft restore (`tests/console-repl.spec.ts:158`), typing ends the walk (`tests/console-repl.spec.ts:175`), ↑/↓ inside a multi-line snippet (`tests/console-repl.spec.ts:200`), a recalled multi-line entry staying editable (`tests/console-repl.spec.ts:217`), and running ending the walk (`tests/console-repl.spec.ts:239`). No coverage-ignore comments; `media/console.js` is at 100% statements/branches/functions/lines under the e2e gate. Gates: `npm run lint` exit 0, `npm run typecheck:tests` exit 0, `npm run coverage:e2e` exit 0 with 242 tests passing and "100% across 14 webview scripts".
- **claude** (2026-07-29T05:55:00.000Z): Mutation-tested the fix — six mutations of `media/console.js`, all killed. Reverting `atFirstLine` to `selectionStart === 0` (the original defect) failed 4 tests; dropping the draft stash failed 2; a no-op `input` listener failed 1; dropping `navigating &&` from the ↓ guard failed 1; forcing `atLastLine` true failed 1. A seventh, removing `navigating = false` from `run()` (`media/console.js:200`), initially SURVIVED — that gap is why `tests/console-repl.spec.ts:239` exists; with it in place the mutant fails and the unmutated suite is 24/24 green.
- **claude-lead** (2026-07-29T22:40:00.000Z): Reviewed and approved as delegated reviewer. Both-direction fix present in media/console.js (atFirstLine/atLastLine), spec scenarios at spec/stories/017-lua-console.story.md:108-127 match the behaviour, e2e at 100% in today's CI. Note for the record: a stray click from the card-18 session briefly toggled a checklist item here and was reverted the same minute — verified intact at 3/3. Moved to done.
