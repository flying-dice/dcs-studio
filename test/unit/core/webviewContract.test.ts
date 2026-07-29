import { describe, expect, it } from "vitest";
import type {
  ConsoleBridge,
  ConsoleEffect,
  ConsoleExportSave,
  ConsoleInbound,
} from "../../../src/core/app/consolePresenter";
import { ConsolePresenter } from "../../../src/core/app/consolePresenter";
import type {
  MarketplaceEffect,
  MarketplaceInbound,
  MarketplacePresenterDeps,
} from "../../../src/core/app/marketplacePresenter";
import { MarketplacePresenter } from "../../../src/core/app/marketplacePresenter";
import type {
  ConsoleHostMessage,
  MarketplaceHostMessage,
} from "../../../src/core/app/webviewContract";
import {
  CONSOLE_PROTOCOL,
  MARKETPLACE_PROTOCOL,
  UNCOVERED_WEBVIEWS,
  WEBVIEW_PROTOCOLS,
} from "../../../src/core/app/webviewContract";
import type { DualBridgeStatus } from "../../../src/core/domain/bridgeProtocol";
import type { ProductDetail } from "../../../src/core/domain/types";

// The HOST half of the declared webview contract
// (`src/core/app/webviewContract.ts`), both directions, table-driven.
//
//   webview -> host : every declared message is ACTED ON by the presenter.
//   host -> webview : every declared message is PRODUCED by the presenter.
//
// The webview half — that `media/*.js` emits exactly the first set and consumes
// exactly the second — is observed in Chromium by tests/webviewContract.spec.ts.
// Neither half infers anything from source text; both drive real code and
// compare what happened against the one declaration.
//
// ## Why this test cannot pass against an empty table
//
// PR #67's lesson: the boundary check became complete and unfalsifiable in the
// same commit, because it asserted only an absence. Every assertion here is an
// equality between the declared set and a set produced by RUNNING the
// presenter, so emptying the table fails as loudly as breaking a handler:
//
//   - the drive plans below are exhaustive `Record`s over the message unions
//     (a missing key does not compile), and each is asserted key-for-key
//     against the protocol's `toHost` list, so removing one entry from either
//     side is a mismatch;
//   - the produced-message assertions are set equalities, so a declared message
//     the presenter never sends fails just as a sent message that was never
//     declared does;
//   - the negative controls prove "was acted on" can come back false, so the
//     positive results are not vacuous.

// ── Console harness ──────────────────────────────────────────────────────────

const CONNECTED = { connected: true, dcsTime: 0 };
const OFFLINE = { connected: false, dcsTime: null };
const STATUS: DualBridgeStatus = { gui: CONNECTED, mission: OFFLINE };

/** A bridge that answers everything successfully unless told to fail. */
class ContractBridge implements ConsoleBridge {
  current = { connected: true };
  readonly calls: string[] = [];
  /** When set, every RPC rejects — the path that produces the error replies. */
  failing = false;
  /** What `replEval` reports; `false` is the sim refusing the chunk. */
  evalOk = true;
  /** Lines the output ring hands back on the next poll. */
  lines: { seq: number; text: string }[] = [];

  async consoleRead(after: number) {
    this.calls.push("consoleRead");
    return { lines: this.lines, latest: after + this.lines.length };
  }
  replEval = this.rpc("replEval", () => ({ ok: this.evalOk, result: 1, err: "boom" }));
  replInspect = this.rpc("replInspect", () => ({ ok: true, type: "table", value: "table (1)" }));
  replExpand = this.rpc("replExpand", () => ({ variables: [] }));
  replSignature = this.rpc("replSignature", () => ({ ok: true, params: "a" }));
  replClear = this.rpc("replClear", () => ({}));
  replExport = this.rpc("replExport", () => ({ path: "/tmp/x.json", bytes: 1 }));

  private rpc(method: string, answer: () => unknown) {
    return async (...args: unknown[]): Promise<never> => {
      void args;
      this.calls.push(method);
      if (this.failing) throw new Error("bridge refused");
      return answer() as never;
    };
  }
}

