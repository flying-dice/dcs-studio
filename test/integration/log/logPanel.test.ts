import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireConfigurationChanged, resetVscode, state, vscodeMock } from "../support/vscode";

vi.mock("vscode", () => vscodeMock());

// The DCS Log viewer's host side. Everything the user sees is driven by three
// tailer callbacks and one handshake, so what matters here is that lines,
// truncations and a missing file each turn into the right webview message —
// and that closing the panel really stops the poll behind it.

/** A tailer the test drives directly, standing in for the fs-polling one. */
interface FakeTailer {
  opts: {
    filePath: string;
    onLines(lines: string[]): void;
    onState(state: "ok" | "missing"): void;
    onReset(): void;
  };
  started: boolean;
  stopped: boolean;
}

const tailers: FakeTailer[] = [];

vi.mock("../../../src/log/tailer", () => ({
  LogTailer: class {
    started = false;
    stopped = false;
    constructor(readonly opts: unknown) {
      tailers.push(this as unknown as FakeTailer);
    }
    start(): void {
      this.started = true;
    }
    stop(): void {
      this.stopped = true;
    }
  },
}));

import * as vscode from "vscode";
import { installRoots } from "../../../src/adapters/vscode/installRoots";
import type { ManifestPort } from "../../../src/core/ports/manifest";
import { LogPanel } from "../../../src/log/logPanel";

const TOML = '[project]\nname = "Super Carrier Tweaks"\n';

let manifestBytes: Uint8Array | Error = Buffer.from(TOML);
let projectName: string | undefined | null = "Super Carrier Tweaks";
let parseThrows: Error | undefined;
const readUris: string[] = [];

const manifestPort = {
  parseToml: (text: string) => {
    if (parseThrows) throw parseThrows;
    expect(text).toBe(TOML);
    return { project: projectName === null ? undefined : { name: projectName } };
  },
} as unknown as ManifestPort;

const context = () =>
  ({
    extensionUri: vscode.Uri.file("C:\\ext"),
    subscriptions: [],
  }) as unknown as vscode.ExtensionContext;

/** The tailer for the panel opened most recently. */
const tailer = () => tailers[tailers.length - 1];

/** The panel reads its manifest asynchronously before starting the tailer. */
const flush = () => new Promise((r) => setTimeout(r, 0));

async function show() {
  LogPanel.show(context(), manifestPort, installRoots);
  await flush();
  return state.panels[state.panels.length - 1];
}

function entry(subsystem: string, message: string, level = "INFO"): string {
  return `2026-07-13 12:00:00.001 ${level}    ${subsystem} (Main): ${message}`;
}

beforeEach(() => {
  resetVscode({
    config: { "dcsStudio.savedGamesPath": "C:\\Users\\pilot\\Saved Games\\DCS" },
    workspaceFolders: ["C:\\proj"],
  });
  // The shared double has no fs.readFile; the manifest read is this panel's
  // only filesystem touch, so it is served locally rather than globally.
  Object.assign(vscode.workspace.fs, {
    readFile: (uri: { fsPath: string }) => {
      readUris.push(uri.fsPath);
      return manifestBytes instanceof Error
        ? Promise.reject(manifestBytes)
        : Promise.resolve(manifestBytes);
    },
  });
  tailers.length = 0;
  readUris.length = 0;
  manifestBytes = Buffer.from(TOML);
  projectName = "Super Carrier Tweaks";
  parseThrows = undefined;
  LogPanel.current = undefined;
});

describe("opening the viewer", () => {
  it("opens one panel and points its tailer at the configured Saved Games log", async () => {
    const panel = await show();

    expect(panel.viewType).toBe("dcsStudio.logViewer");
    expect(panel.title).toBe("DCS Log");
    expect(tailer().opts.filePath).toContain("Logs");
    expect(tailer().opts.filePath).toContain("dcs.log");
    expect(tailer().started).toBe(true);
  });

  it("reveals the open panel instead of starting a second tail of the same file", async () => {
    // Two tailers would double every line and double the poll cost.
    await show();
    LogPanel.show(context(), manifestPort, installRoots);
    await flush();

    expect(state.panels).toHaveLength(1);
    expect(tailers).toHaveLength(1);
  });

  it("opens beside the active editor rather than always in column one", async () => {
    Object.assign(vscode.window, { activeTextEditor: { viewColumn: 2 } });
    const panel = await show();
    expect(panel.showOptions).toBe(2);
    Object.assign(vscode.window, { activeTextEditor: undefined });
  });

  it("renders a nonce-locked document that may load the log font", async () => {
    // The log grid is monospaced from a bundled font; without `font-src` the
    // CSP would silently drop it and the columns would stop lining up.
    const panel = await show();
    expect(panel.webview.html).toContain("log.js");
    expect(panel.webview.html).toContain("log.css");
    expect(panel.webview.html).toContain("font-src");
    expect(panel.webview.html).toMatch(/nonce-[A-Za-z0-9]+/);
  });
});

