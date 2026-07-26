import { resolve as resolvePath } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetVscode, state, vscodeMock } from "../support/vscode";

vi.mock("vscode", () => vscodeMock());

const files = new Map<string, string>();
const symlinks = new Set<string>();
vi.mock("fs", () => ({
  existsSync: (p: string) => files.has(p),
  readFileSync: (p: string) => {
    const text = files.get(p);
    if (text === undefined) throw new Error(`ENOENT: ${p}`);
    return text;
  },
  lstatSync: (p: string) => {
    if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
    return { isSymbolicLink: () => symlinks.has(p) };
  },
}));

import * as vscode from "vscode";
import { VsCodeManifest } from "../../../src/adapters/vscode/manifest";
import type { PublishService } from "../../../src/core/app/publishService";
import { PublishPanel } from "../../../src/publish/publishPanel";

// The publish flow's host side. This is the panel with the least margin for
// error in the product: share creates a real GitHub repository and pushes, and
// a release packages assets and uploads them onto a tag. The panel itself never
// decides any of that — but it decides what the user is shown before they press
// the button, whether the checks are re-run before an action is allowed to
// start, and whether a failure leaves the buttons stuck busy.

// The repo root, so `require(<extensionUri>/media/manifest-core.js)` resolves
// the real UMD module rather than a stub — the manifest parse under test is the
// one that ships.
const EXT = resolvePath(__dirname, "../../..");
const ROOT = "C:\\proj";
const MANIFEST = `${ROOT}\\dcs-studio.toml`;

let toolFacts = {
  sevenZip: "C:\\7z\\7z.exe" as string | undefined,
  gitAvailable: true,
  gh: { present: true, authed: true },
};
let remote: string | null = "https://github.com/Owner/Repo.git";
let shareImpl: (log: (l: string) => void) => Promise<unknown> = async () => ({ url: "u" });
let releaseImpl: (log: (l: string) => void) => Promise<unknown> = async () => ({ url: "u" });

function publishService(): PublishService {
  return {
    toolFacts: async () => toolFacts,
    remoteUrl: async () => remote,
    share: async (_root: string, _opts: unknown, log: (l: string) => void) => shareImpl(log),
    cutRelease: async (_root: string, _opts: unknown, log: (l: string) => void) => releaseImpl(log),
  } as unknown as PublishService;
}

const context = () =>
  ({ extensionUri: vscode.Uri.file(EXT), subscriptions: [] }) as unknown as vscode.ExtensionContext;

const flush = () => new Promise((r) => setTimeout(r, 0));

async function show() {
  PublishPanel.show(context(), publishService());
  await flush();
  return state.panels[state.panels.length - 1];
}

beforeEach(() => {
  resetVscode({ workspaceFolders: [ROOT] });
  files.clear();
  symlinks.clear();
  files.set(
    MANIFEST,
    `[project]
name = "my-mod"
version = "1.2.3"
description = "Does a thing"

[[bundle]]
path = "Scripts"
`,
  );
  files.set(`${ROOT}\\Scripts`, "");
  toolFacts = {
    sevenZip: "C:\\7z\\7z.exe",
    gitAvailable: true,
    gh: { present: true, authed: true },
  };
  remote = "https://github.com/Owner/Repo.git";
  shareImpl = async () => ({ url: "u" });
  releaseImpl = async () => ({ url: "u" });
  PublishPanel.current = undefined;
});

