---
column: backlog
labels: [extension, webview]
priority: med
updatedAt: 2026-07-29T05:22:16.000Z
---
# Extract the panel singleton scaffold

The remaining half of the DRY finding at `src/webview/html.ts:10-16`, scored 0.6
and tracked as #51.

The document boilerplate is shared — `renderWebviewHtml` and `mediaUri` live in
`src/webview/html.ts` — but the singleton scaffold around it is not. Nine panels
each hand-write the same `static current`, `static show`, `panel`, `disposables`,
`onDidDispose -> dispose`, `dispose() { current = undefined; … }` block. The
comment records that they have **already diverged in teardown detail**, and each
divergence needs its own test.

The asset-list half of #51 is closed
(`test/integration/webview/previewAssets.test.ts`), and the capabilities half
lands with PR #67 (card 01) as `webviewCapabilities()`.

PR #67's own writeup warns against a base class, per #51's terms: each panel's
reveal does something different. Whatever shape this takes has to leave that
free.

## Checklist

- [ ] Enumerate the nine panels and diff their teardown blocks
- [ ] Pick a shape that shares lifecycle without constraining `reveal`
- [ ] Keep every panel at 100% under the integration gate
- [ ] Remove the TODO at `src/webview/html.ts:10`
