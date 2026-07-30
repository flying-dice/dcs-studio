import type { DocsBootstrap, DocsHostMessage, DocsWebviewMessage } from "./webviewContract";

// The Documentation panel's decision logic, lifted out of the VS Code panel.
//
// This is the smallest presenter in the rollout, and the reason is worth saying
// out loud rather than leaving as an absence: the docs panel has no state. Its
// content is a static script (`media/docs-content.js`) the WEBVIEW owns, its
// navigation is the webview's own, and the host is only ever asked to do two
// things to the world — run an extension command, or open a URL.
//
// What is left over once that is said is still decision logic, and all of it is
// here:
//
//  - the DEEP-LINK RULE, which is the panel's one genuine rule and lives in two
//    halves that must agree. Opening the panel puts the requested page in the
//    document (`bootstrap`); revealing a panel that is already open sends it as
//    a message (`navigate`) — and only when a page was actually named, because a
//    plain "open the docs" must not yank a reader off the page they are on;
//  - the two payload guards. A `run` with no command and an `openExternal` with
//    no url are what a stale or crafted post looks like, and both are dropped.
//
// What stays in the shell (`src/docs/docsPanel.ts`) is the panel, the singleton
// slot, the rendered document, `vscode.commands.executeCommand` and the
// `openExternal` helper.

/**
 * The message shapes the docs webview sends the host — the declared contract,
 * not a local restatement of it.
 */
export type DocsInbound = DocsWebviewMessage;

/**
 * Something the docs panel asks the world to do. Both members leave the pure
 * layer through the shell, the same treatment card 08 gave `launchBridge`.
 */
export type DocsEffect =
  /** Run an extension command a docs page's "try it" button names. */
  | { kind: "runCommand"; command: string }
  /** Open a link in the user's browser. */
  | { kind: "openExternal"; url: string };

export interface DocsPresenterDeps {
  /**
   * Deliver a message to the webview. Typed to the declared host union, so a
   * message `media/docs.js` has no case for cannot be sent from here without the
   * contract being updated first.
   */
  post: (msg: DocsHostMessage) => void;
  effect: (e: DocsEffect) => void;
}

export class DocsPresenter {
  constructor(private readonly deps: DocsPresenterDeps) {}

  /**
   * The page the document should open on.
   *
   * Not a message, for the same reason the manifest form's bootstrap is not one:
   * `media/docs.js` reads `window.__INITIAL_PAGE__` synchronously at the top of
   * its IIFE, so this crosses inside the DOCUMENT the host renders. A panel being
   * opened therefore cannot lose its deep link to the load race the way publish
   * (card 22) and New Project (card 23) can lose their opening push.
   *
   * `""` rather than `undefined` when no page was named: the shell injects this
   * as `JSON.stringify(...)` into an inline script, and `JSON.stringify(undefined)`
   * is not a string at all — it would render the literal token `undefined` into
   * the document. `""` is the value the webview's own "is this a real page id"
   * test is written against.
   */
  bootstrap(page?: string): DocsBootstrap {
    return { page: page ?? "" };
  }

  /**
   * Navigate an ALREADY OPEN panel, which is what revealing the docs a second
   * time means.
   *
   * The absent page is the interesting case and it is deliberately a no-op: the
   * docs panel is a singleton a user leaves open and reads, so "open the
   * documentation" with nothing named must reveal it where they left it. Only a
   * command that names a page (`dcs.docs.open` with an argument — the Learn-more
   * buttons in My Mods and the marketplace) may move them.
   */
  navigate(page?: string): void {
    if (!page) return;
    this.deps.post({ type: "goto", page });
  }

  handle(msg: DocsInbound): void {
    switch (msg.type) {
      case "run":
        if (msg.command) this.deps.effect({ kind: "runCommand", command: msg.command });
        break;
      case "openExternal":
        if (msg.url) this.deps.effect({ kind: "openExternal", url: msg.url });
        break;
    }
  }
}