interface ConsoleHarness {
  presenter: ConsolePresenter;
  bridge: ContractBridge;
  posted: ConsoleHostMessage[];
  effects: ConsoleEffect[];
  saves: ConsoleExportSave[];
  /** How many observable things the presenter did — the "was it handled" probe. */
  interactions(): number;
}

function consoleHarness(): ConsoleHarness {
  const bridge = new ContractBridge();
  const posted: ConsoleHostMessage[] = [];
  const effects: ConsoleEffect[] = [];
  const saves: ConsoleExportSave[] = [];
  const presenter = new ConsolePresenter({
    bridges: { forEnv: () => bridge, current: STATUS },
    tailed: [bridge],
    wildcardDepth: () => 1,
    post: (msg) => posted.push(msg),
    effect: (e) => effects.push(e),
    saveExport: async (request) => {
      saves.push(request);
      return true;
    },
  });
  return {
    presenter,
    bridge,
    posted,
    effects,
    saves,
    interactions: () => posted.length + effects.length + saves.length + bridge.calls.length,
  };
}

// ── Marketplace harness ──────────────────────────────────────────────────────

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
    assets: [],
    download_size: 0,
    installable: true,
    installs: [],
    requires: [],
    ...over,
  };
}

interface MarketplaceHarness {
  presenter: MarketplacePresenter;
  posted: MarketplaceHostMessage[];
  effects: MarketplaceEffect[];
  calls: string[];
  interactions(): number;
}

function marketplaceHarness(over: Partial<MarketplacePresenterDeps> = {}): MarketplaceHarness {
  const posted: MarketplaceHostMessage[] = [];
  const effects: MarketplaceEffect[] = [];
  const calls: string[] = [];
  const deps: MarketplacePresenterDeps = {
    subs: {
      install: async (_t, _tok, onProgress) => {
        calls.push("install");
        onProgress({ phase: "link", label: "Linking…", pct: 1 });
      },
      unsubscribe: async () => {
        calls.push("unsubscribe");
      },
      fetchPlan: async () => null,
      isSubscribed: async () => false,
    } as MarketplacePresenterDeps["subs"],
    market: {
      discover: async () => [],
      loadProduct: async () => product(),
    },
    auth: {
      getToken: async () => undefined,
      onDidChangeSessions: () => ({ dispose: () => {} }),
      currentSession: async () => undefined,
      signIn: async () => {
        calls.push("signIn");
        return undefined;
      },
    },
    topic: () => "dcs-studio",
    post: (msg) => posted.push(msg),
    effect: (e) => effects.push(e),
    ...over,
  };
  return {
    presenter: new MarketplacePresenter(deps),
    posted,
    effects,
    calls,
    interactions: () => posted.length + effects.length + calls.length,
  };
}

/** The message types a run of the presenter actually pushed, de-duplicated. */
function typesOf(posted: { type: string }[]): string[] {
  return [...new Set(posted.map((m) => m.type))].sort();
}

// ── Drive plans ──────────────────────────────────────────────────────────────

/**
 * One declared webview -> host message, and what it takes to make the host act
 * on it. `before` is the state the message needs to be meaningful at all — an
 * `install` for a product the user never opened is silently ignored by design,
 * so the plan opens it first and only counts what the `send` itself did.
 */
interface Drive<M> {
  before?: readonly M[];
  send: M;
}

// Exhaustive by construction: `Record<Union["type"], …>` will not compile with
// a key missing, so a message type added to the contract lands here as a type
// error rather than as a silently untested entry.
const CONSOLE_DRIVES: Record<ConsoleInbound["type"], Drive<ConsoleInbound>> = {
  ready: { send: { type: "ready" } },
  eval: { send: { type: "eval", code: "return 1" } },
  inspect: { send: { type: "inspect", expr: "_G", id: 1 } },
  expand: { send: { type: "expand", ref: 2, nodeId: 3 } },
  signature: { send: { type: "signature", ref: 2, reqId: 4 } },
  clearExplorer: { send: { type: "clearExplorer", envs: ["gui"] } },
  export: { send: { type: "export", ref: 2, label: "_G/db", reqId: 5 } },
  launch: { send: { type: "launch" } },
};

