import { readFileSync } from "node:fs";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tmpRoot } from "../../support/tmpDir";
import { mappedBridgeFs } from "../bridge/mappedBridgeFs";
import {
  type FakeWebviewPanel,
  fireDocumentOpened,
  resetVscode,
  seedFile,
  state,
  vscodeMock,
} from "../support/vscode";

vi.mock("vscode", () => vscodeMock());

// The two bridge sockets activation opens are the only unavoidable I/O in the
// composition root: `activate()` starts them unconditionally, and a real TCP
// connect to 127.0.0.1:25569 would make every test here depend on what happens
// to be listening on the machine. The rest of the wiring stays real.
const transport = vi.hoisted(() => ({ conns: [] as FakeConn[] }));
vi.mock("../../../src/adapters/node/wsTransport", () => ({
  WsBridgeTransport: class {
    connect(endpoint: FakeConn["endpoint"], handlers: FakeConn["handlers"]): FakeConn {
      const conn: FakeConn = {
        endpoint,
        handlers,
        sent: [],
        closed: false,
        send: (text: string) => conn.sent.push(text),
        close: () => {
          conn.closed = true;
        },
      };
      transport.conns.push(conn);
      return conn;
    }
  },
}));

// Creating the shortcut shells out to PowerShell and writes a .lnk into the
// user's real Desktop, so the composition root's job — routing the command at
// it with the extension context — is asserted instead of performed.
const shortcut = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock("../../../src/install/shortcut", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/install/shortcut")>()),
  createMyModsShortcut: (ctx: unknown) => {
    shortcut.calls.push(ctx);
    return Promise.resolve();
  },
}));

import * as vscode from "vscode";
import { ConsolePanel } from "../../../src/bridge/consolePanel";
import { DocsPanel } from "../../../src/docs/docsPanel";
import { activate } from "../../../src/extension";
import { MyModsPanel } from "../../../src/install/myModsPanel";
import { LogPanel } from "../../../src/log/logPanel";
import { MarketplacePanel } from "../../../src/marketplace/panel";
import { NewProjectPanel } from "../../../src/project/newProjectPanel";
import { PublishPanel } from "../../../src/publish/publishPanel";
import { SetupPanel } from "../../../src/setup/panel";
import { SkillsPanel } from "../../../src/skills/skillsPanel";

// `extension.ts` is the composition root: the one place adapters are chosen and
// handed to the panels, and the one place ~29 command ids become live handlers.
// Nothing else in the suite can see across that seam — every other spec is
// handed its collaborators — so a service constructed with the wrong adapter,
// a command whose handler never gets registered, or a hand-off breadcrumb that
// stops being read all look exactly like working code until someone clicks.
//
// These tests really call `activate()` and then drive the handlers it
// registered, asserting the user-visible outcome: which panel opens, what the
// status bar says, where the bridge connects, what a deep link does.

interface FakeConn {
  endpoint: { host: string; port: number; path: string };
  handlers: {
    onOpen?: () => void;
    onMessage?: (text: string) => void;
    onClose?: (code: number, reason: string) => void;
    onError?: (e: Error) => void;
  };
  sent: string[];
  closed: boolean;
  send(text: string): void;
  close(): void;
}

const EXT = "C:\\ext";
const PROJECT = "C:\\proj";
const MANIFEST = `${PROJECT}\\dcs-studio.toml`;
const SAVED_GAMES = "D:\\Saved Games\\DCS";
const PENDING_OPEN_KEY = "dcs.pendingProjectOpen";
const PENDING_MYMODS_KEY = "dcs.pendingMyMods";

const repoRoot = nodePath.resolve(__dirname, "../../..");
const declaredCommands: string[] = JSON.parse(
  readFileSync(nodePath.join(repoRoot, "package.json"), "utf8"),
).contributes.commands.map((c: { command: string }) => c.command);

// My Mods regenerates uninstall-all.bat on the real filesystem through the
// ledger adapter, so point the data dir somewhere disposable — one directory
// for the whole suite, as the ledger it accumulates is.
const dataDir = tmpRoot("dcs-studio-activation-", { scope: "suite" }).path;
/** The temp root the mapped bridge filesystem writes DCS paths into. */
const bridge = tmpRoot("dcs-studio-bridge-");
let io: ReturnType<typeof mappedBridgeFs>;

