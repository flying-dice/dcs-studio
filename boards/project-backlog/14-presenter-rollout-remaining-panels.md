---
column: doing
labels: [extension, webview, tests]
priority: med
agent: opus-contract
live: false
status: My Mods landed; eight webviews still uncovered — next up is `log` (presenter first)
progress: 15
updatedAt: 2026-07-29T08:45:00.000Z
---
# Roll presenters out to the remaining panels, extending the message contract as they land

The explicit follow-on left by cards 08 and 09. Three panels now have
presenters — marketplace (the pilot), My Mods (#40), and the console (card 08)
— and the declared message contract in `src/core/app/webviewContract.ts` covers
exactly those with typed unions on both sides (console, marketplace and — as of
the first checklist item below — My Mods).

Eight webviews remain named in `UNCOVERED_WEBVIEWS`
(`src/core/app/webviewContract.ts:327`): docs, log, manifest, nav,
newproject, publish, setup, skills. The census test
(`test/integration/webview/webviewContract.test.ts`) holds that list to exactly
the `previews/` directory, so every extension shrinks a checked list rather
than an unwritten one.

Order of attack, by decision-logic density rather than alphabetically: the
audit's G5 table (`docs/04-quality/01-testing-audit.md:140-160`) ranks the
panels; `log` and `publish` carried the most logic of what remains. `nav` is a
`WebviewView`, not a panel — it may need its own shape, per card 07's finding
that `navView` hand-rolls teardown for structural reasons.

Per card 09's rule: **a union for a panel whose host half is welded to
`vscode` would leave that half unexecutable — presenter first, contract
second.** One panel per change, each verified the way card 08 was.

## Checklist

- [x] Add My Mods to the contract (presenter already exists)
- [ ] `log` — presenter + contract entry
- [ ] `publish` — presenter + contract entry
- [ ] `setup`, `newproject`, `manifest`, `docs`, `skills` — same, one at a time
- [ ] Decide what, if anything, `nav` needs
- [ ] Empty `UNCOVERED_WEBVIEWS`, making the census assertion total

## Comments

- **opus-contract** (2026-07-29T08:45:00.000Z): Took the FIRST checklist item only — My Mods into the contract — leaving the other panels alone; one panel per change is the rule card 09 set and this change keeps it. Enumerated both directions from the code before declaring anything, per card 09's warning against inferring from source text: `media/mymods.js:198-249` wires 13 distinct posts (`refresh`, `enable`, `disable`, `uninstall`, `update`, `launch`, `stop`, `openDir`, `openExternal`, `openDocs`, `createShortcut`, `revealBat`, `cleanUninstall`) and its router at `media/mymods.js:252-277` consumes 4 (`init`, `busy`, `progress`, `entrypoint`); `MyModsPresenter.handle` (`src/core/app/myModsPresenter.ts:129-189`) switches on exactly those 13 and posts exactly those 4 (`:232`, `:243`, `:256`, `:276`, `:315`, `:321`, `:328`). **13 / 4, and no mismatch in either direction** — every message one side sends the other handles. Worth noting one route is not obvious from `mymods.js` alone: `openDocs` comes from the shared script-execution notice's Learn-more button (`media/shared.js:181-187`, `data-docs="sandbox"`), which `media/mymods.js:247-249` picks up by `[data-docs]` — exactly the "several dispatch shapes" the audit said a regex contract gets wrong.
- **opus-contract** (2026-07-29T08:45:00.000Z): Declared `MyModsWebviewMessage`/`MyModsHostMessage` at `src/core/app/webviewContract.ts:208-222` and `:224-235`, with the mapped-type key tables at `:237-259` and `MYMODS_PROTOCOL` at `src/core/app/webviewContract.ts:303-309`, following the console/marketplace pattern exactly (`toHost`/`toWebview` are `Object.keys` over the mapped types, so an array cannot drift from its union without a compile error). `silent: []` — unlike the console's `explorerConfig`, all four host pushes render. `mymods` removed from `UNCOVERED_WEBVIEWS` (`src/core/app/webviewContract.ts:327-335`), which is now eight names; the integration census (`test/integration/webview/webviewContract.test.ts:43-46`) picked it up with no edit beyond a stale "two panels" comment, and its scripts/preview check (`:57-67`) confirms `previews/mymods.html` really loads only `media/mymods.js`. Presenter typed to the declaration: `post` is `MyModsHostMessage` (`src/core/app/myModsPresenter.ts:114-119`) and `MyModsInbound` is now an alias of the declared union (`src/core/app/myModsPresenter.ts:51-58`), matching how `ConsoleInbound`/`MarketplaceInbound` are named. Closing the inbound type forced one honest structural change in `handle`: the hoisted `const repo = msg.repo` no longer type-checks against a discriminated union whose members do not all carry a repo, so narrowing is per case (`src/core/app/myModsPresenter.ts:129-189`). Behaviour is identical — the guards, the ordering and the effects are unchanged — and the existing 700-line presenter suite passes untouched apart from one cast where a test deliberately posts an undeclared type (`test/unit/install/myModsPresenter.test.ts:697-703`), the same concession cards 09 made for console and marketplace.
- **opus-contract** (2026-07-29T08:45:00.000Z): Both halves executed, in the layers that can actually execute them. Host half in the unit layer: a My Mods harness (`test/unit/core/webviewContract.test.ts:213-311`), an exhaustive `Record<MyModsInbound["type"], Drive<…>>` drive plan (`:355-369`) asserted key-for-key against `MYMODS_PROTOCOL.toHost`, each of the 13 asserted to be *acted on* (`:561-568`), a negative control proving "was acted on" can come back false (`:570-574`), and a scripted run asserted to produce exactly the 4 declared `toWebview` types (`:577-594`). Webview half in e2e (`tests/webviewContract.spec.ts:244-304`): the real `media/mymods.js` driven in Chromium against `previews/fixtures/mymods.js`, set-equality on what it posted and every push asserted consumed via the harness probe. Two drive notes: the per-mod buttons are spread across *different* mods on purpose (Update and Uninstall latch their row busy, and a latched row's buttons are disabled, so driving them all through one mod would be driving a page a user could not), and `busy`/`progress` have no fixture reply behind them so they are pushed directly — the real host only emits them off a lifecycle action.
- **opus-contract** (2026-07-29T08:45:00.000Z): Falsifiability, three mutations, each reverted. (1) Dropping `revealBat` from `MYMODS_PROTOCOL.toHost`: unit "drives exactly the declared message set" fails (12 keys vs 11) **and** the e2e set-equality fails with `+ "revealBat"` — both ends catch it independently. (2) Emptying `toHost` and `toWebview` to `[]`: **3 unit tests fail** (the non-empty guard plus both My Mods set equalities) and the e2e spec fails — the table cannot be quietly emptied into a green suite. (3) Deleting the `busy` branch from `media/mymods.js`'s router: e2e fails, and after also removing the drive's own `toBeDisabled` expectation it *still* fails, on `busy — Expected: true, Received: false` — the consumption probe catches a dropped handler on its own, so the `changed` flags are not riding on hand-written DOM assertions.
- **opus-contract** (2026-07-29T08:45:00.000Z): Gates, run serially, no coverage-ignore added anywhere. Green: `npm run lint`, `npm run compile`, `npm run typecheck:tests`, `npm run coverage:unit` (**1193 tests, 100%** statements/branches/functions/lines), `npm run coverage:e2e` (**246 tests, 100% across 14 webview scripts**, `media/mymods.js` among them). **`npm run coverage:integration` did NOT pass on this machine, and not because of this change**: 6 tests in `test/integration/adapters/linkerStrategies.test.ts` fail with `EPERM … symlinkSync`, i.e. the process lacks the Windows create-symlink privilege (Developer Mode off). Verified pre-existing by `git stash`ing the whole diff and re-running the same file at `eca03be` — identical 6 failures — and by a bare `fs.symlinkSync` in a temp dir, which also returns `EPERM`. The rest of the layer is green: 49 files / 906 passed with that one file excluded, including the contract census. Flagging rather than papering over it — the integration gate is genuinely unverified here and needs a re-run on a box with the privilege.
- **opus-contract** (2026-07-29T08:50:00.000Z): Closed the doc loop card 09 opened: `docs/04-quality/01-testing-audit.md:385-398` said "two of eleven webviews" and "the other nine" — now three and eight, and it names this card alongside 09 so the next reader can find the increment. Card left in `doing` with `live: false` and an honest status: five checklist items remain and the next one (`log`) needs a presenter written before a union is worth declaring, per card 09's rule.
