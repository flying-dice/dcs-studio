import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FakeWebviewView,
  fireWorkspaceFoldersChanged,
  resetVscode,
  state,
  vscodeMock,
} from "../support/vscode";

vi.mock("vscode", () => vscodeMock());

import * as vscode from "vscode";
import type { BridgeClients } from "../../../src/bridge/clients";
import type { DualBridgeStatus } from "../../../src/core/domain/bridgeProtocol";
import { DocsPanel } from "../../../src/docs/docsPanel";
import { NavViewProvider } from "../../../src/nav/navView";
import type { SkillsLibrary } from "../../../src/skills/library";
import { webviewCapabilities } from "../../../src/webview/panel";

// The sidebar and the documentation panel — the two views a user meets first.
//
// The sidebar's DECISIONS moved to `NavPresenter` (card 14) and run with no
// `vscode` at all in `test/unit/nav/navPresenter.test.ts`: collapsing the two
// bridges into one footer, counting the outdated skills into a badge, the one
// manifest boolean behind two rows, and the `run` guard. What is left here is
// what only a real editor can be wrong about, and it is most of why this file
// exists: the sidebar subscribes to three independent signals and every one of
// those subscriptions has to be torn down when the view goes away, or the
// extension leaks handlers across every reload.

const EXT = "C:\\ext";

function statusOf(over: Partial<DualBridgeStatus> = {}): DualBridgeStatus {
  return {
    gui: { connected: false, dcsTime: 0 },
    mission: { connected: false, dcsTime: 0 },
    ...over,
  } as DualBridgeStatus;
}

/** What the router currently reports, as `BridgeRouterPort.current` would. */
let routerStatus: DualBridgeStatus = statusOf();
let statusListener: ((s: DualBridgeStatus) => void) | undefined;
let skillsListener: (() => void) | undefined;
let statusDisposed = false;
let skillsDisposed = false;
let updates: string[] = [];

function clients(): BridgeClients {
  return {
    // What the presenter reads to answer the webview's boot `ready` — the
    // router's authoritative pair rather than a copy the view kept.
    get current() {
      return routerStatus;
    },
    onStatus: (fn: (s: DualBridgeStatus) => void) => {
      statusListener = fn;
      return {
        dispose: () => {
          statusDisposed = true;
          statusListener = undefined;
        },
      };
    },
  } as unknown as BridgeClients;
}

function skills(): SkillsLibrary {
  return {
    onDidChange: (fn: () => void) => {
      skillsListener = fn;
      return {
        dispose: () => {
          skillsDisposed = true;
          skillsListener = undefined;
        },
      };
    },
    updatesAvailable: async () => updates,
  } as unknown as SkillsLibrary;
}

async function resolve(): Promise<FakeWebviewView> {
  const view = new FakeWebviewView();
  new NavViewProvider(vscode.Uri.file(EXT), clients(), skills()).resolveWebviewView(
    view as unknown as vscode.WebviewView,
  );
  // The provider kicks off two async pushes (skills, manifest) on resolve.
  await new Promise((r) => setTimeout(r, 0));
  return view;
}

beforeEach(() => {
  resetVscode({ workspaceFolders: ["C:\\proj"] });
  statusListener = undefined;
  skillsListener = undefined;
  statusDisposed = false;
  skillsDisposed = false;
  updates = [];
  routerStatus = statusOf();
  DocsPanel.current = undefined;
});

describe("nav webview capabilities", () => {
  // The eleventh webview surface, and the one that matters most. The ten
  // panels are opened on demand and closed; the sidebar is registered at
  // activation and lives for the whole session, so it has the longest lifetime
  // and the lowest bar to being rendered. It set its own copy of these options
  // until #51's follow-up, which made it the only webview whose capabilities
  // could drift with nothing to catch it.

  it("may run scripts, and may read media/ and nothing wider", async () => {
    const view = await resolve();

    expect(view.webview.options).toEqual({
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(vscode.Uri.file(EXT), "media")],
    });
  });

  it("takes those capabilities from the one place that decides them", async () => {
    // Not a restatement of the test above: this pins that the sidebar and the
    // panels resolve to the SAME value, so widening one cannot leave the other
    // behind. `webviewCapabilities` is the single decision both read.
    const view = await resolve();

    expect(view.webview.options).toEqual(webviewCapabilities(vscode.Uri.file(EXT)));
  });
});