let contexts: vscode.ExtensionContext[] = [];
let globalStore: Map<string, unknown>;
let workspaceStore: Map<string, unknown>;

function memento(store: Map<string, unknown>) {
  return {
    get: (key: string, fallback?: unknown) => (store.has(key) ? store.get(key) : fallback),
    update: (key: string, value: unknown) => {
      if (value === undefined) store.delete(key);
      else store.set(key, value);
      return Promise.resolve();
    },
    keys: () => [...store.keys()],
    setKeysForSync: () => {},
  };
}

function makeContext(): vscode.ExtensionContext {
  const ctx = {
    subscriptions: [] as vscode.Disposable[],
    extensionUri: vscode.Uri.file(EXT),
    extensionPath: EXT,
    extensionMode: vscode.ExtensionMode.Production,
    globalState: memento(globalStore),
    workspaceState: memento(workspaceStore),
    globalStorageUri: vscode.Uri.file(`${EXT}\\storage`),
    extension: { id: "flying-dice.dcs-studio", packageJSON: {} },
  } as unknown as vscode.ExtensionContext;
  contexts.push(ctx);
  return ctx;
}

/** Activate and settle the async work activation kicks off (skills, panels). */
async function activateExtension(): Promise<vscode.ExtensionContext> {
  const ctx = makeContext();
  activate(ctx, { bridgeIo: io });
  await flush();
  return ctx;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Invoke a registered command the way VS Code would. */
async function run(command: string, ...args: unknown[]): Promise<void> {
  const handler = state.registeredCommands.get(command);
  expect(handler, `no handler registered for ${command}`).toBeDefined();
  await handler!(...args);
  await flush();
}

const titles = () => state.panels.map((p) => p.title);
const lastPanel = (): FakeWebviewPanel => state.panels[state.panels.length - 1];

/** A text document as the editor hands it to the manifest listeners. */
function doc(fsPath: string, scheme = "file") {
  return {
    uri: {
      fsPath,
      scheme,
      path: `/${fsPath.replace(/\\/g, "/")}`,
      toString: () => `${scheme}://${fsPath}`,
    },
    isDirty: false,
    getText: () => "",
  } as unknown as vscode.TextDocument;
}

beforeEach(() => {
  io = mappedBridgeFs(bridge.path);
  // A configured Saved Games path keeps the first-run nudge (asserted on its
  // own further down) out of every other test's message queue.
  resetVscode({
    config: { "dcsStudio.savedGamesPath": SAVED_GAMES, "dcsStudio.dataDir": dataDir },
    workspaceFolders: [PROJECT],
  });
  globalStore = new Map();
  workspaceStore = new Map();
  contexts = [];
  transport.conns.length = 0;
  shortcut.calls.length = 0;
  (vscode.window as { activeTextEditor?: unknown }).activeTextEditor = undefined;
  MarketplacePanel.current = undefined;
  MyModsPanel.current = undefined;
  SetupPanel.current = undefined;
  PublishPanel.current = undefined;
  SkillsPanel.current = undefined;
  LogPanel.current = undefined;
  ConsolePanel.current = undefined;
  NewProjectPanel.current = undefined;
  DocsPanel.current = undefined;
  vi.stubGlobal("fetch", () =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items: [] }) }),
  );
});

afterEach(() => {
  // Panels own intervals (the console poll) and file tailers; the extension
  // owns the bridge sockets. Both go away with the window in production.
  for (const panel of [...state.panels]) panel.dispose();
  for (const ctx of contexts) for (const d of ctx.subscriptions) d.dispose();
  vi.unstubAllGlobals();
});

