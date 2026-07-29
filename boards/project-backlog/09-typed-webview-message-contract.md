---
column: review
labels: [webview, tests]
priority: med
agent: claude
live: false
updatedAt: 2026-07-29T06:40:00.000Z
---
# Declare the webview ↔ panel message contract as a type

Gap G3 from the testing audit
(`docs/04-quality/01-testing-audit.md:114-127`), and the first entry under "What
is deliberately not done" (`docs/04-quality/01-testing-audit.md:385-389`).

Both halves of every webview protocol now execute under their own gate, so a
dropped handler fails a test — the seam is no longer held together by discipline
alone. What is still missing is a *declared* contract: a typed
`HostMessage`/`WebviewMessage` union shared by the presenter and `media/*.js`,
so one table-driven test can assert every message type the webview emits is
handled and vice versa.

The audit is explicit that the cheap version is the wrong one: deriving the table
by regex produces false failures, because the webviews use several dispatch
shapes. It says this is worth doing **alongside a wider presenter rollout** —
which makes it a natural follow-on to card 08 rather than standalone work.

## Checklist

- [x] Wait on, or land with, the presenter rollout (card 08)
- [x] Declare the message unions in `src/core/` where both sides can name them
- [x] Add the table-driven both-directions test
- [ ] Extend the contract past console + marketplace (blocked on presenters for
      the other nine webviews — see the comment below)

## Comments

- **claude** (2026-07-29T06:40:00.000Z): Declared the contract in `src/core/app/webviewContract.ts:1-269` — four unions (`ConsoleWebviewMessage:66`, `ConsoleHostMessage:79`, `MarketplaceWebviewMessage:138`, `MarketplaceHostMessage:150`) plus a runtime table (`CONSOLE_PROTOCOL:226`, `MARKETPLACE_PROTOCOL:236`) whose `toHost`/`toWebview` lists are built from mapped types over those unions (`src/core/app/webviewContract.ts:112-133`, `:175-197`), so an array and its union cannot drift without a compile error. Nothing is inferred from `media/*.js` source text — the audit's warning about the several dispatch shapes is precisely why the webview half is *driven* rather than scanned. Wired both presenters to it: `post` is now typed to the host union (`src/core/app/consolePresenter.ts:103`, `src/core/app/marketplacePresenter.ts:49`) and the inbound types are the declared unions (`src/core/app/consolePresenter.ts:40`, `src/core/app/marketplacePresenter.ts:36`), which makes a typo'd `case` or an undeclared push a `npm run compile` failure. Closing the inbound unions broke exactly two call sites — the deliberate "ignores an unknown message type" tests, now cast with a comment saying why (`test/unit/bridge/consolePresenter.test.ts:439-449`, `test/unit/marketplace/marketplacePresenter.test.ts:502-511`). Runtime behaviour unchanged: the diff is types, comments and tests only.
- **claude** (2026-07-29T06:40:00.000Z): The both-directions test is split across the layers that can actually execute each half. Host half in the unit layer (`test/unit/core/webviewContract.test.ts:1-434`): exhaustive `Record` drive plans (`:226-252`) asserted key-for-key against the protocol lists, every declared `toHost` message asserted to be *acted on* (`:288-295`), and a scripted run asserted to *produce* exactly the declared `toWebview` set (`:307-327`, `:351-433`). Webview half in the e2e layer (`tests/webviewContract.spec.ts:1-258`): the real `media/*.js` is driven in Chromium and the set it posted is asserted equal to `toHost`, while every `toWebview` push is asserted *consumed* — `previews/harness.js:36-47` now records `{type, changed}` per host push, `changed` being whether the document differed either side of the (synchronous) dispatch. Census in the integration layer (`test/integration/webview/webviewContract.test.ts:1-71`): the covered set plus `UNCOVERED_WEBVIEWS` must be exactly the preview directory, so a twelfth webview cannot appear on neither list.
- **claude** (2026-07-29T06:40:00.000Z): Falsifiability, both directions, per the PR #67 lesson that a rule can become complete and unfalsifiable in the same commit. Dropping one entry (`launch`) from `CONSOLE_PROTOCOL.toHost`: unit fails ("drives exactly the declared message set", 6 keys vs 5) and e2e fails ("messages the webview posted", `+ "launch"`). Emptying both protocols' `toHost`/`toWebview`: **5 unit tests fail** (the non-empty guard plus all four set equalities) and **both e2e contract tests fail** — the table cannot be quietly emptied into a green suite, because every assertion is an equality against a set produced by running the code, never an assertion of absence. Deleting `case "error"` from `media/console.js`'s router makes the e2e half fail with `error → changed: false`, i.e. the consumption probe catches it on its own with the drive's own DOM expectation removed. The undeclared-message controls (`test/unit/core/webviewContract.test.ts:297-305`, `tests/webviewContract.spec.ts:243-257`) prove "was acted on" / "changed the document" can come back false, so the positive results are not vacuous.
- **claude** (2026-07-29T06:40:00.000Z): **Coverage is partial and that is the honest outcome.** Covered: `console` (`media/console.js` + `media/console-explorer.js`, 8 webview→host / 9 host→webview) and `marketplace` (`media/marketplace.js`, 9 / 11) — the two panels with a `vscode`-free presenter to drive. Not covered: `docs`, `log`, `manifest`, `mymods`, `nav`, `newproject`, `publish`, `setup`, `skills`, named in `src/core/app/webviewContract.ts:259-269` and checked against `previews/` so the gap is data rather than an omission. Extending it means giving those panels presenters first; declaring unions for a panel whose host half is welded to `vscode` would leave the host side unexecutable and the contract half-checked. Two honest limits worth knowing: (a) `explorerConfig` is declared `silent` (`src/core/app/webviewContract.ts:233`) because it only moves the explorer's `**` sweep budget and renders nothing — the e2e half asserts it *stays* silent but cannot prove the console consumed it; (b) `product:busy` needed pushing at an already-loaded product page to be observable at all (`tests/webviewContract.spec.ts:188-198`), because `media/marketplace.js:364-375` puts itself into the loading shell before the host's busy push arrives — a redundancy in the flow, not a mismatch, and the message still matters on the retry path.
- **claude** (2026-07-29T06:40:00.000Z): **No real webview/host mismatch surfaced.** The structural diff the audit reported at `docs/04-quality/01-testing-audit.md:123-125` still holds: every message either side sends is handled by the other, for both covered panels. Gates, run serially, all exit 0: `npm run lint`, `npm run compile`, `npm run typecheck:tests`, `npm run coverage:unit` (1177 tests, 100%), `npm run coverage:integration` (929 tests, 100%), `PW_CHROMIUM_PATH=… npm run coverage:e2e` (245 tests, 100% across 14 webview scripts). `KNOWN_CROSSINGS` untouched and still empty.