describe("NavViewProvider", () => {
  it("renders a sidebar document without the mobile viewport", async () => {
    const view = await resolve();
    expect(view.webview.html).toContain("nav.js");
    // The sidebar is the one caller that opts out — it is already narrow.
    expect(view.webview.html).not.toContain('name="viewport"');
    expect(view.webview.html).toContain("window.__LOGO__");
  });

  it("routes a received message to the presenter, whose effect reaches the editor", async () => {
    const view = await resolve();
    await view.webview.receive({ type: "run", command: "dcs.marketplace.open" });
    expect(state.executedCommands).toEqual([{ command: "dcs.marketplace.open", args: [] }]);
  });

  it("answers the webview's boot handshake with the whole opening state", async () => {
    // The shell half of card 29: the two pushes `resolveWebviewView` kicks off are
    // async and can land before media/nav.js is listening, and the sidebar has no
    // other trigger — so a workspace that IS a mod project would keep Publish Mod
    // hidden until a folder change. The status in the answer comes from the
    // router's `current`, which is the only reason the presenter can be asked for
    // it outside a subscription callback.
    resetVscode({ workspaceFolders: ["C:\\proj"], existingPaths: ["C:\\proj\\dcs-studio.toml"] });
    updates = ["dcs-studio"];
    routerStatus = statusOf({ mission: { connected: true, dcsTime: 213 } } as never);
    const view = await resolve();
    view.webview.posted.length = 0; // ignore the unprompted first chance

    await view.webview.receive({ type: "ready" });
    await new Promise((r) => setTimeout(r, 0));

    expect(view.webview.postedOfType("status").at(-1)).toMatchObject({
      status: { connected: true, dcsTime: 213 },
    });
    expect(view.webview.postedOfType("skills").at(-1)).toMatchObject({ updates: 1 });
    expect(view.webview.postedOfType("manifest").at(-1)).toMatchObject({ hasManifest: true });
  });

  it("delivers the bridge status the router reports to the presenter", async () => {
    // The collapse itself is the presenter's and tested there; what this
    // witnesses is that the subscription is wired to it at all.
    const view = await resolve();
    statusListener?.(statusOf({ gui: { connected: true, dcsTime: 0 } } as never));
    expect(view.webview.postedOfType("status").at(-1)).toMatchObject({
      status: { connected: true },
    });
  });

  it("re-pushes the skills badge when the library changes", async () => {
    updates = ["dcs-studio"];
    const view = await resolve();
    expect(view.webview.postedOfType("skills").at(-1)).toMatchObject({ updates: 1 });

    updates = ["a", "b"];
    skillsListener?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(view.webview.postedOfType("skills").at(-1)).toMatchObject({ updates: 2 });
  });

  it("reports no manifest when the workspace has none", async () => {
    const view = await resolve();
    expect(view.webview.postedOfType("manifest").at(-1)).toMatchObject({ hasManifest: false });
  });

  it("reports a manifest when dcs-studio.toml exists", async () => {
    resetVscode({ workspaceFolders: ["C:\\proj"], existingPaths: ["C:\\proj\\dcs-studio.toml"] });
    const view = await resolve();
    // Drives the "Create a Mod" row's label — it reads "Edit Project" instead.
    expect(view.webview.postedOfType("manifest").at(-1)).toMatchObject({ hasManifest: true });
  });

  it("reports no manifest when there is no workspace folder at all", async () => {
    resetVscode({});
    const view = await resolve();
    expect(view.webview.postedOfType("manifest").at(-1)).toMatchObject({ hasManifest: false });
    // No folder to watch, so only the workspace-folders subscription exists.
    expect(state.watchers).toHaveLength(0);
  });

  it("re-checks the manifest when one is created or deleted", async () => {
    const view = await resolve();
    const watcher = state.watchers[0];
    expect(watcher).toBeDefined();

    state.existingPaths.add("C:\\proj\\dcs-studio.toml");
    watcher.fireCreate();
    await new Promise((r) => setTimeout(r, 0));
    expect(view.webview.postedOfType("manifest").at(-1)).toMatchObject({ hasManifest: true });

    state.existingPaths.delete("C:\\proj\\dcs-studio.toml");
    watcher.fireDelete();
    await new Promise((r) => setTimeout(r, 0));
    expect(view.webview.postedOfType("manifest").at(-1)).toMatchObject({ hasManifest: false });
  });

  it("re-watches when the workspace folders change", async () => {
    await resolve();
    expect(state.watchers).toHaveLength(1);

    fireWorkspaceFoldersChanged();
    await new Promise((r) => setTimeout(r, 0));
    // The old watcher is disposed rather than left running against a folder
    // that may no longer be open.
    expect(state.watchers[0].disposed).toBe(true);
    expect(state.watchers).toHaveLength(2);
  });

  it("tears down every subscription when the view is disposed", async () => {
    const view = await resolve();
    view.dispose();

    expect(statusDisposed).toBe(true);
    expect(skillsDisposed).toBe(true);
    expect(state.watchers.every((w) => w.disposed)).toBe(true);
  });

  it("posts nothing after disposal, rather than throwing on a dead view", async () => {
    const view = await resolve();
    view.dispose();
    const before = view.webview.posted.length;

    // The status subscription is gone, but a late skills push must also be a
    // no-op rather than an unhandled rejection.
    skillsListener?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(view.webview.posted).toHaveLength(before);
  });
});