describe("activation", () => {
  it("makes every command contributed by package.json callable", async () => {
    await activateExtension();

    // The static contract spec proves each id has a `registerCommand` call
    // somewhere in the source; this proves activation actually reaches them —
    // an early return or a throw part-way through would leave the palette full
    // of "command not found".
    const missing = declaredCommands.filter((id) => !state.registeredCommands.has(id));
    expect(missing).toEqual([]);
  });

  it("opens both in-sim bridges on the default ports", async () => {
    await activateExtension();

    expect(transport.conns.map((c) => c.endpoint)).toEqual([
      { host: "127.0.0.1", port: 25569, path: "/ws" },
      { host: "127.0.0.1", port: 25570, path: "/ws" },
    ]);
  });

  it("honours the configured bridge ports", async () => {
    state.config["dcsStudio.bridgeGuiPort"] = 30001;
    state.config["dcsStudio.bridgeMissionPort"] = 30002;
    await activateExtension();

    // People behind a port conflict change these; reading them at the wrong
    // moment (or not at all) leaves the sim connected but the editor blind.
    expect(transport.conns.map((c) => c.endpoint.port)).toEqual([30001, 30002]);
  });

  it("shows the marketplace entry point in the status bar", async () => {
    await activateExtension();

    const [marketplace] = state.statusBarItems;
    expect(marketplace.text).toBe("$(package) DCS Marketplace");
    expect(marketplace.command).toBe("dcs.marketplace.open");
    expect(marketplace.shown).toBe(true);
  });

  it("reflects the live bridge status in the status bar", async () => {
    await activateExtension();
    const [, bridgeStatus] = state.statusBarItems;

    expect(bridgeStatus.command).toBe("dcs.bridge.statusBarClick");
    expect(bridgeStatus.shown).toBe(true);
    expect(bridgeStatus.text).toBe("$(debug-disconnect) DCS: offline");

    transport.conns[0].handlers.onOpen?.();
    expect(bridgeStatus.text).toBe("$(plug) DCS: at menu");
    expect(bridgeStatus.tooltip).toContain("GUI bridge connected");
  });

  it("closes the bridge sockets when the extension is disposed", async () => {
    const ctx = await activateExtension();

    for (const d of ctx.subscriptions) d.dispose();
    expect(transport.conns.map((c) => c.closed)).toEqual([true, true]);
  });
});

describe("manifest commands", () => {
  it("opens the manifest and its form side by side when the project has one", async () => {
    state.existingPaths = new Set([MANIFEST]);
    await activateExtension();

    await run("dcs.manifest.author");

    expect(state.openedDocuments).toEqual([MANIFEST]);
    expect(state.shownDocuments).toEqual([MANIFEST]);
    expect(titles()).toEqual(["Form: dcs-studio.toml"]);
  });

  it("offers the New Project flow when the workspace has no manifest", async () => {
    await activateExtension();

    await run("dcs.manifest.author");

    // "Create a Mod" on an empty folder has to lead somewhere: the guided
    // scaffolder, not a silent no-op.
    expect(titles()).toEqual(["New Project"]);
  });

  it("offers the New Project flow when no folder is open at all", async () => {
    resetVscode({ config: { "dcsStudio.savedGamesPath": SAVED_GAMES } });
    await activateExtension();

    await run("dcs.manifest.author");

    expect(titles()).toEqual(["New Project"]);
  });

  it("opens the New Project panel directly", async () => {
    await activateExtension();
    await run("dcs.project.new");
    expect(titles()).toEqual(["New Project"]);
  });

  it("opens the form for the manifest in the active editor", async () => {
    await activateExtension();
    (vscode.window as { activeTextEditor?: unknown }).activeTextEditor = {
      document: doc(MANIFEST),
    };

    await run("dcs.manifest.openForm");
    expect(titles()).toEqual(["Form: dcs-studio.toml"]);
  });

  it("does nothing when the active editor is not a manifest, or absent", async () => {
    await activateExtension();

    await run("dcs.manifest.openForm");
    (vscode.window as { activeTextEditor?: unknown }).activeTextEditor = {
      document: doc(`${PROJECT}\\readme.md`),
    };
    await run("dcs.manifest.openForm");

    expect(state.panels).toEqual([]);
  });

  it("opens the form when a manifest is opened in the editor", async () => {
    await activateExtension();

    fireDocumentOpened(doc(MANIFEST));
    await flush();

    // The split view is the whole authoring experience; without this listener
    // opening dcs-studio.toml is just a TOML file.
    expect(titles()).toEqual(["Form: dcs-studio.toml"]);
  });

  it("ignores a document that is not a manifest, or not on disk", async () => {
    await activateExtension();

    fireDocumentOpened(doc(`${PROJECT}\\mod.lua`));
    // A git diff of the manifest opens as `git:` — editing that is not a thing.
    fireDocumentOpened(doc(MANIFEST, "git"));
    fireDocumentOpened(undefined as unknown as vscode.TextDocument);
    await flush();

    expect(state.panels).toEqual([]);
  });

  it("opens the form for a manifest that was already open at activation", async () => {
    state.textDocuments = [doc(MANIFEST) as never];
    await activateExtension();

    // Reloading the window with dcs-studio.toml open must bring the form back,
    // not leave a bare TOML editor.
    expect(titles()).toEqual(["Form: dcs-studio.toml"]);
  });
});

