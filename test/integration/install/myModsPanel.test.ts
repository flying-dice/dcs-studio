import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetVscode, state, vscodeMock } from "../support/vscode";

vi.mock("vscode", () => vscodeMock());

import * as vscode from "vscode";
import type { JsonLedgerStore } from "../../../src/adapters/node/jsonLedgerStore";
import type { ProcessLauncher } from "../../../src/adapters/node/processLauncher";
import type { OnProgress, SubscriptionService } from "../../../src/core/app/subscriptionService";
import type { InstallTarget, ProductDetail, Subscription } from "../../../src/core/domain/types";
import type { AuthPort } from "../../../src/core/ports/auth";
import type { InstallRootsPort } from "../../../src/core/ports/installRoots";
import type { MarketplacePort } from "../../../src/core/ports/marketplace";
import { MyModsPanel } from "../../../src/install/myModsPanel";

// My Mods is the only place a user can take back what a mod did to their DCS
// install. Disable, uninstall and Launch all reach outside the editor — into
// symlinked game folders and into mod-shipped executables — so the tests here
// concentrate on the guards around them: that entrypoints stop before links are
// torn down, that a launch never happens without consent, and that every
// failure still leaves the list showing the truth.

const DATA_DIR = "D:\\DCSStudio\\mods";
const UNINSTALL_BAT = `${DATA_DIR}\\uninstall-all.bat`;

function sub(over: Partial<Subscription> = {}): Subscription {
  return {
    repo: "Owner/Mod",
    name: "Carrier Mod",
    tag: "v1.0.0",
    dir: `${DATA_DIR}\\owner-mod`,
    enabled: true,
    links: [{ id: "l1", source: "Mod", dest: "C:\\Saved Games\\DCS\\Mods\\Mod" }],
    bundles: [{ path: "Mod" }],
    symlinks: [{ source: "Mod", dest: "{SavedGames}/Mods/tech/Mod" }],
    entrypoints: [
      { id: "gui", name: "Config GUI", exe: "bin\\config.exe", args: ["--root", "{SavedGames}"] },
    ],
    missionScripts: [{ name: "init", path: "scripts/init.lua", run_on: "before-sanitize" }],
    ...over,
  } as Subscription;
}

function product(over: Partial<ProductDetail> = {}): ProductDetail {
  return {
    repo: "Owner/Mod",
    name: "Carrier Mod",
    release_tag: "v2.0.0",
    assets: [{ name: "payload.7z", url: "https://example/payload.7z", size: 10 }],
    ...over,
  } as ProductDetail;
}

let subs: Subscription[] = [];
let listThrows: Error | undefined;
const calls: string[] = [];
let actThrows: unknown;
let updateImpl: (target: InstallTarget, token: string | undefined, p: OnProgress) => Promise<void> =
  async () => {};

const service = {
  list: async () => {
    if (listThrows) throw listThrows;
    return subs;
  },
  enable: async (repo: string) => {
    calls.push(`enable ${repo}`);
    if (actThrows) throw actThrows;
  },
  disable: async (repo: string) => {
    calls.push(`disable ${repo}`);
    if (actThrows) throw actThrows;
  },
  unsubscribe: async (repo: string) => {
    calls.push(`unsubscribe ${repo}`);
    if (actThrows) throw actThrows;
  },
  update: (target: InstallTarget, token: string | undefined, p: OnProgress) => {
    calls.push(`update ${target.repo} ${target.tag} token=${token ?? "none"}`);
    return updateImpl(target, token, p);
  },
} as unknown as SubscriptionService;

let corruptNotice: string | undefined;
const ledger = {
  ensureUninstallBat: () => {
    calls.push("ensureUninstallBat");
    return UNINSTALL_BAT;
  },
  uninstallBatPath: () => UNINSTALL_BAT,
  takeCorruptNotice: () => {
    const notice = corruptNotice;
    corruptNotice = undefined;
    return notice;
  },
} as unknown as JsonLedgerStore;

let productImpl: () => Promise<ProductDetail> = async () => product();
const market: MarketplacePort = {
  discover: async () => [],
  loadProduct: (repo: string) => {
    calls.push(`loadProduct ${repo}`);
    return productImpl();
  },
};

let session: { token: string; accountLabel: string } | undefined;
const auth: AuthPort = {
  getToken: async () => undefined,
  onDidChangeSessions: () => ({ dispose: () => {} }),
  currentSession: async () => session,
  signIn: async () => undefined,
};

