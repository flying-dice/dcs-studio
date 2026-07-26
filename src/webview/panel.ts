import * as vscode from "vscode";

// Creating a webview panel the way this extension creates them.
//
// Ten panels hand-wrote the same three things (#51): the column to open in, an
// identical options object, and the icon. The options object is the one that
// matters — `enableScripts` plus `localResourceRoots` is a security decision
// about what a webview may run and where it may read from, and a decision made
// in ten places is a decision that can drift in nine of them.
//
// Deliberately NOT a base class. Each panel's `static current` + reveal does
// something different on reveal — the docs panel navigates to a page, the
// manifest form is keyed per document, the console replays its buffer — and
// forcing that into one inherited shape is the abstraction the audit warned
// about. What is shared here is the part that is genuinely identical.

/**
 * Where a panel opens: beside whatever the user is looking at, or the first
 * column when no editor is open.
 */
export function activeColumn(): vscode.ViewColumn {
  return vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
}

/**
 * What every webview in this extension may do, panel or view.
 *
 * - `enableScripts` — these are applications, not documents.
 * - `localResourceRoots` — `media/` and nothing else. This is the restriction
 *   that stops a webview reading the user's disk through a crafted URI.
 *
 * Separate from `createPanel` because the sidebar is a `WebviewView`, not a
 * panel: it takes plain `WebviewOptions` with no home for
 * `retainContextWhenHidden`, so it cannot call `createPanel` — and it was
 * therefore left setting its own copy of exactly this pair. That made the
 * sidebar the one webview whose capabilities could still drift silently, and
 * it is the worst one to miss: panels are opened on demand and closed, while
 * the nav is registered at activation and lives for the whole session.
 *
 * The security decision is this pair. It is stated here, once, and both
 * surfaces take it from here.
 */
export function webviewCapabilities(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
  };
}

/**
 * A webview panel with this extension's standard capabilities and its icon.
 *
 * Adds `retainContextWhenHidden` to [`webviewCapabilities`]: panels hold live
 * state (a console buffer, a half-filled form, a running install) that a
 * re-render would lose.
 *
 * `showOptions` takes a column or the full `{ viewColumn, preserveFocus }`
 * form, because the manifest form opens beside its document without stealing
 * the caret. Required rather than defaulting to `activeColumn()`: every caller
 * passes it, so the default would be an unexercised second way to do this — the
 * same shape as the `nodeScheduler` and `WsBridgeTransport` defaults removed in
 * #61, both of which were wrong by the time anyone looked.
 */
export function createPanel(
  context: vscode.ExtensionContext,
  viewType: string,
  title: string,
  showOptions: vscode.ViewColumn | { viewColumn: vscode.ViewColumn; preserveFocus?: boolean },
): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(viewType, title, showOptions, {
    ...webviewCapabilities(context.extensionUri),
    retainContextWhenHidden: true,
  });
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.png");
  return panel;
}
