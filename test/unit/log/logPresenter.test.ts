import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { LogEffect, LogPresenterDeps } from "../../../src/core/app/logPresenter";
import { LogPresenter } from "../../../src/core/app/logPresenter";
import type { LogHostMessage } from "../../../src/core/app/webviewContract";
import type { InstallRootsPort } from "../../../src/core/ports/installRoots";

// The DCS Log viewer's decision logic, with no `vscode` anywhere: what a batch
// of tailed lines becomes, when a tick stays silent, how many entries the cap
// evicted since the last push, what the boot handshake replays, and the
// "any failure means no mod identity" mapping over the workspace manifest.
//
// The tailer itself, its cadence and the panel's teardown ordering are the
// shell's (test/integration/log/logPanel.test.ts) — here the three tailer
// callbacks are simply called.

const SAVED_GAMES = "C:\\Users\\pilot\\Saved Games\\DCS";
const TOML = '[project]\nname = "Super Carrier Tweaks"\n';

let posted: LogHostMessage[];
let effects: LogEffect[];
let savedGames: string;
let text: string | null;
let readFails: Error | undefined;
let parseThrows: Error | undefined;
let projectName: string | undefined;

/** The log path the presenter should name, built the way it builds it — the
 * separator is the host OS's, and both CI runners run this file. */
const LOG_PATH = (root = SAVED_GAMES) => path.join(root, "Logs", "dcs.log");

function presenter(over: Partial<LogPresenterDeps> = {}): LogPresenter {
  const roots = {
    savedGames: () => savedGames,
    gameInstall: () => "C:\\DCS World",
    dataDir: () => "D:\\mods",
  } as InstallRootsPort;
  return new LogPresenter({
    roots,
    parseManifest: (t: string) => {
      expect(t).toBe(TOML);
      if (parseThrows) throw parseThrows;
      return { project: projectName === undefined ? undefined : { name: projectName } };
    },
    manifestText: async () => {
      if (readFails) throw readFails;
      return text;
    },
    post: (msg) => posted.push(msg),
    effect: (e) => effects.push(e),
    ...over,
  });
}

/** A tailed, pointed-somewhere presenter — the state every real tick starts in. */
async function tailing(): Promise<LogPresenter> {
  const p = presenter();
  await p.loadModIdentity();
  p.retarget();
  return p;
}

function entry(subsystem: string, message: string, level = "INFO"): string {
  return `2026-07-13 12:00:00.001 ${level}    ${subsystem} (Main): ${message}`;
}

/** The one message of `type` the presenter posted most recently. */
function last<T extends LogHostMessage["type"]>(
  type: T,
): Extract<LogHostMessage, { type: T }> | undefined {
  const of = posted.filter((m) => m.type === type);
  return of[of.length - 1] as Extract<LogHostMessage, { type: T }> | undefined;
}

beforeEach(() => {
  posted = [];
  effects = [];
  savedGames = SAVED_GAMES;
  text = TOML;
  readFails = undefined;
  parseThrows = undefined;
  projectName = "Super Carrier Tweaks";
});

describe("whose mod the lines belong to", () => {
  it("derives the identity from the manifest's project name and announces it", async () => {
    // The slug and name are what the webview's "mine only" filter matches on.
    await presenter().loadModIdentity();

    expect(posted).toEqual([
      { type: "mod", mod: { slug: "super-carrier-tweaks", name: "Super Carrier Tweaks" } },
    ]);
  });

  it("has no mod when there is no workspace to read a manifest from", async () => {
    // The viewer is useful on its own — a log with no project still tails.
    text = null;
    await presenter().loadModIdentity();
    expect(posted).toEqual([{ type: "mod", mod: null }]);
  });

  it("has no mod when the manifest cannot be read", async () => {
    readFails = new Error("ENOENT");
    await presenter().loadModIdentity();
    expect(posted).toEqual([{ type: "mod", mod: null }]);
  });

  it("has no mod when the manifest is malformed", async () => {
    // A half-written TOML must not stop the log from opening at all.
    parseThrows = new Error("expected `=`");
    await presenter().loadModIdentity();
    expect(posted).toEqual([{ type: "mod", mod: null }]);
  });

  it("has no mod when the manifest declares no project name", async () => {
    projectName = undefined;
    await presenter().loadModIdentity();
    expect(posted).toEqual([{ type: "mod", mod: null }]);
  });

  it("marks entries from the workspace mod as mine and leaves the rest alone", async () => {
    const p = await tailing();
    p.onLines([entry("super-carrier-tweaks", "deck ready"), entry("DCS", "engine chatter")]);

    expect(last("append")?.entries.map((e) => e.mine)).toEqual([true, false]);
  });

  it("stamps nothing as mine once the identity is gone", async () => {
    // Re-deriving after the folder closed must not keep marking rows.
    const p = await tailing();
    text = null;
    await p.loadModIdentity();
    p.onLines([entry("super-carrier-tweaks", "deck ready")]);

    expect(last("append")?.entries.map((e) => e.mine)).toEqual([false]);
  });
});

describe("pointing at a log file", () => {
  it("names the configured Saved Games log, re-reading the setting each time", async () => {
    const p = await tailing();
    savedGames = "D:\\DCS.openbeta";

    expect(p.retarget()).toBe(LOG_PATH("D:\\DCS.openbeta"));
  });

  it("drops what the previous file left buffered", async () => {
    // Entries from another Saved Games folder belong to a different install.
    const p = await tailing();
    p.onLines([entry("DCS", "from the old folder")]);
    p.retarget();
    p.handle({ type: "ready" });

    expect(last("init")?.entries).toEqual([]);
  });

  it("clears the drop delta with the buffer, so the next append is not owed one", async () => {
    const p = await tailing();
    p.onLines(Array.from({ length: 5001 }, (_, i) => entry("DCS", `line ${i}`)));
    p.retarget();
    p.onLines([entry("DCS", "fresh")]);

    expect(last("append")?.dropped).toBe(0);
  });
});

