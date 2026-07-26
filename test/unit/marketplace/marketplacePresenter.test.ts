import { beforeEach, describe, expect, it } from "vitest";
import {
  type MarketplaceEffect,
  MarketplacePresenter,
  type MarketplacePresenterDeps,
} from "../../../src/core/app/marketplacePresenter";
import type { MarketListing, ProductDetail } from "../../../src/core/domain/types";
import type { AuthSession } from "../../../src/core/ports/auth";

// The storefront's host-side behaviour, tested without VS Code: the sign-in
// state machine, the product cache that install reads from, and the mapping
// from a thrown error to what the user actually sees.

function product(over: Partial<ProductDetail> = {}): ProductDetail {
  return {
    repo: "Owner/Repo",
    name: "My Mod",
    author: "Owner",
    description: "",
    repo_url: "https://github.com/Owner/Repo",
    avatar_url: "https://avatars.githubusercontent.com/Owner",
    stars: 0,
    readme: null,
    release_tag: "v1.0.0",
    release_url: "https://github.com/Owner/Repo/releases/tag/v1.0.0",
    release_date: "2026-01-02T03:04:05Z",
    assets: [{ name: "dcs-studio.toml", size: 10, url: "https://x/toml" }],
    download_size: 10,
    installable: true,
    installs: [],
    requires: [],
    ...over,
  };
}

interface Harness {
  presenter: MarketplacePresenter;
  posted: Record<string, unknown>[];
  effects: MarketplaceEffect[];
  calls: string[];
  deps: MarketplacePresenterDeps;
}

function harness(over: Partial<MarketplacePresenterDeps> = {}): Harness {
  const posted: Record<string, unknown>[] = [];
  const effects: MarketplaceEffect[] = [];
  const calls: string[] = [];

  const deps: MarketplacePresenterDeps = {
    subs: {
      install: async (_t, _tok, onProgress) => {
        calls.push("install");
        onProgress({ phase: "download", label: "Downloading…", pct: 42 });
      },
      unsubscribe: async () => {
        calls.push("unsubscribe");
      },
      fetchPlan: async () => null,
      isSubscribed: async () => false,
    } as MarketplacePresenterDeps["subs"],
    market: {
      discover: async () => [] as MarketListing[],
      loadProduct: async () => product(),
    },
    auth: {
      getToken: async () => undefined,
      onDidChangeSessions: () => ({ dispose: () => {} }),
      currentSession: async () => undefined,
      signIn: async () => undefined,
    },
    topic: () => "dcs-studio",
    post: (msg) => posted.push(msg as Record<string, unknown>),
    effect: (e) => effects.push(e),
    ...over,
  };

  return { presenter: new MarketplacePresenter(deps), posted, effects, calls, deps };
}

const session: AuthSession = { token: "tok", accountLabel: "pilot" };
const typed = (posted: Record<string, unknown>[], type: string) =>
  posted.filter((m) => m.type === type);

describe("auth state machine", () => {
  it("reports signed-out on ready and does not discover", async () => {
    const h = harness();
    await h.presenter.handle({ type: "ready" });

    expect(typed(h.posted, "auth")[0]).toEqual({
      type: "auth",
      signedIn: false,
      browsing: false,
      login: undefined,
      topic: "dcs-studio",
    });
    // Nothing is fetched until the user signs in or opts to browse — an
    // anonymous discover burns the shared rate limit.
    expect(typed(h.posted, "listings:busy")).toHaveLength(0);
  });

  it("reports the login and auto-discovers when a session exists", async () => {
    const h = harness({
      auth: { ...harness().deps.auth, currentSession: async () => session },
    });
    await h.presenter.handle({ type: "ready" });

    expect(typed(h.posted, "auth")[0]).toMatchObject({ signedIn: true, login: "pilot" });
    expect(typed(h.posted, "listings")).toHaveLength(1);
  });

  it("signing in adopts the session, clears browsing and re-runs auth", async () => {
    const base = harness().deps;
    const h = harness({
      auth: { ...base.auth, signIn: async () => session, currentSession: async () => session },
    });

    await h.presenter.handle({ type: "browseAnon" });
    expect(typed(h.posted, "auth")[0]).toMatchObject({ browsing: true, signedIn: false });

    await h.presenter.handle({ type: "signIn" });
    // Signing in supersedes the anonymous choice rather than stacking with it.
    expect(typed(h.posted, "auth").at(-1)).toMatchObject({ signedIn: true, browsing: false });
  });

  it("a declined sign-in leaves the user signed out, not stuck", async () => {
    const h = harness();
    await h.presenter.handle({ type: "signIn" });
    expect(typed(h.posted, "auth").at(-1)).toMatchObject({ signedIn: false });
  });

  it("browsing anonymously announces the state before discovering", async () => {
    const h = harness();
    await h.presenter.handle({ type: "browseAnon" });
    // Order matters: the webview swaps out the sign-in gate on the auth
    // message, so a listings payload arriving first would render behind it.
    expect(h.posted.map((m) => m.type)).toEqual(["auth", "listings:busy", "listings"]);
  });

  it("keeps browsing across a later refreshAuth", async () => {
    const h = harness();
    await h.presenter.handle({ type: "browseAnon" });
    h.posted.length = 0;
    await h.presenter.refreshAuth();
    expect(typed(h.posted, "auth")[0]).toMatchObject({ browsing: true });
    expect(typed(h.posted, "listings")).toHaveLength(1);
  });

  it("reads the topic fresh on every push, so a settings change takes effect", async () => {
    let topic = "dcs-studio";
    const h = harness({ topic: () => topic });
    await h.presenter.handle({ type: "ready" });
    topic = "my-fork";
    await h.presenter.handle({ type: "ready" });
    expect(typed(h.posted, "auth").at(-1)).toMatchObject({ topic: "my-fork" });
  });
});

