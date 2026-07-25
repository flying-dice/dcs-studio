import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type FakeWebviewPanel,
  fireAuthSessionsChanged,
  resetVscode,
  state,
  vscodeMock,
} from "../support/vscode";

vi.mock("vscode", () => vscodeMock());

import * as vscode from "vscode";
import type { SubscriptionService } from "../../../src/core/app/subscriptionService";
import type { AuthPort } from "../../../src/core/ports/auth";
import type { MarketplacePort } from "../../../src/core/ports/marketplace";
import { MarketplacePanel } from "../../../src/marketplace/panel";

// The panel shell around MarketplacePresenter: window plumbing, the webview
// document, and performing the effects the presenter describes. The decisions
// themselves are unit-tested against the presenter — what is asserted here is
// that each described effect reaches the right VS Code API, which is the part
// no pure test can see.

const EXTENSION_URI = { fsPath: "C:\\ext" };

function context(): vscode.ExtensionContext {
  return {
    extensionUri: vscode.Uri.file(EXTENSION_URI.fsPath),
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
}

const subs = {
  install: async () => {},
  unsubscribe: async () => {},
  fetchPlan: async () => null,
  isSubscribed: async () => false,
} as unknown as SubscriptionService;

const market: MarketplacePort = {
  discover: async () => [],
  loadProduct: async () =>
    ({
      repo: "Owner/Repo",
      name: "My Mod",
      assets: [],
      release_tag: "v1",
    }) as never,
};

const auth: AuthPort = {
  getToken: async () => undefined,
  onDidChangeSessions: () => ({ dispose: () => {} }),
  currentSession: async () => undefined,
  signIn: async () => undefined,
};

function show(): FakeWebviewPanel {
  MarketplacePanel.show(context(), subs, market, auth);
  return state.panels[state.panels.length - 1];
}

beforeEach(() => {
  resetVscode({
    extensions: {
      "flying-dice.dcs-studio": {
        packageJSON: { version: "0.16.0", bugs: { url: "https://github.com/o/r/issues" } },
      },
    },
  });
  MarketplacePanel.current = undefined;
});

describe("panel lifecycle", () => {
  it("creates a scripts-enabled webview scoped to the media folder", () => {
    const panel = show();
    expect(panel.viewType).toBe("dcsStudio.marketplace");
    expect(panel.title).toBe("DCS Marketplace");
    expect(MarketplacePanel.current).toBeDefined();
  });

  it("reveals the existing panel instead of opening a second one", () => {
    show();
    MarketplacePanel.show(context(), subs, market, auth);
    // Two storefronts would each hold their own token and product cache.
    expect(state.panels).toHaveLength(1);
  });

  it("renders a nonce-locked document that loads the marketplace assets", () => {
    const panel = show();
    expect(panel.webview.html).toContain("marketplace.js");
    expect(panel.webview.html).toContain("marketplace.css");
    expect(panel.webview.html).toContain("Content-Security-Policy");
    // default-src 'none' plus a per-render nonce is what keeps a compromised
    // README's markup from executing in the webview.
    expect(panel.webview.html).toContain("default-src 'none'");
    expect(panel.webview.html).toMatch(/nonce-[A-Za-z0-9]+/);
  });

  it("clears the singleton when the panel is disposed", () => {
    const panel = show();
    panel.dispose();
    expect(MarketplacePanel.current).toBeUndefined();
  });

  it("re-opens after disposal", () => {
    show().dispose();
    show();
    expect(state.panels).toHaveLength(2);
    expect(MarketplacePanel.current).toBeDefined();
  });
});

describe("effects reach the editor", () => {
  it("opens an external url through the editor", async () => {
    const panel = show();
    await panel.webview.receive({ type: "openExternal", url: "https://github.com/o/r" });
    expect(state.openedExternal).toEqual(["https://github.com/o/r"]);
  });

  it("routes the docs link through the docs command", async () => {
    const panel = show();
    await panel.webview.receive({ type: "openDocs", page: "sandbox" });
    expect(state.executedCommands).toEqual([{ command: "dcs.docs.open", args: ["sandbox"] }]);
  });

  it("shows an information toast on a successful uninstall", async () => {
    const panel = show();
    await panel.webview.receive({ type: "uninstall", repo: "Owner/Repo" });
    expect(state.info).toEqual(["Uninstalled Owner/Repo."]);
  });

  it("routes an install failure through the Report Issue error path", async () => {
    const failing = {
      ...subs,
      install: async () => {
        throw new Error("disk full");
      },
    } as unknown as SubscriptionService;
    MarketplacePanel.show(context(), failing, market, auth);
    const panel = state.panels[state.panels.length - 1];

    // Cache the product first — install only acts on an opened product.
    await panel.webview.receive({ type: "openProduct", repo: "Owner/Repo" });
    await panel.webview.receive({ type: "install", repo: "Owner/Repo" });

    expect(state.errors).toEqual(["Install failed: disk full"]);
    expect(panel.webview.postedOfType("installError")[0]).toMatchObject({ message: "disk full" });
  });
});

describe("host state pushed to the webview", () => {
  it("answers the boot handshake with auth state", async () => {
    const panel = show();
    await panel.webview.receive({ type: "ready" });
    expect(panel.webview.postedOfType("auth")[0]).toMatchObject({
      signedIn: false,
      topic: "dcs-studio",
    });
  });

  it("uses the configured discovery topic when one is set", async () => {
    state.config["dcsStudio.discoveryTopic"] = "  my-fork  ";
    const panel = show();
    await panel.webview.receive({ type: "ready" });
    expect(panel.webview.postedOfType("auth")[0]).toMatchObject({ topic: "my-fork" });
  });

  it("re-runs auth when the user signs in to GitHub elsewhere in VS Code", async () => {
    const panel = show();
    panel.webview.posted.length = 0;

    fireAuthSessionsChanged("github");
    await Promise.resolve();
    expect(panel.webview.postedOfType("auth")).toHaveLength(1);
  });

  it("ignores session changes from other auth providers", async () => {
    const panel = show();
    panel.webview.posted.length = 0;

    // A Microsoft/other provider signing in says nothing about GitHub access;
    // reacting would re-run discovery on unrelated activity.
    fireAuthSessionsChanged("microsoft");
    await Promise.resolve();
    expect(panel.webview.postedOfType("auth")).toHaveLength(0);
  });

  it("refresh() forces a discovery pass", async () => {
    show();
    MarketplacePanel.current?.refresh();
    await Promise.resolve();
    const panel = state.panels[0];
    expect(panel.webview.postedOfType("listings")[0]).toMatchObject({ force: true });
  });
});
