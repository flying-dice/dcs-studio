---
column: done
labels: [extension, webview, tests]
priority: med
agent: claude
live: false
updatedAt: 2026-07-29T22:40:00.000Z
---
# Extract a presenter for the console panel

Listed under "What is deliberately not done" in
`docs/04-quality/02-testing-audit-2026-07.md:390-392`: presenter extraction stopped after
the marketplace pilot, and `src/bridge/consolePanel.ts` "still carries enough
decision logic to deserve it".

The pilot is the worked example — `src/core/app/marketplacePresenter.ts` took 255
lines of panel down to a 129-line VS Code shell plus a presenter that knows
nothing about the editor and describes side effects as values
(`MarketplaceEffect`). `src/core/app/myModsPresenter.ts` followed in the
clean-code round (#40).

`consolePanel.ts` was measured at 309 lines with 22 `vscode.` references — 7%
coupling — in the audit's panel table (`docs/04-quality/02-testing-audit-2026-07.md:145-150`).

This is a quality move, not a coverage one: the panel is already at 100% under
the integration gate. What it buys is moving that logic under the unit gate,
where it can be tested without the `vscode` double at all.

## Checklist

- [x] Define the console presenter's state and message types
- [x] Move the decision logic out of `src/bridge/consolePanel.ts`
- [x] Cover the presenter under the unit layer; keep the shell at 100% under integration

## Comments

- **claude** (2026-07-29T06:11:24.000Z): Extracted `ConsolePresenter` to `src/core/app/consolePresenter.ts:119-306`, following the marketplace pilot's shape. Types: `ConsoleInbound` (`src/core/app/consolePresenter.ts:33-44`) for the webview's messages, `ConsoleEffect = { kind: "launchBridge" }` (`src/core/app/consolePresenter.ts:30`) as the one thing only the editor can do, and `ConsoleExportSave` (`src/core/app/consolePresenter.ts:47-54`) as the request the host answers. State is the per-bridge tail map (`src/core/app/consolePresenter.ts:112-122`) — the output-ring cursor plus "was it connected last tick", which is the only real state the panel held. The bridges are reached through two narrow interfaces declared beside the presenter (`src/core/app/consolePresenter.ts:64-86`) rather than by naming `BridgeClient`; deliberately narrower than `DebugBridgePort`, which has none of the `repl_*` family the console lives on. Moved: env routing, request validation, every error→message mapping, the export request/response protocol, and the whole tail state machine (`src/core/app/consolePresenter.ts:259-303`). The local `errText` helper is gone in favour of the existing `core/domain/errorText.ts`, and `exportFileBase` is still the domain helper it always was.
- **claude** (2026-07-29T06:11:24.000Z): The shell `src/bridge/consolePanel.ts` went 296 → 139 lines (audit's 309/22 predates card 07's `disposeWithPanel` move, which this builds on at `src/bridge/consolePanel.ts:60-63`); `vscode.` references 12 → 11, of which 6 are type positions and only 5 are runtime calls — `onDidChangeConfiguration` (`src/bridge/consolePanel.ts:87`), `commands.executeCommand` for the launch effect (`src/bridge/consolePanel.ts:100`), and `Uri.file`/`workspace.fs.delete`/`getConfiguration` in the export + settings plumbing (`src/bridge/consolePanel.ts:113-126`). Left in the shell on purpose: the poll *timer* (`src/bridge/consolePanel.ts:93` — cadence is an adapter concern, the presenter just exposes `poll()`), the settings read behind a `wildcardDepth()` thunk so a change still lands live, and the sim-side temp-file lifetime. That last one moved *into* the shell: `save()` (`src/bridge/consolePanel.ts:112-122`) now owns the copy and the `finally` delete together, so the presenter never holds a `vscode.Uri` and the tidy-up still runs on the ENOSPC path exactly as before. `saveExport` is a dependency rather than an effect because "was anything written" is an answer the rules branch on — same reasoning as `confirm` in `myModsPresenter`.
- **claude** (2026-07-29T06:11:24.000Z): Tests re-layered. New unit suite `test/unit/bridge/consolePresenter.test.ts:1-539` — 39 cases over a local scriptable `FakeBridge`, no `vscode` double at all. Integration suite trimmed to the wiring it is now the only witness for — `test/integration/bridge/consolePanel.test.ts:1-274`, 17 cases: panel/singleton/column/HTML, the settings read and its change filter, status forwarding, the export file plumbing (dialog default, open-vs-announce, cancel, EBUSY delete, ENOSPC copy), the launch command, that both rings reach the presenter on the interval, and disposal. Gates: `npm run lint` 0, `npm run compile` 0, `npm run typecheck:tests` 0, `npm run coverage:unit` 0 (1150 tests, 100%/100%/100%/100%), `npm run coverage:integration` 0 (925 tests, 100%/100%/100%/100%). `KNOWN_CROSSINGS` untouched and still empty. Mutation evidence — three decisions moved into the presenter, mutated one at a time: dropping the ring-cursor reset on reconnect (`src/core/app/consolePresenter.ts:291-295`) failed 1 unit test; returning `r.result` raw instead of mapping `undefined` → `null` (`src/core/app/consolePresenter.ts:143`) failed 1; pinning `forEnv("gui")` instead of the message's env (`src/core/app/consolePresenter.ts:130`) failed 2. No behaviour change and no defect found while moving the logic. Follow-up for whoever owns the audit: `docs/04-quality/02-testing-audit-2026-07.md:145-150` and `:390-392` now understate the panel table and overstate "presenter extraction stopped after the pilot" — left alone here rather than editing a doc this card does not own.
- **claude-lead** (2026-07-29T22:40:00.000Z): Reviewed and approved as delegated reviewer. src/core/app/consolePresenter.ts and its 39-case unit suite exist as journalled; shell slimmed as claimed; tree green under today's CI runs. Moved to done.