describe("discovery", () => {
  it("brackets the fetch with a busy message and carries the force flag", async () => {
    const listings = [{ repo: "a/b" }] as unknown as MarketListing[];
    const h = harness({ market: { ...harness().deps.market, discover: async () => listings } });

    await h.presenter.discover(true);
    expect(h.posted).toEqual([
      { type: "listings:busy" },
      { type: "listings", listings, force: true },
    ]);
  });

  it("passes the force flag through from the webview message", async () => {
    const h = harness();
    await h.presenter.handle({ type: "discover", force: true });
    expect(typed(h.posted, "listings")[0]).toMatchObject({ force: true });

    await h.presenter.handle({ type: "discover" });
    // Absent means false, not undefined — the webview branches on it.
    expect(typed(h.posted, "listings")[1]).toMatchObject({ force: false });
  });

  it("surfaces a discovery failure as an error message, not a hang", async () => {
    const h = harness({
      market: {
        ...harness().deps.market,
        discover: async () => {
          throw new Error("rate limited");
        },
      },
    });
    await h.presenter.discover(false);
    expect(typed(h.posted, "listings:error")[0]).toMatchObject({ message: "rate limited" });
  });

  it("renders a non-Error rejection as a string", async () => {
    const h = harness({
      market: {
        ...harness().deps.market,
        discover: async () => {
          throw "boom";
        },
      },
    });
    await h.presenter.discover(false);
    expect(typed(h.posted, "listings:error")[0]).toMatchObject({ message: "boom" });
  });
});