describe("panel commands", () => {
  it("opens the marketplace, my mods, publish, setup, skills and log panels", async () => {
    await activateExtension();

    await run("dcs.marketplace.open");
    await run("dcs.mymods.open");
    await run("dcs.publish.open");
    await run("dcs.setup.open");
    await run("dcs.skills.open");
    await run("dcs.log.open");
    await run("dcs.bridge.console");

    expect(titles()).toEqual([
      "DCS Marketplace",
      "My Mods",
      "Publish Mod",
      "DCS Setup",
      "Agent Skills",
      "DCS Log",
      "DCS Lua Console",
    ]);
  });

  it("opens the docs at the requested page", async () => {
    await activateExtension();

    await run("dcs.docs.open", "sandbox");
    expect(lastPanel().webview.html).toContain('window.__INITIAL_PAGE__ = "sandbox"');
  });

  it("opens the docs home when no page is named", async () => {
    await activateExtension();

    await run("dcs.docs.open");
    expect(lastPanel().webview.html).toContain('window.__INITIAL_PAGE__ = ""');
  });

  it("routes the shortcut command at the shortcut writer", async () => {
    const ctx = await activateExtension();

    await run("dcs.mymods.createShortcut");
    // The .lnk needs the context: the icon is staged in global storage and the
    // deep link carries the extension id.
    expect(shortcut.calls).toEqual([ctx]);
  });

  it("re-discovers listings when the open marketplace panel is refreshed", async () => {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      fetched.push(url);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            items: [
              {
                full_name: "Owner/Mod",
                name: "Mod",
                description: "A mod",
                html_url: "https://github.com/Owner/Mod",
                stargazers_count: 3,
                topics: ["dcs-studio"],
                owner: { login: "Owner", avatar_url: "https://avatar" },
              },
            ],
          }),
      });
    });
    await activateExtension();
    await run("dcs.marketplace.open");

    await run("dcs.marketplace.refresh");

    // Proves the panel really got the GitHub-backed marketplace adapter (and
    // its topic setting) rather than something inert.
    expect(fetched[0]).toContain("topic%3Adcs-studio");
    expect(lastPanel().webview.postedOfType("listings")[0]).toMatchObject({
      listings: [{ repo: "Owner/Mod", stars: 3 }],
      force: true,
    });
  });

  it("ignores a refresh when the marketplace panel is closed", async () => {
    await activateExtension();

    await run("dcs.marketplace.refresh");
    // The toolbar button is reachable from the palette with no panel open.
    expect(state.panels).toEqual([]);
  });
});

describe("MissionScripting commands", () => {
  const missionCommands = [
    "dcs.mission.open",
    "dcs.mission.desanitize",
    "dcs.mission.sanitize",
    "dcs.mission.restore",
    "dcs.mission.hooks.install",
    "dcs.mission.hooks.remove",
  ];

  it("sends every MissionScripting action to the path guard when DCS is not configured", async () => {
    await activateExtension();

    for (const command of missionCommands) await run(command);

    // What each action then does to the file is the mission suite's subject;
    // what matters here is that all six reach it holding the same service, so
    // none of them silently does nothing.
    expect(state.info).toEqual(
      missionCommands.map(() => "Set your DCS installation path to manage MissionScripting.lua."),
    );
  });

  it("takes the user to the setup panel from that prompt", async () => {
    await activateExtension();
    state.messageReplies.push("Set DCS Paths");

    await run("dcs.mission.open");
    expect(state.executedCommands.map((c) => c.command)).toContain("dcs.setup.open");
  });
});