describe("initial state", () => {
  it("seeds the form from the manifest and detects the existing remote", async () => {
    const panel = await show();
    const init = panel.webview.postedOfType("init")[0];

    expect(init.defaults).toEqual({
      name: "my-mod",
      description: "Does a thing",
      version: "1.2.3",
    });
    expect(init.repo).toEqual({ owner: "Owner", name: "Repo" });
  });

  it("reports no repo when the folder has no origin remote", async () => {
    remote = null;
    const panel = await show();
    expect(panel.webview.postedOfType("init")[0].repo).toBeNull();
  });

  it("passes preflight when the manifest, sources and tools are all present", async () => {
    const panel = await show();
    const checks = panel.webview.postedOfType("init")[0].checks as { level: string }[];
    expect(checks.some((c) => c.level === "error")).toBe(false);
  });

  it("survives a [project] name written as a bare TOML number", async () => {
    // `name = 2024` is valid TOML. It used to parse into a JS number, so the
    // preflight policy's name.trim() threw inside pushInit() and the panel
    // never received its checks at all — an empty Publish view with no reason
    // given. The parser now normalises the modeled [project] fields to text.
    files.set(MANIFEST, '[project]\nname = 2024\nversion = 3\n\n[[bundle]]\npath = "Scripts"\n');
    const panel = await show();
    const init = panel.webview.postedOfType("init")[0];

    expect(init.defaults).toMatchObject({ name: "2024", version: "3" });
    const checks = init.checks as { label: string; level: string; detail: string }[];
    expect(checks.find((c) => c.label === "Project name")).toMatchObject({
      level: "ok",
      detail: "2024",
    });
  });

  it("blocks on a missing manifest and falls back to empty defaults", async () => {
    files.delete(MANIFEST);
    const panel = await show();
    const init = panel.webview.postedOfType("init")[0];

    expect((init.checks as { level: string }[]).some((c) => c.level === "error")).toBe(true);
    // Version still gets a sensible starting point rather than an empty box.
    expect(init.defaults).toEqual({ name: "", description: "", version: "0.1.0" });
  });

  it("blocks when a declared bundle path has not been built", async () => {
    files.delete(`${ROOT}\\Scripts`);
    const panel = await show();
    const checks = panel.webview.postedOfType("init")[0].checks as {
      level: string;
      label: string;
    }[];
    // Publishing a manifest whose payload does not exist yields a release
    // nobody can install.
    expect(checks.some((c) => c.level === "error")).toBe(true);
  });

  it("still reports when a bundle path is a symlink rather than real content", async () => {
    symlinks.add(`${ROOT}\\Scripts`);
    const panel = await show();
    const checks = panel.webview.postedOfType("init")[0].checks as { level: string }[];
    expect(checks.length).toBeGreaterThan(0);
  });

  it("blocks when 7-Zip is missing", async () => {
    toolFacts = { ...toolFacts, sevenZip: undefined };
    const panel = await show();
    const checks = panel.webview.postedOfType("init")[0].checks as { level: string }[];
    expect(checks.some((c) => c.level === "error")).toBe(true);
  });

  it("tells a folderless window there is nothing to publish", async () => {
    resetVscode({});
    const panel = await show();
    expect(panel.webview.postedOfType("nofolder")).toHaveLength(1);
    expect(panel.webview.postedOfType("init")).toHaveLength(0);
  });

  it("ignores every action when there is no folder", async () => {
    resetVscode({});
    const panel = await show();
    await panel.webview.receive({ type: "share", opts: {} });
    await panel.webview.receive({ type: "release", opts: {} });
    await flush();
    expect(panel.webview.postedOfType("busy")).toHaveLength(0);
  });

  it("re-runs preflight on refresh", async () => {
    const panel = await show();
    await panel.webview.receive({ type: "refresh" });
    await flush();
    expect(panel.webview.postedOfType("init")).toHaveLength(2);
  });
});

// The disabled state of the buttons is computed in the webview from whatever
// preflight last returned. That snapshot can be minutes old, and nothing stops
// a manifest being deleted or a build being cleaned in between — so the host
// re-runs the checks at the moment it is asked to act, and refuses on its own.
describe("preflight gates the action, not just the button", () => {
  it("refuses a share when the manifest went missing since the panel last checked", async () => {
    let shared = false;
    shareImpl = async () => {
      shared = true;
      return { url: "u" };
    };
    const panel = await show();
    files.delete(MANIFEST);
    await panel.webview.receive({ type: "share", opts: { name: "my-mod" } });
    await flush();

    expect(shared).toBe(false);
    expect(panel.webview.postedOfType("shareDone")).toHaveLength(0);
    expect(panel.webview.postedOfType("log").at(-1)?.line).toBe(
      "✖ Manifest: dcs-studio.toml not found in the workspace root.",
    );
    // The refusal re-renders the checks, so the panel now shows why.
    expect(panel.webview.postedOfType("init")).toHaveLength(2);
    // And the busy latch still clears, or the button would be left dead.
    expect(panel.webview.postedOfType("busy").map((m) => m.busy)).toEqual([true, false]);
  });

  it("refuses a release when a bundle path was cleaned since the panel last checked", async () => {
    let released = false;
    releaseImpl = async () => {
      released = true;
      return { url: "u" };
    };
    const panel = await show();
    files.delete(`${ROOT}\\Scripts`);
    await panel.webview.receive({ type: "release", opts: { tag: "v1.2.3" } });
    await flush();

    expect(released).toBe(false);
    expect(panel.webview.postedOfType("releaseDone")).toHaveLength(0);
    expect(panel.webview.postedOfType("log").at(-1)?.line).toBe(
      "✖ Bundle paths: 1 of 1 bundle path(s) missing — build the project first.",
    );
  });

  it("lets both actions through while the checks still pass", async () => {
    const panel = await show();
    await panel.webview.receive({ type: "share", opts: { name: "my-mod" } });
    await panel.webview.receive({ type: "release", opts: { tag: "v1.2.3" } });
    await flush();

    expect(panel.webview.postedOfType("shareDone")).toHaveLength(1);
    expect(panel.webview.postedOfType("releaseDone")).toHaveLength(1);
  });
});

