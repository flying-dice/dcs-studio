---
column: done
labels: [webview, extension, cleanup]
priority: low
agent: opus-np-defects
live: false
updatedAt: 2026-07-30T21:30:00.000Z
---
# New Project panel: the `created` message can never be seen

Found by card 14's `newproject`-presenter extraction (journalled there),
preserved verbatim rather than changed mid-refactor. Declared honestly in the
contract as the only `silent` message on this panel
(`src/core/app/webviewContract.ts`, `NEWPROJECT_PROTOCOL.silent`).

The host posts `created` and the webview handles it
(`media/newproject.js:213-215`), but all the handler does is set
`state.creating = false` without re-rendering — and in **both** branches the
panel is destroyed immediately afterwards:

- in place: `created` is posted, then the `close` effect disposes the panel
  (`src/core/app/newProjectPresenter.ts`, the in-place branch);
- new folder: `created` is posted, then the `openFolder` effect reloads the whole
  extension host.

So the latch it drops belongs to a form that is already going away. It is either
dead weight to remove from both halves, or the sign of a missing state — a
"Created — opening…" pane would be a real use for it, and would also cover the
case where `vscode.openFolder` is slow enough for the user to wonder whether
Create did anything.

Deciding which is the work; both halves and the contract entry move together
either way.

## Checklist

- [x] Decide: remove `created` from both halves, or give it something to render
- [x] Update `NEWPROJECT_PROTOCOL` (`silent` list or the union) to match

## Comments

- **opus-np-defects** (2026-07-30T10:55:00.000Z): **Decided: removed, from both halves and the contract.** The reasoning, because the alternative was real. First the failure path, since that is the only way the panel outlives a `create`: `create` posts `error` from the `catch` and returns without any effect (`src/core/app/newProjectPresenter.ts:180-184`), so a FAILED scaffold never went near `created` — it really was posted on success only, on both branches, immediately before the panel was closed or the window reloaded. Nothing depended on its timing either: `post` is fire-and-forget on both sides of the boundary, both branches' awaits are on the persists rather than on the push, and the in-place branch's `close` effect ran unconditionally after it. So removing it changes no ordering and no reachable state.
- **opus-np-defects** (2026-07-30T10:55:00.000Z): What tipped it past "dead weight either way" is that `created` was not neutral — it was a small *liability*. Its whole body was `state.creating = false` with no re-render, and `media/newproject.js`'s name-input handler re-evaluates the Create button in place (`media/newproject.js:152-163`): so in any moment the document survived the message — the teardown window, or the pathological case where `vscode.openFolder` is handed the folder already open and therefore does not reload — one keystroke would have re-armed Create and allowed a second scaffold into the same folder. Removing the message makes the double-submit latch strictly stronger: `creating` now stays set until the document goes away, which is the whole point of a latch on a form that is leaving. The "Created — opening…" pane the card offered as the other answer was rejected on the same evidence: it is a nicer word for a wait the spinner and "Creating…" already describe honestly, it would flash for microseconds on the in-place branch, and it would have to be added to a form whose next act is to be disposed. Better a protocol with nothing dead in it (the not-a-base-class shape of card 07: the honest small thing beats the speculative structure).
- **opus-np-defects** (2026-07-30T10:55:00.000Z): The change, both halves plus the contract. Host: the two `post({type:"created"})` calls are gone from `src/core/app/newProjectPresenter.ts:155-157` and `src/core/app/newProjectPresenter.ts:170-174`, each replaced by a comment saying what success reports instead (the close, the reload). Webview: `media/newproject.js:213-219` drops the branch, and says out loud that success has no message and why the latch stays latched. Contract: `created` removed from `NewProjectHostMessage` — the surviving `error` member now carries the reasoning at `src/core/app/webviewContract.ts:476-483` — and from `NEWPROJECT_TO_WEBVIEW_KEYS` at `src/core/app/webviewContract.ts:487-491`; `NEWPROJECT_PROTOCOL.silent` is now `[]` (`src/core/app/webviewContract.ts:793-797`), so this panel has no declared message that renders nothing, and no dead declaration either.
- **opus-np-defects** (2026-07-30T10:55:00.000Z): Pinned rather than asserted. Unit: both success branches now assert `posted` is EXACTLY empty (`test/unit/project/newProjectPresenter.test.ts:222-227` new-folder, `test/unit/project/newProjectPresenter.test.ts:276-278` in place), which is what fails if anyone re-adds a success push; and the contract's host→webview set-equality no longer drives a successful `create` at all (`test/unit/core/webviewContract.test.ts:1274-1282`), because a success produces nothing to declare. e2e: the fixture's `done` reply is gone (`previews/fixtures/newproject.js:88-92`) — success is silence, stated in the header comment — and `tests/newproject.spec.ts:243-263` now proves the LIABILITY is closed as well as the message: after a successful create it types into the name field, the exact path that re-evaluates the button, and asserts Create is still disabled and Enter posts no second `create`. The contract spec's newproject drive lost its `created` step (`tests/webviewContract.spec.ts:471-477`). Mutation: re-declaring `created` in the union + keys fails the unit set-equality (a declared message the presenter never produces) — run, 1 failed as expected. Gates: lint/compile/typecheck:tests clean; `coverage:unit` 1405 tests, 100/100/100/100; `coverage:e2e` 266 tests, 100% across 14 webview scripts; `coverage:integration` 884 passed with the 6 pre-existing EPERM symlink failures in `test/integration/adapters/linkerStrategies.test.ts` (this box cannot create symlinks; nothing in this card's diff is near them).
- **claude-lead** (2026-07-30T21:30:00.000Z): Reviewed and approved (delegated review authority). The removal decision was checked, not assumed: created was success-only, timing-neutral, and its only observable effect was a double-scaffold liability — the audit verified all three claims against the code. Contract truthful, silent list empty. Done.
