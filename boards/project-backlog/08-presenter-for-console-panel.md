---
column: backlog
labels: [extension, webview, tests]
priority: med
updatedAt: 2026-07-29T05:22:16.000Z
---
# Extract a presenter for the console panel

Listed under "What is deliberately not done" in
`docs/04-quality/01-testing-audit.md:390-392`: presenter extraction stopped after
the marketplace pilot, and `src/bridge/consolePanel.ts` "still carries enough
decision logic to deserve it".

The pilot is the worked example — `src/core/app/marketplacePresenter.ts` took 255
lines of panel down to a 129-line VS Code shell plus a presenter that knows
nothing about the editor and describes side effects as values
(`MarketplaceEffect`). `src/core/app/myModsPresenter.ts` followed in the
clean-code round (#40).

`consolePanel.ts` was measured at 309 lines with 22 `vscode.` references — 7%
coupling — in the audit's panel table (`docs/04-quality/01-testing-audit.md:145-150`).

This is a quality move, not a coverage one: the panel is already at 100% under
the integration gate. What it buys is moving that logic under the unit gate,
where it can be tested without the `vscode` double at all.

## Checklist

- [ ] Define the console presenter's state and message types
- [ ] Move the decision logic out of `src/bridge/consolePanel.ts`
- [ ] Cover the presenter under the unit layer; keep the shell at 100% under integration