describe("bridge commands", () => {
  /** The DLLs + hook the extension ships, as inject reads them. */
  function seedShippedBridge(): void {
    io.seed(`${EXT}\\bridge\\prebuilt\\dcs_studio_gui.dll`, "gui");
    io.seed(`${EXT}\\bridge\\prebuilt\\dcs_studio_mission.dll`, "mission");
    io.seed(`${EXT}\\bridge\\hook\\DcsStudio.lua`, "hook");
  }

  it("injects both DLLs and the hook into the configured write dir", async () => {
    seedShippedBridge();
    await activateExtension();

    await run("dcs.bridge.inject");

    expect(io.read(`${SAVED_GAMES}\\Mods\\tech\\DcsStudio\\bin\\dcs_studio_gui.dll`)).toBe("gui");
    expect(io.read(`${SAVED_GAMES}\\Mods\\tech\\DcsStudio\\bin\\dcs_studio_mission.dll`)).toBe(
      "mission",
    );
    expect(io.read(`${SAVED_GAMES}\\Scripts\\Hooks\\DcsStudio.lua`)).toBe("hook");
  });

  it("ejects them again", async () => {
    seedShippedBridge();
    await activateExtension();
    await run("dcs.bridge.inject");

    await run("dcs.bridge.eject");

    expect(io.exists(`${SAVED_GAMES}\\Mods\\tech\\DcsStudio\\bin\\dcs_studio_gui.dll`)).toBe(false);
    expect(io.exists(`${SAVED_GAMES}\\Scripts\\Hooks\\DcsStudio.lua`)).toBe(false);
  });

  it("reconnects the bridges immediately after a launch attempt", async () => {
    await activateExtension();
    // Both sockets drop and settle into backoff, as they do while DCS is down.
    transport.conns[0].handlers.onClose?.(1006, "");
    transport.conns[1].handlers.onClose?.(1006, "");
    expect(transport.conns).toHaveLength(2);

    await run("dcs.bridge.launch");

    // Without the reconnect the status bar stays "offline" for the rest of the
    // backoff even though the sim is coming up right now.
    expect(transport.conns).toHaveLength(4);
  });

  it("reports that the bridge source is absent when asked to build it", async () => {
    await activateExtension();

    await run("dcs.bridge.build");
    expect(state.errors).toEqual(["Bridge source (bridge/) is not present in this build."]);
  });

  it("refuses a database export while the GUI bridge is down", async () => {
    await activateExtension();

    await run("dcs.db.export");
    // The command is handed the live clients, so it can answer from their state
    // instead of hanging on a request that will never be served.
    expect(state.errors[0]).toContain("The DCS bridge is not connected");
  });
});

describe("bridge status bar click", () => {
  it("opens the console directly while the GUI bridge is up", async () => {
    await activateExtension();
    transport.conns[0].handlers.onOpen?.();

    await run("dcs.bridge.statusBarClick");
    expect(titles()).toEqual(["DCS Lua Console"]);
  });

  it("offers the offline actions and runs the chosen one", async () => {
    await activateExtension();
    state.quickPickReplies.push({ command: "dcs.bridge.launch" });

    await run("dcs.bridge.statusBarClick");

    // Offline, the click is the only discoverable route to Launch DCS.
    expect(state.executedCommands.map((c) => c.command)).toContain("dcs.bridge.launch");
  });

  it("does nothing when the offline picker is dismissed", async () => {
    await activateExtension();

    await run("dcs.bridge.statusBarClick");
    expect(state.executedCommands).toEqual([]);
    expect(state.panels).toEqual([]);
  });
});