const MARKETPLACE_DRIVES: Record<MarketplaceInbound["type"], Drive<MarketplaceInbound>> = {
  ready: { send: { type: "ready" } },
  signIn: { send: { type: "signIn" } },
  browseAnon: { send: { type: "browseAnon" } },
  discover: { send: { type: "discover", force: true } },
  openProduct: { send: { type: "openProduct", repo: "Owner/Repo" } },
  openExternal: { send: { type: "openExternal", url: "https://github.com/Owner/Repo" } },
  openDocs: { send: { type: "openDocs", page: "sandbox" } },
  // Install acts on the cached product, so the page has to have been opened.
  install: {
    before: [{ type: "openProduct", repo: "Owner/Repo" }],
    send: { type: "install", repo: "Owner/Repo" },
  },
  uninstall: { send: { type: "uninstall", repo: "Owner/Repo" } },
};

// ── The contract table itself ────────────────────────────────────────────────

describe("the declared webview contract", () => {
  it("names a protocol for both presenter-backed panels and nothing else", () => {
    expect(Object.keys(WEBVIEW_PROTOCOLS).sort()).toEqual(["console", "marketplace"]);
  });

  it("declares a non-empty message set in both directions", () => {
    // Guards the guard: every assertion below is an equality against these
    // lists, and an equality against nothing is satisfied by nothing.
    for (const [name, p] of Object.entries(WEBVIEW_PROTOCOLS)) {
      expect(p.toHost.length, `${name}.toHost`).toBeGreaterThan(0);
      expect(p.toWebview.length, `${name}.toWebview`).toBeGreaterThan(0);
    }
  });

  it("only calls a message silent if it is one the host actually pushes", () => {
    for (const [name, p] of Object.entries(WEBVIEW_PROTOCOLS)) {
      for (const s of p.silent) expect(p.toWebview, `${name}.silent`).toContain(s);
    }
  });

  it("does not name a covered panel as uncovered", () => {
    for (const name of Object.keys(WEBVIEW_PROTOCOLS))
      expect(UNCOVERED_WEBVIEWS).not.toContain(name);
  });
});

// ── Console: the host half ───────────────────────────────────────────────────

describe("console — webview -> host", () => {
  it("drives exactly the declared message set", () => {
    expect(Object.keys(CONSOLE_DRIVES).sort()).toEqual([...CONSOLE_PROTOCOL.toHost].sort());
  });

  it.each(CONSOLE_PROTOCOL.toHost)("%s is acted on", async (type) => {
    const plan = CONSOLE_DRIVES[type as ConsoleInbound["type"]];
    const h = consoleHarness();
    for (const m of plan.before ?? []) await h.presenter.handle(m);
    const before = h.interactions();
    await h.presenter.handle(plan.send);
    expect(h.interactions()).toBeGreaterThan(before);
  });

  it("does nothing at all for a message type the contract does not declare", () => {
    // The negative control. Without it, "the presenter did something" could be
    // true for every input and the test above would prove nothing.
    const h = consoleHarness();
    void h.presenter.handle({ type: "notInTheContract" } as unknown as ConsoleInbound);
    expect(h.interactions()).toBe(0);
  });
});

describe("console — host -> webview", () => {
  it("produces exactly the declared message set", async () => {
    const h = consoleHarness();
    h.presenter.pushStatus(STATUS);
    h.presenter.pushConfig();
    await h.presenter.handle({ type: "eval", code: "return 1" });
    h.bridge.evalOk = false;
    await h.presenter.handle({ type: "eval", code: "boom" });
    await h.presenter.handle({ type: "inspect", expr: "_G", id: 1 });
    await h.presenter.handle({ type: "expand", ref: 2, nodeId: 3 });
    await h.presenter.handle({ type: "signature", ref: 2, reqId: 4 });
    await h.presenter.handle({ type: "export", ref: 2, reqId: 5 });
    // The tail loop is the only producer of `print`, and only once a bridge has
    // gone from disconnected to connected with lines waiting in its ring.
    h.bridge.lines = [{ seq: 1, text: "hello from the sim" }];
    await h.presenter.poll();

    expect(typesOf(h.posted)).toEqual([...CONSOLE_PROTOCOL.toWebview].sort());
  });
});

