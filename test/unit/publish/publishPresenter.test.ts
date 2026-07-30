import { beforeEach, describe, expect, it } from "vitest";
import type { PublishEffect, PublishPresenterDeps } from "../../../src/core/app/publishPresenter";
import { PublishPresenter } from "../../../src/core/app/publishPresenter";
import type { ReleaseResult, ShareResult } from "../../../src/core/app/publishService";
import type { PublishHostMessage } from "../../../src/core/app/webviewContract";
import type { Check } from "../../../src/core/domain/publishChecks";
import type { ManifestModel } from "../../../src/core/domain/types";

// The publish flow's decision logic, with no `vscode` double anywhere.
//
// This is the panel with the least margin for error in the product: a share
// creates a real repository, a release uploads assets onto a tag. The presenter
// decides none of that — it decides what the user is shown before they press the
// button, whether the checks are re-run at the moment they press it, and whether
// a failure leaves the button stuck busy.

const ROOT = "C:\\proj";

function manifest(over: Partial<ManifestModel["project"]> = {}): ManifestModel {
  return {
    project: { name: "my-mod", version: "1.2.3", author: "", description: "Does a thing", ...over },
    bundle: [{ path: "Scripts" }],
    symlink: [],
    requires_module: [],
    entrypoint: [],
    mission_script: [],
    extras: [],
  };
}

const OK_CHECKS: Check[] = [{ label: "7-Zip", level: "ok", detail: "C:\\7z\\7z.exe" }];
const BLOCKED: Check[] = [
  { label: "Project name", level: "ok", detail: "my-mod" },
  { label: "Bundle paths", level: "error", detail: "1 of 1 bundle path(s) missing" },
  { label: "7-Zip", level: "error", detail: "7z not found." },
];

const SHARED: ShareResult = {
  owner: "Owner",
  name: "my-mod",
  url: "https://github.com/Owner/my-mod",
};
const RELEASED: ReleaseResult = {
  assets: ["dcs-studio.toml", "my-mod-v1.2.3.7z"],
  url: "https://github.com/Owner/my-mod/releases/tag/v1.2.3",
  packaged: { split: false, volumes: [], totalBytes: 10 },
};

interface Harness {
  presenter: PublishPresenter;
  posted: PublishHostMessage[];
  effects: PublishEffect[];
  calls: string[];
  typed<T extends PublishHostMessage["type"]>(type: T): Extract<PublishHostMessage, { type: T }>[];
  lines(): string[];
}

/** Mutable per-test facts, so a test can change the world mid-flight — which is
 *  the whole point of the re-check gate. */
let checks: Check[];
let remote: string | null;
let model: ManifestModel | null;
let shareImpl: (log: (l: string) => void) => Promise<ShareResult>;
let releaseImpl: (log: (l: string) => void) => Promise<ReleaseResult>;

function harness(over: Partial<PublishPresenterDeps> = {}): Harness {
  const posted: PublishHostMessage[] = [];
  const effects: PublishEffect[] = [];
  const calls: string[] = [];
  const presenter = new PublishPresenter({
    root: ROOT,
    preflight: async (root) => {
      calls.push(`preflight ${root}`);
      return checks;
    },
    readManifest: () => model,
    remoteUrl: async () => remote,
    share: async (root, opts, log) => {
      calls.push(`share ${root} ${JSON.stringify(opts)}`);
      return shareImpl(log);
    },
    cutRelease: async (root, opts, log) => {
      calls.push(`release ${root} ${JSON.stringify(opts)}`);
      return releaseImpl(log);
    },
    post: (msg) => posted.push(msg),
    effect: (e) => effects.push(e),
    ...over,
  });
  return {
    presenter,
    posted,
    effects,
    calls,
    typed: (type) =>
      posted.filter((m) => m.type === type) as Extract<PublishHostMessage, { type: typeof type }>[],
    lines: () => posted.flatMap((m) => (m.type === "log" ? [m.line] : [])),
  };
}