describe("DocsPanel", () => {
  const context = () =>
    ({
      extensionUri: vscode.Uri.file(EXT),
      subscriptions: [],
    }) as unknown as vscode.ExtensionContext;

  it("opens a docs webview seeded with the requested initial page", () => {
    DocsPanel.show(context(), "sandbox");
    const panel = state.panels[0];
    expect(panel.title).toBe("Documentation");
    // The page is injected as a nonce-tagged inline script so docs.js can read
    // it synchronously at load rather than waiting for a message round-trip.
    expect(panel.webview.html).toContain('window.__INITIAL_PAGE__ = "sandbox"');
    expect(panel.webview.html).toContain("docs-content.js");
  });

  it("seeds an empty initial page when none is given", () => {
    DocsPanel.show(context());
    expect(state.panels[0].webview.html).toContain('window.__INITIAL_PAGE__ = ""');
  });

  it("reveals the existing panel and navigates it instead of opening another", async () => {
    DocsPanel.show(context(), "sandbox");
    DocsPanel.show(context(), "manifest");

    expect(state.panels).toHaveLength(1);
    expect(state.panels[0].webview.postedOfType("goto")).toEqual([
      { type: "goto", page: "manifest" },
    ]);
  });

  it("runs a command a docs page asks for", async () => {
    DocsPanel.show(context());
    await state.panels[0].webview.receive({ type: "run", command: "dcs.marketplace.open" });
    expect(state.executedCommands).toEqual([{ command: "dcs.marketplace.open", args: [] }]);
  });

  it("opens an external link from a docs page", async () => {
    DocsPanel.show(context());
    await state.panels[0].webview.receive({
      type: "openExternal",
      url: "https://www.digitalcombatsimulator.com/",
    });
    expect(state.openedExternal).toEqual(["https://www.digitalcombatsimulator.com/"]);
  });

  it("clears the singleton on dispose so the next show re-opens", () => {
    DocsPanel.show(context());
    state.panels[0].dispose();
    expect(DocsPanel.current).toBeUndefined();

    DocsPanel.show(context());
    expect(state.panels).toHaveLength(2);
  });
});
