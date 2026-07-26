import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetVscode, state, vscodeMock } from "../support/vscode";

vi.mock("vscode", () => vscodeMock());

import * as vscode from "vscode";
import type { ProcessLauncher } from "../../../src/adapters/node/processLauncher";
import type { MyModsLedger } from "../../../src/core/app/myModsPresenter";
import type { SubscriptionService } from "../../../src/core/app/subscriptionService";
import type { Subscription } from "../../../src/core/domain/types";
import type { AuthPort } from "../../../src/core/ports/auth";
import type { InstallRootsPort } from "../../../src/core/ports/installRoots";
import type { MarketplacePort } from "../../../src/core/ports/marketplace";
import { MyModsPanel } from "../../../src/install/myModsPanel";

// The panel is the shell around MyModsPresenter: it owns the webview, routes
// messages into the presenter, and performs the effects the presenter describes.
// The rules themselves (consent, update-vs-reinstall, stop-before-unlink, the
// error→message mapping) are asserted in test/unit/install/myModsPresenter.test.ts
// — what is left here is the wiring, and it is only correct if every effect the
// presenter can describe actually reaches VS Code.

const DATA_DIR = "D:\\DCSStudio\\mods";
const UNINSTALL_BAT = `${DATA_DIR}\\uninstall-all.bat`;

const sub = (): Subscription =>
  ({
    repo: "Owner/Mod",
    name: "Carrier Mod",
    tag: "v1.0.0",
    dir: `${DATA_DIR}\\owner-mod`,
    enabled: true,
    links: [{ id: "l1", dest: "C:\\Saved Games\\DCS\\Mods\\Mod" }],
    entrypoints: [{ id: "gui", name: "Config GUI", exe: "bin\\config.exe" }],
  }) as Subscription;

let subs: Subscription[] = [];
let enableThrows: unknown;
const service = {
  list: async () => subs,
  enable: async () => {
    if (enableThrows) throw enableThrows;
  },
} as unknown as SubscriptionService;

let corruptNotice: string | undefined;
const ledger: MyModsLedger = {
  ensureUninstallBat: () => UNINSTALL_BAT,
  uninstallBatPath: () => UNINSTALL_BAT,
  takeCorruptNotice: () => {
    const notice = corruptNotice;
    corruptNotice = undefined;
    return notice;
  },
};

// Passed straight through to the presenter and never reached from here: only
// Update touches them, and its rules are unit-tested against the presenter.
const market = {} as MarketplacePort;
const auth = {} as AuthPort;

const roots: InstallRootsPort = {
  savedGames: () => "C:\\Users\\pilot\\Saved Games\\DCS",
  gameInstall: () => undefined,
  dataDir: () => DATA_DIR,
};

let onChange: (() => void) | undefined;
const launched: string[] = [];
const launcher = {
  setOnChange: (fn: () => void) => {
    onChange = fn;
  },
  isRunning: () => false,
  launch: (key: string) => void launched.push(key),
  stop: () => {},
} as unknown as ProcessLauncher;

const globalState = new Map<string, unknown>();
const context = () =>
  ({
    extensionUri: vscode.Uri.file("C:\\ext"),
    subscriptions: [],
    globalState: {
      get: (key: string) => globalState.get(key),
      update: async (key: string, value: unknown) => void globalState.set(key, value),
    },
  }) as unknown as vscode.ExtensionContext;

/**
 * Messages are handled as `(m) => void this.presenter.handle(m)`, so receive()
 * resolves before the work behind it finishes; flush a macro task first.
 */
const flush = () => new Promise((r) => setTimeout(r, 0));

async function show() {
  MyModsPanel.show(context(), service, ledger, market, launcher, roots, auth);
  await flush();
  return state.panels[state.panels.length - 1];
}

/** The command the panel last asked the editor to run. */
const lastCommand = () => state.executedCommands[state.executedCommands.length - 1];

beforeEach(() => {
  resetVscode({
    config: { "dcsStudio.dataDir": DATA_DIR },
    extensions: {
      "flying-dice.dcs-studio": {
        packageJSON: { version: "0.16.0", bugs: { url: "https://github.com/o/r/issues" } },
      },
    },
  });
  subs = [sub()];
  enableThrows = undefined;
  corruptNotice = undefined;
  launched.length = 0;
  globalState.clear();
  onChange = undefined;
  MyModsPanel.current = undefined;
});