beforeEach(() => {
  checks = OK_CHECKS;
  remote = "https://github.com/Owner/my-mod.git";
  model = manifest();
  shareImpl = async () => SHARED;
  releaseImpl = async () => RELEASED;
});

describe("the opening render", () => {
  it("seeds the form from the manifest and names the detected repo", async () => {
    const h = harness();
    await h.presenter.refresh();

    expect(h.typed("init")).toHaveLength(1);
    expect(h.typed("init")[0].defaults).toEqual({
      name: "my-mod",
      description: "Does a thing",
      version: "1.2.3",
    });
    expect(h.typed("init")[0].repo).toEqual({ owner: "Owner", name: "my-mod" });
    expect(h.typed("init")[0].checks).toEqual(OK_CHECKS);
  });

  it("falls back to a usable version rather than an empty box", async () => {
    // A manifest with no version at all: the name and description are honestly
    // blank, but an empty tag field would make the release form dead on arrival.
    model = manifest({ name: "", description: "", version: "" });
    const h = harness();
    await h.presenter.refresh();
    expect(h.typed("init")[0].defaults).toEqual({
      name: "",
      description: "",
      version: "0.1.0",
    });
  });

  it("falls back for a manifest that could not be read at all", async () => {
    model = null;
    const h = harness();
    await h.presenter.refresh();
    expect(h.typed("init")[0].defaults).toEqual({ name: "", description: "", version: "0.1.0" });
  });

  it("reports no repo when there is no origin remote", async () => {
    remote = null;
    const h = harness();
    await h.presenter.refresh();
    expect(h.typed("init")[0].repo).toBeNull();
  });

  it("reports no repo for a remote that is not a GitHub URL", async () => {
    // Not an error: a project pushed to a self-hosted git is simply not shared
    // to GitHub yet, and the Share form is exactly what it needs.
    remote = "https://git.example.com/team/my-mod.git";
    const h = harness();
    await h.presenter.refresh();
    expect(h.typed("init")[0].repo).toBeNull();
  });

  it("shows the no-folder view instead, with no preflight run at all", async () => {
    const h = harness({ root: null });
    await h.presenter.refresh();

    expect(h.typed("nofolder")).toHaveLength(1);
    expect(h.typed("init")).toHaveLength(0);
    expect(h.calls).toEqual([]);
  });

  it("re-runs preflight when the webview asks again", async () => {
    const h = harness();
    await h.presenter.refresh();
    await h.presenter.handle({ type: "refresh" });
    expect(h.typed("init")).toHaveLength(2);
  });
});

describe("preflight gates the action, not just the button", () => {
  it("refuses a share when a check went red since the panel last rendered", async () => {
    const h = harness();
    await h.presenter.refresh();
    checks = BLOCKED;
    await h.presenter.handle({ type: "share", opts: { name: "my-mod", description: "" } });

    expect(h.calls.filter((c) => c.startsWith("share"))).toEqual([]);
    expect(h.typed("shareDone")).toHaveLength(0);
    // The FIRST blocker names itself, so the user is told which item stopped it.
    expect(h.lines().at(-1)).toBe("✖ Bundle paths: 1 of 1 bundle path(s) missing");
    // The refusal re-renders, so the panel now shows why.
    expect(h.typed("init")).toHaveLength(2);
    // And the latch still clears, or the button would be left dead.
    expect(h.typed("busy").map((m) => m.busy)).toEqual([true, false]);
  });

  it("refuses a release the same way", async () => {
    checks = BLOCKED;
    const h = harness();
    await h.presenter.handle({
      type: "release",
      opts: { owner: "Owner", name: "my-mod", tag: "v1.2.3", notes: "" },
    });

    expect(h.calls.filter((c) => c.startsWith("release"))).toEqual([]);
    expect(h.typed("releaseDone")).toHaveLength(0);
    expect(h.typed("busy").map((m) => m.busy)).toEqual([true, false]);
  });

  it("lets both actions through while the checks pass", async () => {
    const h = harness();
    await h.presenter.handle({ type: "share", opts: { name: "my-mod", description: "" } });
    await h.presenter.handle({
      type: "release",
      opts: { owner: "Owner", name: "my-mod", tag: "v1.2.3", notes: "" },
    });

    expect(h.typed("shareDone")[0].result).toEqual(SHARED);
    expect(h.typed("releaseDone")[0].result).toEqual(RELEASED);
  });

  it("treats a warning as passable — only an error blocks", async () => {
    checks = [{ label: "Bundle paths", level: "warn", detail: "No [[bundle]] paths" }];
    const h = harness();
    await h.presenter.handle({ type: "share", opts: { name: "my-mod", description: "" } });
    expect(h.typed("shareDone")).toHaveLength(1);
  });

  it("re-checks at the moment of the action, not from the render's snapshot", async () => {
    // The ordering that makes the gate real: preflight runs again BEFORE the
    // service is called, so a project cleaned since the last render is caught.
    const h = harness();
    await h.presenter.handle({ type: "share", opts: { name: "my-mod", description: "" } });
    expect(h.calls).toEqual([
      `preflight ${ROOT}`,
      `share ${ROOT} {"name":"my-mod","description":""}`,
    ]);
  });
});