describe("My Mods deep link", () => {
  const myModsUri = { path: "/mymods" };

  it("opens My Mods in a window with no project open", async () => {
    resetVscode({
      config: { "dcsStudio.savedGamesPath": SAVED_GAMES, "dcsStudio.dataDir": dataDir },
    });
    await activateExtension();

    state.uriHandler!.handleUri(myModsUri);
    await flush();

    expect(titles()).toEqual(["My Mods"]);
  });

  it("hands off to a fresh window when a project is open", async () => {
    await activateExtension();

    state.uriHandler!.handleUri(myModsUri);
    await flush();

    // Landing inside someone's project would put an unrelated panel over their
    // workspace; the breadcrumb lets the new window finish the job.
    expect(state.panels).toEqual([]);
    expect(state.executedCommands.map((c) => c.command)).toEqual(["workbench.action.newWindow"]);
    expect(globalStore.get(PENDING_MYMODS_KEY)).toEqual(expect.any(Number));
  });

  it("ignores a deep link for some other path", async () => {
    await activateExtension();

    state.uriHandler!.handleUri({ path: "/something-else" });
    await flush();

    expect(state.panels).toEqual([]);
    expect(state.executedCommands).toEqual([]);
  });

  it("finishes the hand-off in the empty window that was just spawned", async () => {
    resetVscode({
      config: { "dcsStudio.savedGamesPath": SAVED_GAMES, "dcsStudio.dataDir": dataDir },
    });
    globalStore.set(PENDING_MYMODS_KEY, Date.now());

    await activateExtension();

    expect(titles()).toEqual(["My Mods"]);
    // Consumed, so the next window in this session is not hijacked too.
    expect(globalStore.has(PENDING_MYMODS_KEY)).toBe(false);
  });

  it("ignores a stale hand-off breadcrumb", async () => {
    resetVscode({
      config: { "dcsStudio.savedGamesPath": SAVED_GAMES, "dcsStudio.dataDir": dataDir },
    });
    globalStore.set(PENDING_MYMODS_KEY, Date.now() - 60_000);

    await activateExtension();

    // A hand-off window that was never opened must not pop My Mods over an
    // unrelated window days later.
    expect(state.panels).toEqual([]);
    expect(globalStore.has(PENDING_MYMODS_KEY)).toBe(false);
  });

  it("ignores a hand-off that landed in a window with a project open", async () => {
    globalStore.set(PENDING_MYMODS_KEY, Date.now());

    await activateExtension();

    expect(state.panels).toEqual([]);
  });
});

describe("pending project open", () => {
  it("opens the manifest and form for the project just scaffolded", async () => {
    state.existingPaths = new Set([MANIFEST]);
    globalStore.set(PENDING_OPEN_KEY, PROJECT);

    await activateExtension();

    // Opening the scaffolded folder reloads the extension host, so this is the
    // only thing that makes a brand-new project land on its manifest instead
    // of an empty editor.
    expect(state.openedDocuments).toEqual([MANIFEST]);
    expect(titles()).toEqual(["Form: dcs-studio.toml"]);
    expect(globalStore.has(PENDING_OPEN_KEY)).toBe(false);
  });

  it("matches the folder case-insensitively, as Windows spells it", async () => {
    state.existingPaths = new Set([MANIFEST]);
    globalStore.set(PENDING_OPEN_KEY, PROJECT.toLowerCase());

    await activateExtension();

    expect(state.openedDocuments).toEqual([MANIFEST]);
  });

  it("does not open anything when a different folder was opened", async () => {
    state.existingPaths = new Set([MANIFEST]);
    globalStore.set(PENDING_OPEN_KEY, "C:\\other");

    await activateExtension();

    expect(state.openedDocuments).toEqual([]);
    expect(state.panels).toEqual([]);
    // Still consumed: a breadcrumb that survives would fire in an unrelated
    // window later.
    expect(globalStore.has(PENDING_OPEN_KEY)).toBe(false);
  });

  it("does not open anything for a non-file workspace", async () => {
    state.workspaceFolders = [
      { uri: { fsPath: PROJECT, scheme: "vscode-remote" }, name: PROJECT, index: 0 },
    ];
    globalStore.set(PENDING_OPEN_KEY, PROJECT);

    await activateExtension();

    expect(state.openedDocuments).toEqual([]);
  });
});