describe("opening the panel", () => {
  it("draws the installed mods, with the configured data dir and escape hatch", async () => {
    const panel = await show();

    expect(panel.viewType).toBe("dcsStudio.myMods");
    expect(panel.title).toBe("My Mods");
    expect(panel.webview.postedOfType("init").at(-1)).toMatchObject({
      dataDir: DATA_DIR,
      uninstallBat: UNINSTALL_BAT,
      mods: [expect.objectContaining({ repo: "Owner/Mod", linkCount: 1 })],
    });
  });

  it("opens beside the active editor rather than always in column one", async () => {
    Object.assign(vscode.window, { activeTextEditor: { viewColumn: 2 } });
    const panel = await show();
    expect(panel.showOptions).toBe(2);
    Object.assign(vscode.window, { activeTextEditor: undefined });
  });

  it("reveals and re-reads the open panel instead of opening a second", async () => {
    // Two panels would show divergent enable/running state for the same mods.
    const panel = await show();
    const before = panel.webview.postedOfType("init").length;
    MyModsPanel.show(context(), service, ledger, market, launcher, roots, auth);
    await flush();

    expect(state.panels).toHaveLength(1);
    expect(panel.webview.postedOfType("init").length).toBe(before + 1);
  });

  it("renders a nonce-locked document that loads the My Mods assets", async () => {
    const panel = await show();
    expect(panel.webview.html).toContain("mymods.js");
    expect(panel.webview.html).toContain("mymods.css");
    expect(panel.webview.html).toContain("default-src 'none'");
  });

  it("re-reads the list when a tracked process exits on its own", async () => {
    const panel = await show();
    const before = panel.webview.postedOfType("init").length;
    onChange?.();
    await flush();

    expect(panel.webview.postedOfType("init").length).toBe(before + 1);
  });

  it("clears the singleton and stops listening for process exits on close", async () => {
    const panel = await show();
    panel.dispose();
    const before = panel.webview.posted.length;
    onChange?.(); // an entrypoint exiting after the panel closed
    await flush();

    expect(MyModsPanel.current).toBeUndefined();
    expect(panel.webview.posted).toHaveLength(before);
  });

  it("re-opens after being closed", async () => {
    (await show()).dispose();
    await show();
    expect(state.panels).toHaveLength(2);
  });

  it("routes a webview message into the presenter", async () => {
    const panel = await show();
    const before = panel.webview.postedOfType("init").length;
    await panel.webview.receive({ type: "refresh" });
    await flush();

    expect(panel.webview.postedOfType("init").length).toBe(before + 1);
  });
});

describe("the effects the presenter describes", () => {
  it("shows a confirmation as an information message", async () => {
    const panel = await show();
    await panel.webview.receive({ type: "enable", repo: "Owner/Mod" });
    await flush();

    expect(state.info).toEqual(["Enabled Owner/Mod."]);
  });

  it("shows the unreadable-ledger notice as a warning", async () => {
    corruptNotice = `${DATA_DIR}\\subscriptions.json.corrupt`;
    await show();

    expect(state.warnings[0]).toContain(`${DATA_DIR}\\subscriptions.json.corrupt`);
  });

  it("shows a failure through showError, so it carries Report Issue", async () => {
    enableThrows = new Error("EPERM: symlink is locked");
    const panel = await show();
    await panel.webview.receive({ type: "enable", repo: "Owner/Mod" });
    await flush();

    expect(state.errors).toEqual(["Enabled failed: EPERM: symlink is locked"]);
  });

  it("opens an external link through the editor", async () => {
    const panel = await show();
    await panel.webview.receive({ type: "openExternal", url: "https://github.com/Owner/Mod" });
    await flush();

    expect(state.openedExternal).toEqual(["https://github.com/Owner/Mod"]);
  });

  it("opens the requested docs page", async () => {
    const panel = await show();
    await panel.webview.receive({ type: "openDocs", page: "entrypoints" });
    await flush();

    expect(state.executedCommands).toEqual([{ command: "dcs.docs.open", args: ["entrypoints"] }]);
  });

  it("reveals a path in the OS file explorer as a file Uri", async () => {
    const panel = await show();
    await panel.webview.receive({ type: "openDir", repo: "Owner/Mod" });
    await flush();

    expect(lastCommand().command).toBe("revealFileInOS");
    expect((lastCommand().args[0] as { fsPath: string }).fsPath).toBe(`${DATA_DIR}\\owner-mod`);
  });

  it("hands the shortcut request to the command that owns it", async () => {
    const panel = await show();
    await panel.webview.receive({ type: "createShortcut" });
    await flush();

    expect(state.executedCommands).toEqual([{ command: "dcs.mymods.createShortcut", args: [] }]);
  });

  it("runs the clean-uninstall script in a visible terminal once confirmed", async () => {
    state.messageReplies.push("Run uninstall-all.bat");
    const panel = await show();
    await panel.webview.receive({ type: "cleanUninstall" });
    await flush();

    expect(state.createdTerminals).toHaveLength(1);
    expect(state.createdTerminals[0].sent).toEqual([`& "${UNINSTALL_BAT}"`]);
  });
});

describe("the questions and the memento", () => {
  it("asks the presenter's question as a modal and answers with the choice", async () => {
    state.messageReplies.push("Launch");
    const panel = await show();
    await panel.webview.receive({ type: "launch", repo: "Owner/Mod", id: "gui" });
    await flush();

    expect(state.warnings[0]).toBe('Launch "Config GUI" from Owner/Mod?');
    expect(launched).toEqual(["owner/mod::gui"]);
  });

  it("treats a dismissed question as no answer", async () => {
    state.messageReplies.push(undefined);
    const panel = await show();
    await panel.webview.receive({ type: "launch", repo: "Owner/Mod", id: "gui" });
    await flush();

    expect(launched).toEqual([]);
  });

  it("persists 'always allow' in globalState and reads it back", async () => {
    // Consent has to outlive the panel — a memento is the only store here that
    // survives a reload, and a launch that re-asks every time trains the user
    // to click through the one prompt that matters.
    state.messageReplies.push("Always allow for this mod");
    const first = await show();
    await first.webview.receive({ type: "launch", repo: "Owner/Mod", id: "gui" });
    await flush();
    expect(globalState.get("dcs.entrypointConsent.owner/mod:gui")).toBe(true);

    first.dispose();
    const second = await show();
    await second.webview.receive({ type: "launch", repo: "Owner/Mod", id: "gui" });
    await flush();

    expect(state.warnings).toHaveLength(1); // not asked again
    expect(launched).toHaveLength(2);
  });
});