describe("product page", () => {
  it("posts the product with its derived manifest view and required modules", async () => {
    const plan = {
      requires: [{ id: "WWII" }],
      bundles: [{ path: "Scripts" }],
      symlinks: [{ source: "Scripts", dest: "{SavedGames}/Scripts", resolved: null }],
      entrypoints: [],
      missionScripts: [],
    };
    const h = harness({
      subs: {
        ...harness().deps.subs,
        fetchPlan: async () => plan as never,
        isSubscribed: async () => true,
      },
    });

    await h.presenter.handle({ type: "openProduct", repo: "Owner/Repo" });
    const posted = typed(h.posted, "product")[0];
    expect(posted).toMatchObject({ requires: plan.requires, installed: true });
    expect(posted.manifest).toBeDefined();
  });

  it("still renders the product when the plan cannot be fetched", async () => {
    // A missing or unreadable manifest must degrade to "install actions
    // unknown", never block the page or look like a load failure.
    const h = harness({
      subs: {
        ...harness().deps.subs,
        fetchPlan: async () => {
          throw new Error("404");
        },
      },
    });
    await h.presenter.handle({ type: "openProduct", repo: "Owner/Repo" });

    expect(typed(h.posted, "product")).toHaveLength(1);
    expect(typed(h.posted, "product")[0]).toMatchObject({ requires: [] });
    expect(typed(h.posted, "product:error")).toHaveLength(0);
  });

  it("reports a product load failure against the requested repo", async () => {
    const h = harness({
      market: {
        ...harness().deps.market,
        loadProduct: async () => {
          throw new Error("no such repo");
        },
      },
    });
    await h.presenter.handle({ type: "openProduct", repo: "Owner/Missing" });
    expect(typed(h.posted, "product:error")[0]).toEqual({
      type: "product:error",
      repo: "Owner/Missing",
      message: "no such repo",
    });
  });

  it("renders a non-Error product failure as a string", async () => {
    const h = harness({
      market: {
        ...harness().deps.market,
        loadProduct: async () => {
          throw "nope";
        },
      },
    });
    await h.presenter.handle({ type: "openProduct", repo: "Owner/Repo" });
    expect(typed(h.posted, "product:error")[0]).toMatchObject({ message: "nope" });
  });

  it("ignores an openProduct with no repo", async () => {
    const h = harness();
    await h.presenter.handle({ type: "openProduct" });
    expect(h.posted).toEqual([]);
  });

  it("carries the escaping paths in the posted manifest view (issue #16)", async () => {
    const h = harness({
      subs: {
        ...harness().deps.subs,
        fetchPlan: async () =>
          ({
            requires: [],
            bundles: [],
            symlinks: [{ source: "p", dest: "{SavedGames}/../../evil", resolved: null }],
            entrypoints: [],
            missionScripts: [],
          }) as never,
      },
    });
    await h.presenter.handle({ type: "openProduct", repo: "Owner/Repo" });
    const manifest = typed(h.posted, "product")[0].manifest as { unsafePaths: unknown[] };
    expect(manifest.unsafePaths).toHaveLength(1);
  });
});