// ── Marketplace: the host half ───────────────────────────────────────────────

describe("marketplace — webview -> host", () => {
  it("drives exactly the declared message set", () => {
    expect(Object.keys(MARKETPLACE_DRIVES).sort()).toEqual([...MARKETPLACE_PROTOCOL.toHost].sort());
  });

  it.each(MARKETPLACE_PROTOCOL.toHost)("%s is acted on", async (type) => {
    const plan = MARKETPLACE_DRIVES[type as MarketplaceInbound["type"]];
    const h = marketplaceHarness();
    for (const m of plan.before ?? []) await h.presenter.handle(m);
    const before = h.interactions();
    await h.presenter.handle(plan.send);
    expect(h.interactions()).toBeGreaterThan(before);
  });

  it("does nothing at all for a message type the contract does not declare", () => {
    const h = marketplaceHarness();
    void h.presenter.handle({ type: "notInTheContract" } as unknown as MarketplaceInbound);
    expect(h.interactions()).toBe(0);
  });
});

describe("marketplace — host -> webview", () => {
  it("produces exactly the declared message set", async () => {
    const posted: MarketplaceHostMessage[] = [];
    /** Run one scripted session and fold its posts into the observed set. */
    const session = async (
      over: Partial<MarketplacePresenterDeps>,
      drive: (p: MarketplacePresenter) => Promise<void>,
    ): Promise<void> => {
      const h = marketplaceHarness(over);
      await drive(h.presenter);
      posted.push(...h.posted);
    };

    // Signed in and discovering: auth, listings:busy, listings.
    await session(
      {
        auth: {
          getToken: async () => "tok",
          onDidChangeSessions: () => ({ dispose: () => {} }),
          currentSession: async () => ({ token: "tok", accountLabel: "pilot" }),
          signIn: async () => ({ token: "tok", accountLabel: "pilot" }),
        },
      },
      (p) => p.handle({ type: "ready" }),
    );

    // Discovery that fails: listings:error.
    await session(
      {
        market: {
          discover: async () => {
            throw new Error("rate limited");
          },
          loadProduct: async () => product(),
        },
      },
      (p) => p.discover(false),
    );

    // A product that loads: product:busy, product.
    await session({}, (p) => p.handle({ type: "openProduct", repo: "Owner/Repo" }));

    // A product that does not: product:error.
    await session(
      {
        market: {
          discover: async () => [],
          loadProduct: async () => {
            throw new Error("502 Bad Gateway");
          },
        },
      },
      (p) => p.handle({ type: "openProduct", repo: "Owner/Repo" }),
    );

    // A successful install: installProgress, installed.
    await session({}, async (p) => {
      await p.handle({ type: "openProduct", repo: "Owner/Repo" });
      await p.handle({ type: "install", repo: "Owner/Repo" });
    });

    // A failed install: installError.
    await session(
      {
        subs: {
          install: async () => {
            throw new Error("network down");
          },
          unsubscribe: async () => {},
          fetchPlan: async () => null,
          isSubscribed: async () => false,
        } as MarketplacePresenterDeps["subs"],
      },
      async (p) => {
        await p.handle({ type: "openProduct", repo: "Owner/Repo" });
        await p.handle({ type: "install", repo: "Owner/Repo" });
      },
    );

    // Removing it again: uninstalled.
    await session({}, (p) => p.handle({ type: "uninstall", repo: "Owner/Repo" }));

    expect(typesOf(posted)).toEqual([...MARKETPLACE_PROTOCOL.toWebview].sort());
  });
});