describe("whose mod the lines belong to", () => {
  it("derives the mod identity from the workspace manifest", async () => {
    // The slug and name are what the webview's "mine only" filter matches on.
    const panel = await show();

    expect(readUris).toEqual(["C:\\proj\\dcs-studio.toml"]);
    expect(panel.webview.postedOfType("mod")[0]).toEqual({
      type: "mod",
      mod: { slug: "super-carrier-tweaks", name: "Super Carrier Tweaks" },
    });
  });

  it("has no mod when no folder is open", async () => {
    // The viewer is useful on its own — a log with no project still tails.
    resetVscode({});
    const panel = await show();

    expect(readUris).toEqual([]);
    expect(panel.webview.postedOfType("mod")[0]).toEqual({ type: "mod", mod: null });
  });

  it("has no mod when the folder has no manifest", async () => {
    manifestBytes = new Error("ENOENT");
    const panel = await show();
    expect(panel.webview.postedOfType("mod")[0]).toEqual({ type: "mod", mod: null });
  });

  it("has no mod when the manifest is malformed", async () => {
    // A half-written TOML must not stop the log from opening at all.
    parseThrows = new Error("expected `=`");
    const panel = await show();

    expect(panel.webview.postedOfType("mod")[0]).toEqual({ type: "mod", mod: null });
    expect(tailer().started).toBe(true);
  });

  it("has no mod when the manifest declares no project name", async () => {
    projectName = null;
    const panel = await show();
    expect(panel.webview.postedOfType("mod")[0]).toEqual({ type: "mod", mod: null });
  });

  it("marks entries from the workspace mod as mine", async () => {
    const panel = await show();
    tailer().opts.onLines([
      entry("super-carrier-tweaks", "deck ready"),
      entry("DCS", "unrelated engine chatter"),
    ]);

    const appended = panel.webview.postedOfType("append")[0].entries as { mine: boolean }[];
    expect(appended.map((e) => e.mine)).toEqual([true, false]);
  });
});

describe("lines arriving from the tail", () => {
  it("appends parsed entries", async () => {
    const panel = await show();
    tailer().opts.onLines([entry("DCS", "starting", "WARNING")]);

    expect(panel.webview.postedOfType("append")[0]).toMatchObject({
      entries: [
        expect.objectContaining({ level: "WARNING", subsystem: "DCS", message: "starting" }),
      ],
      cont: [],
      dropped: 0,
    });
  });

  it("attaches a stack trace to the entry it belongs to instead of listing it as new", async () => {
    // A Lua traceback arrives as many unparseable lines; shown as entries they
    // would swamp the grid and detach the error from its own stack.
    const panel = await show();
    tailer().opts.onLines([entry("SCRIPTING", "Lua error")]);
    const seq = (panel.webview.postedOfType("append")[0].entries as { seq: number }[])[0].seq;

    tailer().opts.onLines(["\tstack traceback:", "\t\tin function 'foo'"]);

    const update = panel.webview.postedOfType("append")[1];
    expect(update.entries).toEqual([]);
    // Each update carries that entry's whole trace so far, and the webview
    // swaps the list wholesale — so re-sending earlier lines cannot duplicate.
    expect((update.cont as { seq: number }[]).map((c) => c.seq)).toEqual([seq, seq]);
    expect((update.cont as { cont: string[] }[]).at(-1)?.cont).toEqual([
      "\tstack traceback:",
      "\t\tin function 'foo'",
    ]);
  });

  it("says nothing when a read produced no lines", async () => {
    // Every poll tick that adds nothing must stay silent, or the webview would
    // re-render several times a second while DCS sits idle.
    const panel = await show();
    tailer().opts.onLines([]);
    expect(panel.webview.postedOfType("append")).toEqual([]);
  });

  it("reports how many entries the buffer cap evicted", async () => {
    // The webview shows the drop count so a user who scrolled up knows the
    // history above them is gone rather than merely off-screen.
    const panel = await show();
    tailer().opts.onLines(Array.from({ length: 5000 }, (_, i) => entry("DCS", `line ${i}`)));
    tailer().opts.onLines([entry("DCS", "one too many")]);

    expect(panel.webview.postedOfType("append")[1]).toMatchObject({ dropped: 1 });
  });
});