describe("the busy bracket", () => {
  it("streams the service's progress lines to the log", async () => {
    shareImpl = async (log) => {
      log("Creating repository…");
      log("Pushing…");
      return SHARED;
    };
    const h = harness();
    await h.presenter.handle({ type: "share", opts: { name: "my-mod", description: "" } });
    expect(h.lines()).toEqual(["Creating repository…", "Pushing…"]);
  });

  it("logs a failure and always clears busy", async () => {
    shareImpl = async () => {
      throw new Error("repo already exists");
    };
    const h = harness();
    await h.presenter.handle({ type: "share", opts: { name: "my-mod", description: "" } });

    expect(h.lines().at(-1)).toBe("✖ repo already exists");
    expect(h.typed("busy").map((m) => m.busy)).toEqual([true, false]);
    expect(h.typed("shareDone")).toHaveLength(0);
  });

  it("renders a non-Error throw", async () => {
    releaseImpl = async () => {
      throw "boom";
    };
    const h = harness();
    await h.presenter.handle({
      type: "release",
      opts: { owner: "Owner", name: "my-mod", tag: "v1", notes: "" },
    });
    expect(h.lines().at(-1)).toBe("✖ boom");
  });

  it("scopes the latch to the button that was pressed", async () => {
    const h = harness();
    await h.presenter.handle({ type: "share", opts: { name: "my-mod", description: "" } });
    await h.presenter.handle({
      type: "release",
      opts: { owner: "Owner", name: "my-mod", tag: "v1", notes: "" },
    });
    expect(h.typed("busy").map((m) => m.scope)).toEqual(["share", "share", "release", "release"]);
  });
});

describe("the rest of the router", () => {
  it("opens an external link as an effect", async () => {
    const h = harness();
    await h.presenter.handle({ type: "openExternal", url: "https://github.com/Owner/my-mod" });
    expect(h.effects).toEqual([{ kind: "openExternal", url: "https://github.com/Owner/my-mod" }]);
  });

  it("ignores openExternal with no url", async () => {
    const h = harness();
    await h.presenter.handle({ type: "openExternal" });
    expect(h.effects).toEqual([]);
  });

  it("ignores every action when there is no folder to publish", async () => {
    // Not a guess at a root: a share against `undefined` would run git in
    // whatever directory the extension host happened to be in.
    const h = harness({ root: null });
    await h.presenter.handle({ type: "share", opts: { name: "my-mod", description: "" } });
    await h.presenter.handle({
      type: "release",
      opts: { owner: "Owner", name: "my-mod", tag: "v1", notes: "" },
    });
    await h.presenter.handle({ type: "refresh" });
    await h.presenter.handle({ type: "openExternal", url: "https://github.com" });

    expect(h.posted).toEqual([]);
    expect(h.effects).toEqual([]);
    expect(h.calls).toEqual([]);
  });
});
