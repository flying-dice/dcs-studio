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

// The publish flow's WIRING — what only this layer can witness now that the
// decisions live in `src/core/app/publishPresenter.ts` (covered without any
// `vscode` double by `test/unit/publish/publishPresenter.test.ts` and driven
// through the declared contract by `test/unit/core/webviewContract.test.ts`).
//
// What is left here is the shell: the panel and its singleton, the workspace
// root the presenter is constructed with, the fs-and-spawn `preflight`/
// `readManifest` adapters reaching the real manifest core and the real check
// policy, the `openExternal` effect being performed, and teardown. The busy
// bracket, the blocker message and the fallback defaults are asserted in the
// unit layer; what is asserted here is that the wiring delivers the facts those
// decisions are made from.

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
/** Indirection so one spec can hold the probe in flight; defaults to resolving
 *  with `toolFacts` immediately, which every other spec relies on. */
let toolFactsImpl: () => Promise<typeof toolFacts> = async () => toolFacts;
let remote: string | null = "https://github.com/Owner/Repo.git";
let shareImpl: (log: (l: string) => void) => Promise<unknown> = async () => ({ url: "u" });
let releaseImpl: (log: (l: string) => void) => Promise<unknown> = async () => ({ url: "u" });
/** What the panel actually handed the service, so the wiring is asserted on
 *  values rather than on the fact that something came back. */
let shareArgs: unknown[] = [];
let releaseArgs: unknown[] = [];

function publishService(): PublishService {
  return {
    toolFacts: () => toolFactsImpl(),
    remoteUrl: async () => remote,
    share: async (root: string, opts: unknown, log: (l: string) => void) => {
      shareArgs = [root, opts];
      return shareImpl(log);
    },
    cutRelease: async (root: string, opts: unknown, log: (l: string) => void) => {
      releaseArgs = [root, opts];
      return releaseImpl(log);
    },
  } as unknown as PublishService;
}

const context = () =>
  ({ extensionUri: vscode.Uri.file(EXT), subscriptions: [] }) as unknown as vscode.ExtensionContext;

const flush = () => new Promise((r) => setTimeout(r, 0));

async function show() {
  PublishPanel.show(context(), publishService(), new VsCodeManifest(context()));
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
  toolFactsImpl = async () => toolFacts;
  remote = "https://github.com/Owner/Repo.git";
  shareImpl = async () => ({ url: "u" });
  releaseImpl = async () => ({ url: "u" });
  shareArgs = [];
  releaseArgs = [];
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

  it("blocks on a missing manifest", async () => {
    // The fallback defaults are the presenter's decision and asserted there;
    // what this layer witnesses is the fs adapter reporting the absence at all.
    files.delete(MANIFEST);
    const panel = await show();
    const init = panel.webview.postedOfType("init")[0];
    expect((init.checks as { level: string }[]).some((c) => c.level === "error")).toBe(true);
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

// The service calls themselves: that the workspace root and the webview's opts
// arrive at the real `PublishService` methods, and that the log callback the
// service streams through reaches the webview. The bracket around them, the
// failure mapping and the scoping are the presenter's, and are asserted there.
describe("the service wiring", () => {
  it("hands share the workspace root, the webview's opts and a live log sink", async () => {
    shareImpl = async (log) => {
      log("Creating repository…");
      return { url: "u" };
    };
    const panel = await show();
    await panel.webview.receive({ type: "share", opts: { name: "my-mod" } });
    await flush();

    expect(shareArgs).toEqual([ROOT, { name: "my-mod" }]);
    expect(panel.webview.postedOfType("log").map((m) => m.line)).toEqual(["Creating repository…"]);
    expect(panel.webview.postedOfType("shareDone")).toHaveLength(1);
  });

  it("hands cutRelease the same, and reports its result", async () => {
    releaseImpl = async (log) => {
      log("Packaging payload…");
      return { url: "u" };
    };
    const panel = await show();
    await panel.webview.receive({ type: "release", opts: { tag: "v1.2.3" } });
    await flush();

    expect(releaseArgs).toEqual([ROOT, { tag: "v1.2.3" }]);
    expect(panel.webview.postedOfType("log").map((m) => m.line)).toEqual(["Packaging payload…"]);
    expect(panel.webview.postedOfType("releaseDone")).toHaveLength(1);
  });
});

describe("panel plumbing", () => {
  it("opens an external link", async () => {
    const panel = await show();
    await panel.webview.receive({ type: "openExternal", url: "https://github.com/Owner/Repo" });
    expect(state.openedExternal).toEqual(["https://github.com/Owner/Repo"]);
  });

  it("reveals the existing panel rather than opening a second", async () => {
    await show();
    PublishPanel.show(context(), publishService(), new VsCodeManifest(context()));
    expect(state.panels).toHaveLength(1);
  });

  it("clears the singleton on dispose", async () => {
    const panel = await show();
    panel.dispose();
    expect(PublishPanel.current).toBeUndefined();
  });

  // The opening preflight now spawns real CLI probes (gh --version, gh auth
  // status) and takes seconds cold. A user can close the panel inside that
  // window, and the real webview THROWS on a post after dispose — a rejection
  // nothing awaits, surfaced as an extension-host error. The shell's poster
  // must drop late output instead.
  it("drops presenter output that resolves after the panel was closed", async () => {
    let release!: () => void;
    toolFactsImpl = () => new Promise((r) => (release = () => r(toolFacts)));
    PublishPanel.show(context(), publishService(), new VsCodeManifest(context()));
    const panel = state.panels[0];
    await flush();
    expect(panel.webview.posted).toHaveLength(0); // still probing
    panel.dispose();
    release();
    await flush();
    expect(panel.webview.posted).toHaveLength(0); // late init was dropped
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