describe("what the file itself is doing", () => {
  it("reports the file appearing and disappearing, naming the path it watched", async () => {
    // "missing" is the common first state — DCS has not been run since install —
    // and the path is the only clue when the setting points somewhere wrong.
    const panel = await show();
    tailer().opts.onState("missing");

    expect(panel.webview.postedOfType("fileState")[0]).toEqual({
      type: "fileState",
      state: "missing",
      file: tailer().opts.filePath,
    });
  });

  it("clears the grid when DCS truncates the log on restart", async () => {
    // Keeping the old entries would silently mix two DCS sessions together.
    const panel = await show();
    tailer().opts.onLines([entry("DCS", "previous session")]);
    tailer().opts.onReset();
    await panel.webview.receive({ type: "ready" });

    expect(panel.webview.postedOfType("reset")).toHaveLength(1);
    expect(panel.webview.postedOfType("init")[0]).toMatchObject({ entries: [] });
  });

  it("restarts the tail against the new path when the Saved Games setting changes", async () => {
    const panel = await show();
    tailer().opts.onLines([entry("DCS", "from the old folder")]);
    const first = tailer();

    state.config["dcsStudio.savedGamesPath"] = "D:\\DCS.openbeta";
    fireConfigurationChanged("dcsStudio.savedGamesPath");

    expect(first.stopped).toBe(true);
    expect(tailers).toHaveLength(2);
    expect(tailer().opts.filePath).toContain("D:\\DCS.openbeta");
    // Entries from the old folder belong to a different install.
    await panel.webview.receive({ type: "ready" });
    expect(panel.webview.postedOfType("init")[0]).toMatchObject({ entries: [] });
  });

  it("ignores configuration changes that are not the log path", async () => {
    await show();
    fireConfigurationChanged("dcsStudio.bridgeGuiPort");
    expect(tailers).toHaveLength(1);
  });
});

describe("messages from the webview", () => {
  it("answers the boot handshake with the buffered backlog and current state", async () => {
    // The webview loads after the tail has already been running, so without
    // this replay the user sees an empty grid until the next line lands.
    const panel = await show();
    tailer().opts.onState("ok");
    tailer().opts.onLines([entry("DCS", "already tailed")]);

    await panel.webview.receive({ type: "ready" });

    expect(panel.webview.postedOfType("init")[0]).toMatchObject({
      mod: { name: "Super Carrier Tweaks" },
      file: tailer().opts.filePath,
      state: "ok",
      entries: [expect.objectContaining({ message: "already tailed" })],
    });
  });

  it("reports the file as missing in the handshake until the tailer says otherwise", async () => {
    const panel = await show();
    await panel.webview.receive({ type: "ready" });
    expect(panel.webview.postedOfType("init")[0]).toMatchObject({ state: "missing" });
  });

  it("empties the backlog on clear, so a later handshake does not resurrect it", async () => {
    const panel = await show();
    tailer().opts.onLines([entry("DCS", "noise")]);
    await panel.webview.receive({ type: "clear" });
    await panel.webview.receive({ type: "ready" });

    expect(panel.webview.postedOfType("init")[0]).toMatchObject({ entries: [] });
  });

  it("routes the settings link to the setup panel", async () => {
    const panel = await show();
    await panel.webview.receive({ type: "openSettings" });
    expect(state.executedCommands).toEqual([{ command: "dcs.setup.open", args: [] }]);
  });

  it("ignores a message type it does not know", async () => {
    const panel = await show();
    const before = panel.webview.posted.length;
    await panel.webview.receive({ type: "explode" });
    expect(panel.webview.posted).toHaveLength(before);
  });
});

describe("closing the viewer", () => {
  it("stops the tail and releases the singleton", async () => {
    // A tailer left running keeps polling dcs.log for the rest of the session.
    const panel = await show();
    panel.dispose();

    expect(tailer().stopped).toBe(true);
    expect(LogPanel.current).toBeUndefined();
  });

  it("does not start a tail for a panel closed before the manifest read finished", async () => {
    // The manifest read is async; closing the panel inside that window used to
    // leave an orphan tailer polling for a webview that no longer exists.
    LogPanel.show(context(), manifestPort, installRoots);
    state.panels[state.panels.length - 1].dispose();
    await flush();

    expect(tailers).toEqual([]);
  });

  it("re-opens after being closed", async () => {
    (await show()).dispose();
    await show();

    expect(state.panels).toHaveLength(2);
    expect(LogPanel.current).toBeDefined();
  });
});
