import { describe, expect, it } from "vitest";
import type { DocsEffect, DocsInbound } from "../../../src/core/app/docsPresenter";
import { DocsPresenter } from "../../../src/core/app/docsPresenter";
import type { DocsHostMessage } from "../../../src/core/app/webviewContract";

// The docs panel's decision logic, with no `vscode` anywhere — not even a double.
//
// This is the smallest presenter in the rollout and the suite says why in the
// only way that matters: every case below is a rule the OLD panel had, and there
// is nothing here that the panel did not decide. The panel's content, its TOC and
// its per-page rendering are the webview's own (`media/docs.js` over
// `media/docs-content.js`), driven in Chromium by `tests/docs.spec.ts`.

interface Harness {
  presenter: DocsPresenter;
  posted: DocsHostMessage[];
  effects: DocsEffect[];
}

function harness(): Harness {
  const posted: DocsHostMessage[] = [];
  const effects: DocsEffect[] = [];
  return {
    presenter: new DocsPresenter({
      post: (msg) => posted.push(msg),
      effect: (e) => effects.push(e),
    }),
    posted,
    effects,
  };
}

describe("DocsPresenter — the opening deep link", () => {
  it("opens on the page the command named", () => {
    expect(harness().presenter.bootstrap("sandbox")).toEqual({ page: "sandbox" });
  });

  it("carries the empty string, not undefined, when no page was named", () => {
    // Load-bearing rather than cosmetic: the shell injects this through
    // JSON.stringify into an inline script, and JSON.stringify(undefined) is not
    // a string — it renders the literal token `undefined` into the document,
    // where the webview's page-id test then compares against a page called
    // "undefined". `""` is the value that test is written against.
    expect(harness().presenter.bootstrap()).toEqual({ page: "" });
    expect(JSON.stringify(harness().presenter.bootstrap().page)).toBe('""');
  });

  it("does not post anything to open a panel on a page", () => {
    // The whole point of the bootstrap: the deep link crosses inside the
    // document, so there is no opening push to be lost to the load race the way
    // publish (card 22) and New Project (card 23) can lose theirs.
    const h = harness();
    h.presenter.bootstrap("sandbox");
    expect(h.posted).toEqual([]);
  });
});

describe("DocsPresenter — revealing a panel that is already open", () => {
  it("navigates it to the page the command named", () => {
    const h = harness();
    h.presenter.navigate("manifest-reference");
    expect(h.posted).toEqual([{ type: "goto", page: "manifest-reference" }]);
  });

  it("leaves the reader where they were when no page was named", () => {
    // "Open the documentation" on an already-open panel must reveal it, not yank
    // the user off the page they are reading. This is the panel's one genuine
    // rule and the only reason `navigate` takes an optional.
    const h = harness();
    h.presenter.navigate();
    h.presenter.navigate("");
    expect(h.posted).toEqual([]);
  });

  it("navigates again to the same page rather than de-duplicating", () => {
    // The host does not know what page the webview is on — the webview navigates
    // itself from its TOC, its pager and its persisted state. A presenter that
    // suppressed a repeat `goto` would refuse to bring a user back to the page a
    // Learn-more button links to once they had browsed away from it.
    const h = harness();
    h.presenter.navigate("sandbox");
    h.presenter.navigate("sandbox");
    expect(h.posted).toEqual([
      { type: "goto", page: "sandbox" },
      { type: "goto", page: "sandbox" },
    ]);
  });
});

describe("DocsPresenter — what a docs page asks the host to do", () => {
  it("runs the command a page's try-it button names", () => {
    const h = harness();
    h.presenter.handle({ type: "run", command: "dcs.marketplace.open" });
    expect(h.effects).toEqual([{ kind: "runCommand", command: "dcs.marketplace.open" }]);
  });

  it("opens an https link from a page body", () => {
    const h = harness();
    h.presenter.handle({
      type: "openExternal",
      url: "https://www.digitalcombatsimulator.com/",
    });
    expect(h.effects).toEqual([
      { kind: "openExternal", url: "https://www.digitalcombatsimulator.com/" },
    ]);
  });

  it("drops a run with no command and a link with no url", () => {
    // What a stale or crafted post looks like. The union declares both fields
    // optional precisely so these guards are the thing that decides.
    const h = harness();
    h.presenter.handle({ type: "run" });
    h.presenter.handle({ type: "run", command: "" });
    h.presenter.handle({ type: "openExternal" });
    h.presenter.handle({ type: "openExternal", url: "" });
    expect(h.effects).toEqual([]);
    expect(h.posted).toEqual([]);
  });

  it("does nothing for a message type it does not declare", () => {
    const h = harness();
    h.presenter.handle({ type: "goto", page: "sandbox" } as unknown as DocsInbound);
    expect(h.effects).toEqual([]);
    expect(h.posted).toEqual([]);
  });
});
