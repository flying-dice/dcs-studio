---
column: review
labels: [bug, webview, extension]
priority: low
agent: sonnet-handshake
live: false
updatedAt: 2026-07-30T04:00:00.000Z
---
# Publish panel: the folderless boot handshake can lose the load race

Found by card 14's publish-presenter extraction (journalled there), preserved
verbatim rather than fixed mid-refactor.

In a window with no workspace folder, the panel posts `nofolder`
synchronously — potentially before the webview document has loaded — and the
webview's own boot `{type:"refresh"}` is then dropped by the
`if (root === null) return` guard at the top of `media/publish.js`'s router.
If the initial push loses the race, the user sees an empty Publish panel.
Every other covered panel answers its boot handshake unconditionally.

The presenter (`src/core/app/publishPresenter.ts`) is now the single place a
fix goes: answer `refresh` in the no-folder state with the `nofolder` push
(making the handshake unconditional like the other panels), rather than only
pushing it once at construction.

## Checklist

- [x] Make the no-folder state answer the boot `refresh` instead of relying on the constructor push
- [x] Unit-drive the race (handshake after a lost initial push) in the presenter suite
- [x] e2e: folderless preview shows the no-folder pane, not an empty panel

## Gates

- [x] lint — biome check, 288 files, no fixes applied (sonnet-handshake, 2026-07-30T04:00:00.000Z)
- [x] compile — tsc -p ./ clean (sonnet-handshake, 2026-07-30T04:00:00.000Z)
- [x] typecheck:tests — tsc -p tsconfig.test.json --noEmit clean (sonnet-handshake, 2026-07-30T04:00:00.000Z)
- [x] coverage:unit — 1250 tests passed, 100% stmts/branch/func/line (sonnet-handshake, 2026-07-30T04:00:00.000Z)
- [x] coverage:integration — 908 passed, only the 6 pre-existing EPERM symlink failures in linkerStrategies.test.ts (verified pre-existing on base, box note) (sonnet-handshake, 2026-07-30T04:00:00.000Z)
- [x] coverage:e2e — 249 passed, 100% across all 14 webview scripts including publish.js (sonnet-handshake, 2026-07-30T04:00:00.000Z)

## Comments

- **sonnet-handshake** (2026-07-30T03:40:00.000Z): Claimed the card. Read `src/core/app/publishPresenter.ts` and `media/publish.js`. The `if (root === null) return` guard the card names actually lives in the presenter's `handle()` at `src/core/app/publishPresenter.ts:142` (pre-fix), not in `media/publish.js` — that file's `nofolder` case (`media/publish.js:159-161`) has no guard and renders correctly from any state, so a late push already works fine there. The real bug: `handle()` short-circuited on `root === null` *before* the `switch`, so a boot `{type:"refresh"}` arriving after the constructor's one-shot `nofolder` push was silently dropped — no second answer, ever.
- **sonnet-handshake** (2026-07-30T03:55:00.000Z): Fixed in `src/core/app/publishPresenter.ts:139-152` — `handle()` now answers `refresh` unconditionally as the very first check (calls `this.refresh()`, which already does the right no-folder-vs-full-init branch), before the `root === null` guard that still gates every other action. Removed the now-unreachable `case "refresh"` from the switch below it. Confirmed `src/publish/publishPanel.ts:69`'s constructor-time `void this.presenter.refresh()` needed no change — it's now just the first of two chances instead of the only one, exactly matching every other covered panel's pattern.
- **sonnet-handshake** (2026-07-30T03:58:00.000Z): Unit-drove the race in `test/unit/publish/publishPresenter.test.ts:169-217` (added case) plus a dedicated new test "answers a boot refresh with nofolder even with no folder open..." right after it, asserting a bare `handle({type:"refresh"})` with `root: null` posts `nofolder` with no preflight call. Updated the pre-existing "ignores every action" test (renamed to "...but refresh...") to drop `refresh` from the ignored list, since it is deliberately no longer ignored.
- **sonnet-handshake** (2026-07-30T04:00:00.000Z): e2e in `tests/publish.spec.ts` — new test "a late nofolder push still shows the no-folder pane, not a stuck empty panel" using a new fixture scenario `nofolder-late` in `previews/fixtures/publish.js:19-27,72-80` that deliberately withholds the reply to the boot `refresh` (modelling the lost race), then the test calls `hostSend(page, {type:"nofolder"})` itself and asserts the panel goes from no `no-folder-note` to a visible one. This proves the webview side needs no change — it already renders correctly from a late push — which is what the presenter fix now guarantees actually happens. No webview contract changes: `nofolder` was already declared in `PUBLISH_PROTOCOL` (`src/core/app/webviewContract.ts`), the fix only changes when the presenter sends it, not what it sends.
- **sonnet-handshake** (2026-07-30T04:00:00.000Z): All gates green: lint, compile, typecheck:tests, coverage:unit (100%), coverage:integration (908 passed, 6 pre-existing EPERM symlink failures in `test/integration/adapters/linkerStrategies.test.ts` per the box notes, unrelated to this card), coverage:e2e (249 passed, 100% across all 14 webview scripts). Moving to review.