describe("skill update nudge", () => {
  const bundled = "---\nname: DCS Studio\nversion: 2.0.0\n---\nbundled body\n";
  const installed = "---\nname: DCS Studio\nversion: 1.0.0\n---\ninstalled body\n";

  function seedOutdatedSkill(): void {
    seedFile(`${EXT}\\skills\\dcs-studio\\SKILL.md`, bundled);
    seedFile(`${PROJECT}\\.claude\\skills\\dcs-studio\\SKILL.md`, installed);
  }

  it("nudges once when the repo's installed skill is older than the bundled one", async () => {
    seedOutdatedSkill();
    await activateExtension();

    expect(state.info).toEqual([
      'The "DCS Studio" agent skill in this repo is outdated (v1.0.0 installed, v2.0.0 bundled).',
    ]);
  });

  it("stays quiet on the next reload of the same window", async () => {
    seedOutdatedSkill();
    await activateExtension();
    state.info.length = 0;

    await activateExtension();

    // The nudge is remembered per skill per bundled version: reloading the
    // window must not re-nag, only shipping a newer skill should.
    expect(state.info).toEqual([]);
  });

  it("installs the update and asks for it to be committed", async () => {
    seedOutdatedSkill();
    state.messageReplies.push("Update");
    await activateExtension();
    await flush();

    expect(state.fsOps.some((op) => op.op === "copy")).toBe(true);
    expect(state.info[1]).toBe('"DCS Studio" skill updated to v2.0.0 — commit the change.');
  });

  it("reports a failed update and offers the nudge again next activation", async () => {
    // A read-only repo is the usual cause. Swallowing the rejection left the
    // user with a button that did nothing, no error, and a nudge already
    // marked as delivered — so the offer never came back either.
    seedOutdatedSkill();
    const copy = vi
      .spyOn(vscode.workspace.fs, "copy")
      .mockRejectedValueOnce(new Error("EROFS: read-only file system"));
    state.messageReplies.push("Update");

    await activateExtension();
    await flush();

    expect(state.errors).toEqual(["Skill install failed: EROFS: read-only file system"]);
    expect(state.info).toHaveLength(1); // the nudge only — no "updated" toast
    expect([...workspaceStore.keys()]).toEqual([]);

    copy.mockRestore();
    state.info.length = 0;
    await activateExtension();
    expect(state.info).toEqual([
      'The "DCS Studio" agent skill in this repo is outdated (v1.0.0 installed, v2.0.0 bundled).',
    ]);
  });

  it("renders a non-Error install failure", async () => {
    seedOutdatedSkill();
    const copy = vi.spyOn(vscode.workspace.fs, "copy").mockRejectedValueOnce("nope");
    state.messageReplies.push("Update");

    await activateExtension();
    await flush();

    expect(state.errors).toEqual(["Skill install failed: nope"]);
    copy.mockRestore();
  });

  it("opens the Skills panel when the user asks to manage them instead", async () => {
    seedOutdatedSkill();
    state.messageReplies.push("Manage Skills");
    await activateExtension();
    await flush();

    expect(titles()).toEqual(["Agent Skills"]);
  });

  it("does nothing when the nudge is dismissed", async () => {
    seedOutdatedSkill();
    await activateExtension();
    await flush();

    expect(state.panels).toEqual([]);
    expect(state.fsOps).toEqual([]);
  });

  it("says nothing when no skill is out of date", async () => {
    await activateExtension();
    expect(state.info).toEqual([]);
  });
});

describe("first-run setup prompt", () => {
  it("nudges to the folder selector when no DCS paths are set", async () => {
    resetVscode({ config: { "dcsStudio.dataDir": dataDir }, workspaceFolders: [PROJECT] });
    state.messageReplies.push("Set DCS Paths");

    await activateExtension();
    await flush();

    expect(state.info).toEqual([
      "Set your DCS folders to enable inject, launch and the Lua console.",
    ]);
    expect(titles()).toEqual(["DCS Setup"]);
    expect(globalStore.get("dcs.setupPrompted")).toBe(true);
  });

  it("leaves the user alone if they dismiss it", async () => {
    resetVscode({ config: { "dcsStudio.dataDir": dataDir }, workspaceFolders: [PROJECT] });

    await activateExtension();
    await flush();

    expect(state.panels).toEqual([]);
  });

  it("asks only once, ever", async () => {
    resetVscode({ config: { "dcsStudio.dataDir": dataDir }, workspaceFolders: [PROJECT] });
    globalStore.set("dcs.setupPrompted", true);

    await activateExtension();

    expect(state.info).toEqual([]);
  });

  it("stays quiet when only the game install path is set", async () => {
    resetVscode({
      config: { "dcsStudio.gameInstallPath": "D:\\DCS World", "dcsStudio.dataDir": dataDir },
      workspaceFolders: [PROJECT],
    });

    await activateExtension();

    expect(state.info).toEqual([]);
  });
});