describe("lines arriving from the tail", () => {
  it("appends parsed entries", async () => {
    const p = await tailing();
    p.onLines([entry("DCS", "starting", "WARNING")]);

    expect(last("append")).toMatchObject({
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
    const p = await tailing();
    p.onLines([entry("SCRIPTING", "Lua error")]);
    const seq = last("append")?.entries[0].seq;

    p.onLines(["\tstack traceback:", "\t\tin function 'foo'"]);

    const update = last("append");
    expect(update?.entries).toEqual([]);
    // Each update carries that entry's whole trace so far, and the webview
    // swaps the list wholesale — so re-sending earlier lines cannot duplicate.
    expect(update?.cont.map((c) => c.seq)).toEqual([seq, seq]);
    expect(update?.cont.at(-1)?.cont).toEqual(["\tstack traceback:", "\t\tin function 'foo'"]);
  });

  it("says nothing when a read produced no lines", async () => {
    // Every poll tick that adds nothing must stay silent, or the webview would
    // re-render several times a second while DCS sits idle.
    const p = await tailing();
    p.onLines([]);
    expect(last("append")).toBeUndefined();
  });

  it("reports how many entries the buffer cap evicted since the last push", async () => {
    // The webview shows the drop count so a user who scrolled up knows the
    // history above them is gone rather than merely off-screen.
    const p = await tailing();
    p.onLines(Array.from({ length: 5000 }, (_, i) => entry("DCS", `line ${i}`)));
    expect(last("append")?.dropped).toBe(0);

    p.onLines([entry("DCS", "one too many"), entry("DCS", "and another")]);
    expect(last("append")?.dropped).toBe(2);

    // The DELTA, not the running total: the webview adds each push to a badge it
    // keeps itself, so re-sending the cumulative count double-counts every
    // eviction from the moment the log first goes over the cap — which, in a
    // session long enough to hit the cap at all, is every batch from then on.
    p.onLines([entry("DCS", "and a third")]);
    expect(last("append")?.dropped).toBe(1);
  });
});

describe("what the file itself is doing", () => {
  it("reports the file appearing and disappearing, naming the path it watched", async () => {
    // "missing" is the common first state — DCS has not been run since install —
    // and the path is the only clue when the setting points somewhere wrong.
    const p = await tailing();
    p.onState("missing");

    expect(last("fileState")).toEqual({
      type: "fileState",
      state: "missing",
      file: LOG_PATH(),
    });
  });

  it("empties the grid when DCS truncates the log on restart", async () => {
    // Keeping the old entries would silently mix two DCS sessions together.
    const p = await tailing();
    p.onLines([entry("DCS", "previous session")]);
    p.onReset();
    p.handle({ type: "ready" });

    expect(posted.filter((m) => m.type === "reset")).toHaveLength(1);
    expect(last("init")?.entries).toEqual([]);
  });

  it("does not owe a drop delta for entries the reset threw away", async () => {
    const p = await tailing();
    p.onLines(Array.from({ length: 5001 }, (_, i) => entry("DCS", `line ${i}`)));
    p.onReset();
    p.onLines([entry("DCS", "fresh session")]);

    expect(last("append")?.dropped).toBe(0);
  });
});

describe("messages from the webview", () => {
  it("answers the boot handshake with the buffered backlog and current state", async () => {
    // The webview loads after the tail has already been running, so without
    // this replay the user sees an empty grid until the next line lands.
    const p = await tailing();
    p.onState("ok");
    p.onLines([entry("DCS", "already tailed")]);

    p.handle({ type: "ready" });

    expect(last("init")).toMatchObject({
      mod: { name: "Super Carrier Tweaks" },
      file: LOG_PATH(),
      state: "ok",
      entries: [expect.objectContaining({ message: "already tailed" })],
    });
  });

  it("reports the file as missing in the handshake until the tailer says otherwise", async () => {
    const p = await tailing();
    p.handle({ type: "ready" });
    expect(last("init")).toMatchObject({ state: "missing" });
  });

  it("empties the backlog on clear, so a later handshake does not resurrect it", async () => {
    const p = await tailing();
    p.onLines([entry("DCS", "noise")]);
    p.handle({ type: "clear" });
    p.handle({ type: "ready" });

    expect(last("init")?.entries).toEqual([]);
  });

  it("tells the webview nothing on clear — it cleared its own grid first", async () => {
    // media/log.js empties its local mirror before posting `clear`, so an echo
    // would be a second full re-render of a grid that is already empty.
    const p = await tailing();
    p.onLines([entry("DCS", "noise")]);
    const before = posted.length;
    p.handle({ type: "clear" });

    expect(posted).toHaveLength(before);
  });

  it("clears the drop delta with the backlog", async () => {
    const p = await tailing();
    p.onLines(Array.from({ length: 5001 }, (_, i) => entry("DCS", `line ${i}`)));
    p.handle({ type: "clear" });
    p.onLines([entry("DCS", "after the clear")]);

    expect(last("append")?.dropped).toBe(0);
  });

  it("describes the settings link as an effect rather than performing it", async () => {
    const p = await tailing();
    p.handle({ type: "openSettings" });
    expect(effects).toEqual([{ kind: "openSettings" }]);
  });

  it("ignores a message type it does not know", async () => {
    const p = await tailing();
    const before = posted.length;
    p.handle({ type: "explode" } as unknown as { type: "ready" });

    expect(posted).toHaveLength(before);
    expect(effects).toEqual([]);
  });
});