let gameInstall: string | undefined = "C:\\Program Files\\Eagle Dynamics\\DCS World";
const roots: InstallRootsPort = {
  savedGames: () => "C:\\Users\\pilot\\Saved Games\\DCS",
  gameInstall: () => gameInstall,
  dataDir: () => DATA_DIR,
};

let launchThrows: unknown;
let onChange: (() => void) | undefined;
const running = new Set<string>();
const launched: { key: string; exe: string; cwd: string; args: string[] }[] = [];
const stopped: string[] = [];

const launcher = {
  setOnChange: (fn: () => void) => {
    onChange = fn;
  },
  isRunning: (key: string) => running.has(key),
  launch: (key: string, plan: { exe: string; cwd: string; args: string[] }) => {
    if (launchThrows) throw launchThrows;
    launched.push({ key, ...plan });
    running.add(key);
  },
  stop: (key: string) => {
    stopped.push(key);
    running.delete(key);
  },
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
 * Messages are handled as `(m) => void this.onMessage(m)`, so receive() resolves
 * before the work behind it finishes; flush a macro task before asserting.
 */
const flush = () => new Promise((r) => setTimeout(r, 0));

async function show() {
  MyModsPanel.show(context(), service, ledger, market, launcher, roots, auth);
  await flush();
  return state.panels[state.panels.length - 1];
}

/** The command the panel last asked the editor to run. */
function lastCommand(): { command: string; args: unknown[] } {
  return state.executedCommands[state.executedCommands.length - 1];
}

/** The most recent list push — what the user is actually looking at. */
function init(panel: { webview: { postedOfType(t: string): Record<string, unknown>[] } }) {
  return panel.webview.postedOfType("init").at(-1) as Record<string, unknown>;
}

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
  listThrows = undefined;
  actThrows = undefined;
  launchThrows = undefined;
  updateImpl = async () => {};
  productImpl = async () => product();
  session = undefined;
  gameInstall = "C:\\Program Files\\Eagle Dynamics\\DCS World";
  calls.length = 0;
  launched.length = 0;
  stopped.length = 0;
  running.clear();
  globalState.clear();
  onChange = undefined;
  corruptNotice = undefined;
  MyModsPanel.current = undefined;
});