describe("install", () => {
  beforeEach(() => {});

  async function withCachedProduct(over: Partial<MarketplacePresenterDeps> = {}) {
    const h = harness(over);
    await h.presenter.handle({ type: "openProduct", repo: "Owner/Repo" });
    h.posted.length = 0;
    return h;
  }

  it("installs the cached product and reports progress then success", async () => {
    const h = await withCachedProduct();
    await h.presenter.handle({ type: "install", repo: "Owner/Repo" });

    expect(h.calls).toContain("install");
    // A starting frame first, so the button leaves its idle state immediately
    // rather than after the first real progress callback.
    expect(typed(h.posted, "installProgress")[0]).toMatchObject({ pct: 0, phase: "download" });
    expect(typed(h.posted, "installProgress")[1]).toMatchObject({ pct: 42 });
    expect(typed(h.posted, "installed")[0]).toMatchObject({ repo: "Owner/Repo" });
    expect(h.effects).toEqual([
      { kind: "info", message: "Installed My Mod into your DCS folders." },
    ]);
  });

  it("matches the cached product case-insensitively", async () => {
    const h = await withCachedProduct();
    await h.presenter.handle({ type: "install", repo: "owner/repo" });
    expect(h.calls).toContain("install");
  });

  it("does nothing for a repo that was never opened", async () => {
    // Install works off the cache; installing a half-known descriptor would
    // download against a repo the presenter has no assets for.
    const h = harness();
    await h.presenter.handle({ type: "install", repo: "Owner/Unknown" });
    expect(h.posted).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it("refuses a product with no release, with a reason", async () => {
    const h = await withCachedProduct({
      market: {
        ...harness().deps.market,
        loadProduct: async () => product({ release_tag: null, installable: false }),
      },
    });
    await h.presenter.handle({ type: "install", repo: "Owner/Repo" });

    expect(typed(h.posted, "installError")[0]).toMatchObject({
      message: "This mod has no release to install.",
    });
    expect(h.calls).toEqual([]);
  });

  it("reports a failed install both inline and as a toast", async () => {
    const base = harness().deps;
    const h = await withCachedProduct({
      subs: {
        ...base.subs,
        install: async () => {
          throw new Error("disk full");
        },
      },
    });
    await h.presenter.handle({ type: "install", repo: "Owner/Repo" });

    // Inline for the card, toast because the card may be scrolled out of view
    // by the time a long install fails.
    expect(typed(h.posted, "installError")[0]).toMatchObject({ message: "disk full" });
    expect(h.effects).toEqual([
      { kind: "installFailed", message: "Install failed: disk full", cause: expect.any(Error) },
    ]);
  });

  it("ignores an install with no repo", async () => {
    const h = harness();
    await h.presenter.handle({ type: "install" });
    expect(h.posted).toEqual([]);
  });

  // Issue #16: the page hides the install action for these, but the message can
  // still arrive from a page rendered before the manifest was re-read. The
  // refusal has to be enforced here, before anything is downloaded.
  it("refuses to install a mod whose manifest reaches outside the DCS folders", async () => {
    const base = harness().deps;
    const h = await withCachedProduct({
      subs: {
        ...base.subs,
        fetchPlan: async () =>
          ({
            requires: [],
            bundles: [],
            symlinks: [
              { source: "p", dest: "{SavedGames}/../../Windows/System32", resolved: null },
            ],
            entrypoints: [],
            missionScripts: [],
          }) as never,
      },
    });
    await h.presenter.handle({ type: "install", repo: "Owner/Repo" });

    expect(typed(h.posted, "installError")[0]).toMatchObject({
      message:
        "This mod's manifest asks to write outside your DCS folders. " +
        'Link destination "{SavedGames}/../../Windows/System32" reaches outside the configured DCS folders.',
    });
    expect(typed(h.posted, "installProgress")).toEqual([]);
    expect(typed(h.posted, "installed")).toEqual([]);
  });

  it("clears an earlier refusal when the product is re-opened with a clean manifest", async () => {
    // The refusal is per-load, not sticky: a mod that fixes its manifest in a
    // new release must become installable again without restarting the editor.
    let hostile = true;
    const h = await withCachedProduct({
      subs: {
        ...harness().deps.subs,
        fetchPlan: async () =>
          ({
            requires: [],
            bundles: [],
            symlinks: [
              { source: "p", dest: hostile ? "{SavedGames}/../evil" : "{SavedGames}/Scripts/x" },
            ],
            entrypoints: [],
            missionScripts: [],
          }) as never,
      },
    });
    await h.presenter.handle({ type: "install", repo: "Owner/Repo" });
    expect(typed(h.posted, "installed")).toEqual([]);

    hostile = false;
    await h.presenter.handle({ type: "openProduct", repo: "Owner/Repo" });
    await h.presenter.handle({ type: "install", repo: "Owner/Repo" });
    expect(typed(h.posted, "installed")).toHaveLength(1);
  });
});

describe("uninstall", () => {
  it("confirms an uninstall to both the card and the user", async () => {
    const h = harness();
    await h.presenter.handle({ type: "uninstall", repo: "Owner/Repo" });

    expect(h.calls).toEqual(["unsubscribe"]);
    expect(typed(h.posted, "uninstalled")[0]).toMatchObject({ repo: "Owner/Repo" });
    expect(h.effects).toEqual([{ kind: "info", message: "Uninstalled Owner/Repo." }]);
  });

  it("reports a failed uninstall inline without a toast", async () => {
    const base = harness().deps;
    const h = harness({
      subs: {
        ...base.subs,
        unsubscribe: async () => {
          throw new Error("file locked");
        },
      },
    });
    await h.presenter.handle({ type: "uninstall", repo: "Owner/Repo" });

    expect(typed(h.posted, "installError")[0]).toMatchObject({ message: "file locked" });
    expect(h.effects).toEqual([]);
  });

  it("ignores an uninstall with no repo", async () => {
    const h = harness();
    await h.presenter.handle({ type: "uninstall" });
    expect(h.posted).toEqual([]);
  });
});

describe("editor effects", () => {
  it("describes an external open rather than performing it", async () => {
    const h = harness();
    await h.presenter.handle({ type: "openExternal", url: "https://github.com/o/r" });
    expect(h.effects).toEqual([{ kind: "openExternal", url: "https://github.com/o/r" }]);
  });

  it("ignores an openExternal with no url", async () => {
    const h = harness();
    await h.presenter.handle({ type: "openExternal" });
    expect(h.effects).toEqual([]);
  });

  it("routes the docs link to the named page, defaulting to the sandbox explainer", async () => {
    const h = harness();
    await h.presenter.handle({ type: "openDocs", page: "manifest" });
    await h.presenter.handle({ type: "openDocs" });
    expect(h.effects).toEqual([
      { kind: "openDocs", page: "manifest" },
      { kind: "openDocs", page: "sandbox" },
    ]);
  });

  it("ignores an unknown message type", async () => {
    const h = harness();
    await h.presenter.handle({ type: "somethingElse" });
    expect(h.posted).toEqual([]);
    expect(h.effects).toEqual([]);
  });
});