describe("share and release", () => {
  it("brackets a share with busy true/false and reports the result", async () => {
    const panel = await show();
    await panel.webview.receive({ type: "share", opts: { name: "my-mod" } });
    await flush();

    expect(panel.webview.postedOfType("busy").map((m) => m.busy)).toEqual([true, false]);
    expect(panel.webview.postedOfType("shareDone")).toHaveLength(1);
  });

  it("streams progress lines from the service to the log", async () => {
    shareImpl = async (log) => {
      log("Creating repository…");
      log("Pushing…");
      return { url: "u" };
    };
    const panel = await show();
    await panel.webview.receive({ type: "share", opts: {} });
    await flush();

    expect(panel.webview.postedOfType("log").map((m) => m.line)).toEqual([
      "Creating repository…",
      "Pushing…",
    ]);
  });

  it("logs a share failure and always clears busy", async () => {
    // The finally-clause matters more than the message: a stuck busy flag
    // leaves the user with a dead button and no way to retry.
    shareImpl = async () => {
      throw new Error("repo already exists");
    };
    const panel = await show();
    await panel.webview.receive({ type: "share", opts: {} });
    await flush();

    expect(panel.webview.postedOfType("log").at(-1)?.line).toBe("✖ repo already exists");
    expect(panel.webview.postedOfType("busy").map((m) => m.busy)).toEqual([true, false]);
    expect(panel.webview.postedOfType("shareDone")).toHaveLength(0);
  });

  it("renders a non-Error share failure", async () => {
    shareImpl = async () => {
      throw "boom";
    };
    const panel = await show();
    await panel.webview.receive({ type: "share", opts: {} });
    await flush();
    expect(panel.webview.postedOfType("log").at(-1)?.line).toBe("✖ boom");
  });

  it("scopes busy to the button that was pressed", async () => {
    const panel = await show();
    await panel.webview.receive({ type: "release", opts: {} });
    await flush();
    expect(panel.webview.postedOfType("busy").every((m) => m.scope === "release")).toBe(true);
  });

  it("brackets a release and reports the result", async () => {
    const panel = await show();
    await panel.webview.receive({ type: "release", opts: { tag: "v1.2.3" } });
    await flush();
    expect(panel.webview.postedOfType("releaseDone")).toHaveLength(1);
  });

  it("streams release progress lines to the log", async () => {
    releaseImpl = async (log) => {
      log("Packaging payload…");
      log("Uploading assets…");
      return { url: "u" };
    };
    const panel = await show();
    await panel.webview.receive({ type: "release", opts: { tag: "v1.2.3" } });
    await flush();

    expect(panel.webview.postedOfType("log").map((m) => m.line)).toEqual([
      "Packaging payload…",
      "Uploading assets…",
    ]);
  });

  it("logs a release failure and clears busy", async () => {
    releaseImpl = async () => {
      throw new Error("tag exists");
    };
    const panel = await show();
    await panel.webview.receive({ type: "release", opts: {} });
    await flush();

    expect(panel.webview.postedOfType("log").at(-1)?.line).toBe("✖ tag exists");
    expect(panel.webview.postedOfType("busy").map((m) => m.busy)).toEqual([true, false]);
  });
});

describe("panel plumbing", () => {
  it("opens an external link", async () => {
    const panel = await show();
    await panel.webview.receive({ type: "openExternal", url: "https://github.com/Owner/Repo" });
    expect(state.openedExternal).toEqual(["https://github.com/Owner/Repo"]);
  });

  it("ignores openExternal with no url and unknown types", async () => {
    const panel = await show();
    await panel.webview.receive({ type: "openExternal" });
    await panel.webview.receive({ type: "mystery" });
    expect(state.openedExternal).toEqual([]);
  });

  it("reveals the existing panel rather than opening a second", async () => {
    await show();
    PublishPanel.show(context(), publishService());
    expect(state.panels).toHaveLength(1);
  });

  it("clears the singleton on dispose", async () => {
    const panel = await show();
    panel.dispose();
    expect(PublishPanel.current).toBeUndefined();
  });
});

describe("VsCodeManifest adapter", () => {
  it("parses and re-emits through the shipped UMD core", () => {
    const manifest = new VsCodeManifest(context());
    const model = manifest.parseToml('[project]\nname = "x"\n');
    expect(model.project.name).toBe("x");
    expect(manifest.emitToml(model)).toContain('name = "x"');
  });

  it("resolves a dest token against the install roots", () => {
    const manifest = new VsCodeManifest(context());
    expect(
      manifest.resolveDest("{SavedGames}/Scripts/a.lua", {
        savedGames: "C:\\SG\\DCS",
        gameInstall: "D:\\DCS",
      }),
    ).toBe("C:\\SG\\DCS\\Scripts\\a.lua");
  });

  it("memoises the core across calls rather than requiring it per call", () => {
    // The module is resolved lazily so activation never pays the require cost,
    // then reused — every method after the first goes through the same object.
    const manifest = new VsCodeManifest(context());
    const first = manifest.parseToml('[project]\nname = "y"\n');
    manifest.parseToml("[project]\n");
    expect(manifest.emitToml(first)).toContain("y");
    expect(
      manifest.resolveDest("{SavedGames}/x", { savedGames: "C:\\SG", gameInstall: "D:\\G" }),
    ).toBe("C:\\SG\\x");
  });
});