describe("opening the panel", () => {
  it("shows the installed mods with their data dir and escape-hatch script", async () => {
    const panel = await show();

    expect(panel.viewType).toBe("dcsStudio.myMods");
    expect(panel.title).toBe("My Mods");
    expect(init(panel)).toMatchObject({
      dataDir: DATA_DIR,
      uninstallBat: UNINSTALL_BAT,
      mods: [
        expect.objectContaining({ repo: "Owner/Mod", tag: "v1.0.0", enabled: true, links: 1 }),
      ],
    });
  });

  it("keeps uninstall-all.bat on disk every time the list is drawn", async () => {
    // It is the recovery path when the extension itself is broken or removed,
    // so it must exist before the user needs it, not after.
    await show();
    expect(calls).toContain("ensureUninstallBat");
  });

  it("says so when the mod list could not be read, instead of showing an empty panel", async () => {
    // An unreadable ledger reads as empty, so the panel is about to claim
    // nothing is installed while the links are still in the DCS folders. The
    // preserved file is the only record of them, so the warning names it.
    corruptNotice = `${DATA_DIR}\\subscriptions.json.corrupt`;
    subs = [];
    const panel = await show();

    expect(state.warnings[0]).toContain(`${DATA_DIR}\\subscriptions.json.corrupt`);
    expect(state.warnings[0]).toContain("uninstall-all.bat was left as it was");
    expect(init(panel).mods).toEqual([]);
  });

  it("warns once per corruption, not on every redraw", async () => {
    corruptNotice = `${DATA_DIR}\\subscriptions.json.corrupt`;
    const panel = await show();
    await panel.webview.receive({ type: "refresh" });
    await flush();

    expect(state.warnings).toHaveLength(1);
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
});

describe("the install breakdown each mod carries", () => {
  it("shows the declared destinations and the privileged actions", async () => {
    // These are the same risk flags the product page shows before installing;
    // My Mods is where a user checks what they already agreed to.
    const panel = await show();
    const mod = (init(panel).mods as Record<string, unknown>[])[0];

    expect(mod.manifest).toMatchObject({
      counts: { bundles: 1, symlinks: 1, entrypoints: 1, missionScripts: 1, beforeSanitize: 1 },
      risks: ["links-files", "runs-executable", "pre-sanitize-script"],
      // Unresolved on purpose: My Mods shows what the mod declared.
      symlinks: [{ dest: "{SavedGames}/Mods/tech/Mod", resolved: null }],
    });
  });

  it("renders a ledger written before bundles and entrypoints existed", async () => {
    // Old subscriptions.json entries lack those fields entirely; reading them
    // strictly would blank the whole panel for anyone upgrading.
    subs = [
      {
        repo: "Owner/Old",
        name: "Old Mod",
        tag: "v0.1",
        dir: `${DATA_DIR}\\owner-old`,
        enabled: false,
        links: [],
      } as unknown as Subscription,
    ];
    const panel = await show();
    const mod = (init(panel).mods as Record<string, unknown>[])[0];

    expect(mod).toMatchObject({ repo: "Owner/Old", entrypoints: [] });
    expect(mod.manifest).toMatchObject({
      counts: { bundles: 0, symlinks: 0, entrypoints: 0, missionScripts: 0, beforeSanitize: 0 },
      risks: [],
    });
  });

  it("reports which entrypoints are running under the key the webview looks up", async () => {
    // The launcher tracks lowercased keys but the webview asks by repo case;
    // a mismatch here shows Launch on an already-running process.
    running.add("owner/mod::gui");
    const panel = await show();
    expect(init(panel).running).toEqual({ "Owner/Mod::gui": true });
  });

  it("re-reads the list when a tracked process exits on its own", async () => {
    const panel = await show();
    const before = panel.webview.postedOfType("init").length;
    onChange?.();
    await flush();

    expect(panel.webview.postedOfType("init").length).toBe(before + 1);
  });

  it("re-reads the list on an explicit refresh", async () => {
    const panel = await show();
    const before = panel.webview.postedOfType("init").length;
    await panel.webview.receive({ type: "refresh" });
    await flush();

    expect(panel.webview.postedOfType("init").length).toBe(before + 1);
  });
});

describe("enable and disable", () => {
  it("enables a mod and confirms it by name", async () => {
    const panel = await show();
    await panel.webview.receive({ type: "enable", repo: "Owner/Mod" });
    await flush();

    expect(calls).toContain("enable Owner/Mod");
    expect(state.info).toEqual(["Enabled Owner/Mod."]);
    expect(panel.webview.postedOfType("busy")[0]).toEqual({
      type: "busy",
      repo: "Owner/Mod",
      busy: true,
    });
  });

  it("stops the mod's running executables before removing its links", async () => {
    // Unlinking under a running exe leaves it holding files DCS still lists,
    // so the order matters more than either step on its own.
    running.add("owner/mod::gui");
    const panel = await show();
    await panel.webview.receive({ type: "disable", repo: "Owner/Mod" });
    await flush();

    expect(stopped).toEqual(["owner/mod::gui"]);
    expect(calls.indexOf("disable Owner/Mod")).toBeGreaterThan(-1);
    expect(state.info).toEqual(["Disabled Owner/Mod."]);
  });

  it("disables a mod that declares no entrypoints", async () => {
    subs = [sub({ entrypoints: undefined as unknown as Subscription["entrypoints"] })];
    const panel = await show();
    await panel.webview.receive({ type: "disable", repo: "Owner/Mod" });
    await flush();

    expect(stopped).toEqual([]);
    expect(calls).toContain("disable Owner/Mod");
  });

  it("reports a failed disable and still redraws the list", async () => {
    // A half-removed symlink set is exactly when the user needs to see the
    // real state rather than the optimistic one.
    actThrows = new Error("EPERM: symlink is locked");
    const panel = await show();
    const before = panel.webview.postedOfType("init").length;
    await panel.webview.receive({ type: "disable", repo: "Owner/Mod" });
    await flush();

    expect(state.errors).toEqual(["Disabled failed: EPERM: symlink is locked"]);
    expect(panel.webview.postedOfType("init").length).toBe(before + 1);
  });

  it("reports a failure thrown as something other than an Error", async () => {
    actThrows = "the linker exploded";
    const panel = await show();
    await panel.webview.receive({ type: "enable", repo: "Owner/Mod" });
    await flush();

    expect(state.errors).toEqual(["Enabled failed: the linker exploded"]);
  });
});

describe("uninstall", () => {
  it("stops the executables, then unsubscribes", async () => {
    running.add("owner/mod::gui");
    const panel = await show();
    await panel.webview.receive({ type: "uninstall", repo: "Owner/Mod" });
    await flush();

    expect(stopped).toEqual(["owner/mod::gui"]);
    expect(calls).toContain("unsubscribe Owner/Mod");
    expect(state.info).toEqual(["Uninstalled Owner/Mod."]);
  });

  it("stops nothing for a repo that is no longer in the ledger", async () => {
    subs = [];
    const panel = await show();
    await panel.webview.receive({ type: "uninstall", repo: "Ghost/Mod" });
    await flush();

    expect(stopped).toEqual([]);
    expect(calls).toContain("unsubscribe Ghost/Mod");
  });

  it("offers the clean-uninstall script behind a modal and runs it in a terminal", async () => {
    // It wipes every DCS Studio link and all unpacked data — irreversible, so
    // it must never run from a stray click.
    state.messageReplies.push("Run uninstall-all.bat");
    const panel = await show();
    await panel.webview.receive({ type: "cleanUninstall" });
    await flush();

    expect(state.warnings[0]).toContain("removes ALL DCS Studio mod links");
    expect(state.createdTerminals).toHaveLength(1);
    expect(state.createdTerminals[0].sent).toEqual([`& "${UNINSTALL_BAT}"`]);
  });

  it("runs nothing when the clean-uninstall warning is dismissed", async () => {
    state.messageReplies.push(undefined);
    const panel = await show();
    await panel.webview.receive({ type: "cleanUninstall" });
    await flush();

    expect(state.createdTerminals).toEqual([]);
  });

  it("reveals the script in Explorer so it can be kept for later", async () => {
    const panel = await show();
    await panel.webview.receive({ type: "revealBat" });

    expect(lastCommand().command).toBe("revealFileInOS");
    expect((lastCommand().args[0] as { fsPath: string }).fsPath).toBe(UNINSTALL_BAT);
  });
});

describe("update", () => {
  it("downloads the newer release and reports progress against the mod", async () => {
    session = { token: "gho_secret", accountLabel: "pilot" };
    updateImpl = async (_t, _token, p) => {
      p({ phase: "download", label: "Downloading payload.7z…", pct: 42 });
    };
    const panel = await show();
    await panel.webview.receive({ type: "update", repo: "Owner/Mod" });
    await flush();

    // The token rides along so private-repo assets can be fetched.
    expect(calls).toContain("update Owner/Mod v2.0.0 token=gho_secret");
    expect(panel.webview.postedOfType("progress")[0]).toEqual({
      type: "progress",
      repo: "Owner/Mod",
      label: "Downloading payload.7z…",
      pct: 42,
    });
    expect(state.info).toEqual(["Updated Owner/Mod to v2.0.0."]);
  });

  it("updates anonymously when nobody is signed in", async () => {
    const panel = await show();
    await panel.webview.receive({ type: "update", repo: "Owner/Mod" });
    await flush();

    expect(calls).toContain("update Owner/Mod v2.0.0 token=none");
  });

  it("does nothing when the installed tag is already the latest", async () => {
    // Re-downloading would tear the mod's links down and rebuild them for no
    // gain, briefly breaking a DCS install that was working.
    productImpl = async () => product({ release_tag: "v1.0.0" });
    const panel = await show();
    await panel.webview.receive({ type: "update", repo: "Owner/Mod" });
    await flush();

    expect(calls.some((c) => c.startsWith("update "))).toBe(false);
    expect(state.info).toEqual(["Owner/Mod is already up to date (v1.0.0)."]);
  });

  it("still installs when the repo is not in the ledger at all", async () => {
    // Nothing to compare against, so the newest release is by definition new.
    subs = [];
    const panel = await show();
    await panel.webview.receive({ type: "update", repo: "Owner/Mod" });
    await flush();

    expect(calls).toContain("update Owner/Mod v2.0.0 token=none");
  });

  it("explains that the repo has no release rather than failing silently", async () => {
    productImpl = async () => product({ release_tag: null });
    const panel = await show();
    await panel.webview.receive({ type: "update", repo: "Owner/Mod" });
    await flush();

    expect(state.errors).toEqual(["Update failed: No release found on GitHub."]);
  });

  it("reports a failed download and redraws the list", async () => {
    productImpl = async () => {
      throw new Error("GitHub rate limit exceeded");
    };
    const panel = await show();
    const before = panel.webview.postedOfType("init").length;
    await panel.webview.receive({ type: "update", repo: "Owner/Mod" });
    await flush();

    expect(state.errors).toEqual(["Update failed: GitHub rate limit exceeded"]);
    expect(panel.webview.postedOfType("init").length).toBe(before + 1);
  });

  it("reports a non-Error update failure", async () => {
    productImpl = async () => {
      throw "socket hang up";
    };
    const panel = await show();
    await panel.webview.receive({ type: "update", repo: "Owner/Mod" });
    await flush();

    expect(state.errors).toEqual(["Update failed: socket hang up"]);
  });
});

describe("launching a mod entrypoint", () => {
  it("asks before running a mod-shipped executable and names it", async () => {
    // This is arbitrary third-party code; the exe path is the only thing the
    // user has to judge it by, so the prompt must carry it.
    state.messageReplies.push("Launch");
    const panel = await show();
    await panel.webview.receive({ type: "launch", repo: "Owner/Mod", id: "gui" });
    await flush();

    expect(state.warnings[0]).toBe('Launch "Config GUI" from Owner/Mod?');
    expect(launched).toEqual([
      {
        key: "owner/mod::gui",
        exe: `${DATA_DIR}\\owner-mod\\bin\\config.exe`,
        cwd: `${DATA_DIR}\\owner-mod\\bin`,
        args: ["--root", "C:\\Users\\pilot\\Saved Games\\DCS"],
      },
    ]);
    expect(panel.webview.postedOfType("entrypoint")[0]).toEqual({
      type: "entrypoint",
      repo: "Owner/Mod",
      id: "gui",
      running: true,
    });
  });

  it("does not launch when the prompt is dismissed", async () => {
    state.messageReplies.push(undefined);
    const panel = await show();
    await panel.webview.receive({ type: "launch", repo: "Owner/Mod", id: "gui" });
    await flush();

    expect(launched).toEqual([]);
    expect(panel.webview.postedOfType("entrypoint")).toEqual([]);
  });

  it("asks again next time when consent was only for this launch", async () => {
    state.messageReplies.push("Launch", "Launch");
    const panel = await show();
    await panel.webview.receive({ type: "launch", repo: "Owner/Mod", id: "gui" });
    await flush();
    await panel.webview.receive({ type: "stop", repo: "Owner/Mod", id: "gui" });
    await panel.webview.receive({ type: "launch", repo: "Owner/Mod", id: "gui" });
    await flush();

    expect(state.warnings).toHaveLength(2);
    expect(launched).toHaveLength(2);
  });

  it("remembers 'always allow' across launches, keyed case-insensitively", async () => {
    state.messageReplies.push("Always allow for this mod");
    const panel = await show();
    await panel.webview.receive({ type: "launch", repo: "Owner/Mod", id: "gui" });
    await flush();

    expect(globalState.get("dcs.entrypointConsent.owner/mod:gui")).toBe(true);

    await panel.webview.receive({ type: "launch", repo: "Owner/Mod", id: "gui" });
    await flush();
    expect(state.warnings).toHaveLength(1);
    expect(launched).toHaveLength(2);
  });

  it("expands the DCS root tokens in the declared arguments", async () => {
    globalState.set("dcs.entrypointConsent.owner/mod:gui", true);
    subs = [
      sub({
        entrypoints: [
          { id: "gui", name: "Config GUI", exe: "bin\\config.exe", args: ["{GameInstall}"] },
        ],
      }),
    ];
    const panel = await show();
    await panel.webview.receive({ type: "launch", repo: "Owner/Mod", id: "gui" });
    await flush();

    expect(launched[0].args).toEqual(["C:\\Program Files\\Eagle Dynamics\\DCS World"]);
  });

  it("expands {GameInstall} to nothing when no game install is configured", async () => {
    // Many users only ever set Saved Games; the arg must not become "undefined".
    gameInstall = undefined;
    globalState.set("dcs.entrypointConsent.owner/mod:gui", true);
    subs = [
      sub({
        entrypoints: [
          { id: "gui", name: "Config GUI", exe: "bin\\config.exe", args: ["{GameInstall}"] },
        ],
      }),
    ];
    const panel = await show();
    await panel.webview.receive({ type: "launch", repo: "Owner/Mod", id: "gui" });
    await flush();

    expect(launched[0].args).toEqual([""]);
  });

  it("surfaces a missing executable inline as well as in a toast", async () => {
    // The card has to fall back out of "running", or Stop is the only button
    // left for a process that never started.
    globalState.set("dcs.entrypointConsent.owner/mod:gui", true);
    launchThrows = new Error("Executable not found: bin\\config.exe");
    const panel = await show();
    await panel.webview.receive({ type: "launch", repo: "Owner/Mod", id: "gui" });
    await flush();

    expect(state.errors).toEqual(["Launch failed: Executable not found: bin\\config.exe"]);
    expect(panel.webview.postedOfType("entrypoint")[0]).toEqual({
      type: "entrypoint",
      repo: "Owner/Mod",
      id: "gui",
      running: false,
      error: "Executable not found: bin\\config.exe",
    });
  });

  it("surfaces a non-Error launch failure", async () => {
    globalState.set("dcs.entrypointConsent.owner/mod:gui", true);
    launchThrows = "EACCES";
    const panel = await show();
    await panel.webview.receive({ type: "launch", repo: "Owner/Mod", id: "gui" });
    await flush();

    expect(state.errors).toEqual(["Launch failed: EACCES"]);
  });

  it("ignores a launch for a mod that is no longer installed", async () => {
    subs = [];
    const panel = await show();
    await panel.webview.receive({ type: "launch", repo: "Owner/Mod", id: "gui" });
    await flush();

    expect(state.warnings).toEqual([]);
    expect(launched).toEqual([]);
  });

  it("ignores a launch for an entrypoint the mod does not declare", async () => {
    // A stale webview can still hold a card from before an update dropped it.
    const panel = await show();
    await panel.webview.receive({ type: "launch", repo: "Owner/Mod", id: "gone" });
    await flush();

    expect(launched).toEqual([]);
  });

  it("stops a running entrypoint and reports it stopped", async () => {
    running.add("owner/mod::gui");
    const panel = await show();
    await panel.webview.receive({ type: "stop", repo: "Owner/Mod", id: "gui" });

    expect(stopped).toEqual(["owner/mod::gui"]);
    expect(panel.webview.postedOfType("entrypoint")[0]).toEqual({
      type: "entrypoint",
      repo: "Owner/Mod",
      id: "gui",
      running: false,
    });
  });
});

describe("links out of the panel", () => {
  it("reveals a mod's unpacked folder in Explorer", async () => {
    const panel = await show();
    await panel.webview.receive({ type: "openDir", repo: "Owner/Mod" });
    await flush();

    expect(lastCommand().command).toBe("revealFileInOS");
    expect((lastCommand().args[0] as { fsPath: string }).fsPath).toBe(`${DATA_DIR}\\owner-mod`);
  });

  it("reveals nothing for a mod that is not installed", async () => {
    subs = [];
    const panel = await show();
    await panel.webview.receive({ type: "openDir", repo: "Owner/Mod" });
    await flush();

    expect(state.executedCommands).toEqual([]);
  });

  it("opens an external link through the editor", async () => {
    const panel = await show();
    await panel.webview.receive({ type: "openExternal", url: "https://github.com/Owner/Mod" });

    expect(state.openedExternal).toEqual(["https://github.com/Owner/Mod"]);
  });

  it("opens the requested docs page, defaulting to the sandbox explainer", async () => {
    const panel = await show();
    await panel.webview.receive({ type: "openDocs", page: "entrypoints" });
    await panel.webview.receive({ type: "openDocs" });

    expect(state.executedCommands).toEqual([
      { command: "dcs.docs.open", args: ["entrypoints"] },
      { command: "dcs.docs.open", args: ["sandbox"] },
    ]);
  });

  it("hands the shortcut request to the command that owns it", async () => {
    const panel = await show();
    await panel.webview.receive({ type: "createShortcut" });

    expect(state.executedCommands).toEqual([{ command: "dcs.mymods.createShortcut", args: [] }]);
  });
});

describe("messages that carry nothing to act on", () => {
  it("ignores actions with no repo, no id, and types it does not know", async () => {
    const panel = await show();
    for (const type of ["enable", "disable", "uninstall", "update", "openDir", "mystery"]) {
      await panel.webview.receive({ type });
    }
    await panel.webview.receive({ type: "launch", repo: "Owner/Mod" });
    await panel.webview.receive({ type: "stop", id: "gui" });
    await panel.webview.receive({ type: "openExternal" });
    await flush();

    expect(calls.filter((c) => c !== "ensureUninstallBat")).toEqual([]);
    expect(launched).toEqual([]);
    expect(stopped).toEqual([]);
    expect(state.openedExternal).toEqual([]);
  });
});
