import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type FakeWebviewPanel,
  fireConfigurationChanged,
  resetVscode,
  seededText,
  seedFile,
  state,
  vscodeMock,
} from "../support/vscode";

vi.mock("vscode", () => vscodeMock());

import * as vscode from "vscode";
import type { BridgeClient } from "../../../src/bridge/client";
import { BridgeClients } from "../../../src/bridge/clients";
import { ConsolePanel } from "../../../src/bridge/consolePanel";
import { EXPORT_OPEN_LIMIT_BYTES } from "../../../src/core/domain/bridgeConsole";
import { CONNECTED, FakeBridgeClient, OFFLINE } from "./fakeBridgeClient";

// The Lua console brokers between one webview and two independent bridges. It
// has to keep routing straight — a mission-env eval sent to the GUI bridge runs
// in the wrong Lua universe and quietly returns nonsense — and it has to stay
// usable when one of them is not there, which is the normal state: the mission
// bridge only exists while a mission is loaded, so "offline" is a mode, not an
// error. Every request carries a correlation id the webview matches replies
// against, so a failed call still has to answer, or the UI waits forever.

const EXT = "C:\\ext";
const TEMP = "D:\\Saved Games\\DCS\\lua-export.json";
const TARGET = "C:\\work\\dump.json";
const WORKSPACE = "C:\\work";

let gui: FakeBridgeClient;
let mission: FakeBridgeClient;
let clients: BridgeClients;
let panel: FakeWebviewPanel;

function context(): vscode.ExtensionContext {
  return { extensionUri: vscode.Uri.file(EXT) } as unknown as vscode.ExtensionContext;
}

/** Let the panel's fire-and-forget message handling settle. */
const flush = (): Promise<void> => vi.advanceTimersByTimeAsync(0);

/** Deliver a webview message and wait for the work it starts. */
async function send(msg: Record<string, unknown>): Promise<void> {
  await panel.webview.receive(msg);
  await flush();
}

function show(): FakeWebviewPanel {
  ConsolePanel.show(context(), clients);
  return state.panels[state.panels.length - 1];
}

/** The one message of `type` the panel posted, failing loudly if there isn't one. */
function posted(type: string): Record<string, unknown> {
  const all = panel.webview.postedOfType(type);
  expect(all).toHaveLength(1);
  return all[0];
}

beforeEach(() => {
  vi.useFakeTimers();
  resetVscode({ workspaceFolders: [WORKSPACE] });
  ConsolePanel.current = undefined;
  gui = new FakeBridgeClient();
  mission = new FakeBridgeClient();
  clients = new BridgeClients(gui as unknown as BridgeClient, mission as unknown as BridgeClient);
  panel = show();
});

afterEach(() => {
  panel.dispose();
  vi.useRealTimers();
});

describe("opening the console", () => {
  it("opens one scripted webview locked to the extension's media folder", () => {
    expect(panel.viewType).toBe("dcsStudio.console");
    expect(panel.title).toBe("DCS Lua Console");
    expect(panel.webview.html).toContain("console.js");
    expect(panel.webview.html).toContain("Content-Security-Policy");
    expect(ConsolePanel.current).toBeDefined();
  });

  it("reveals the console that is already open instead of a second one", () => {
    ConsolePanel.show(context(), clients);
    // Two consoles would each poll both bridges and each drain the same output
    // ring, so neither would show the full print stream.
    expect(state.panels).toHaveLength(1);
  });

  it("opens beside the editor the user is working in", () => {
    panel.dispose();
    ConsolePanel.current = undefined;
    (vscode.window as { activeTextEditor: unknown }).activeTextEditor = { viewColumn: 2 };
    try {
      expect(show().showOptions).toBe(2);
    } finally {
      (vscode.window as { activeTextEditor: unknown }).activeTextEditor = undefined;
    }
  });
});

describe("status and configuration", () => {
  it("pushes the sweep budget the explorer has to plan against", () => {
    expect(posted("explorerConfig")).toEqual({ type: "explorerConfig", wildcardDepth: 1 });
  });

  it("re-pushes the sweep budget when the user changes the setting", async () => {
    state.config["dcsStudio.explorerWildcardDepth"] = 3;
    fireConfigurationChanged("dcsStudio.explorerWildcardDepth");
    await flush();
    // A `**` sweep is bounded by this number; a stale value makes the explorer
    // either refuse legal searches or fire off far more than the sim can serve.
    expect(panel.webview.postedOfType("explorerConfig").at(-1)).toEqual({
      type: "explorerConfig",
      wildcardDepth: 3,
    });
  });

  it("ignores configuration changes to other settings", async () => {
    fireConfigurationChanged("dcsStudio.savedGamesPath");
    await flush();
    expect(panel.webview.postedOfType("explorerConfig")).toHaveLength(1);
  });

  it("forwards every bridge status change to the webview", () => {
    gui.emit(CONNECTED);
    expect(panel.webview.postedOfType("status").at(-1)).toEqual({
      type: "status",
      status: { gui: CONNECTED, mission: OFFLINE },
    });
  });

  it("replays status and config when the webview says it has booted", async () => {
    gui.emit(CONNECTED);
    await send({ type: "ready" });
    // The webview reloads on its own (hidden tab, VS Code restart) and comes
    // back blank; without a replay it shows "offline" over a live bridge.
    expect(panel.webview.postedOfType("status").at(-1)).toEqual({
      type: "status",
      status: { gui: CONNECTED, mission: OFFLINE },
    });
    expect(panel.webview.postedOfType("explorerConfig")).toHaveLength(2);
  });
});

describe("evaluating Lua", () => {
  it("runs code in the GUI state by default and returns the value", async () => {
    gui.answer("replEval", () => ({ ok: true, result: 42 }));
    await send({ type: "eval", code: "return 42" });
    expect(gui.lastCall("replEval")?.args).toEqual(["gui", "return 42"]);
    expect(posted("result")).toEqual({ type: "result", value: 42 });
  });

  it("routes a mission-env eval to the mission bridge", async () => {
    mission.answer("replEval", () => ({ ok: true, result: "ok" }));
    await send({ type: "eval", env: "mission", code: "return 1" });
    // The mission scripting state is a different Lua universe; the GUI bridge
    // cannot see anything the mission defined.
    expect(mission.lastCall("replEval")?.args).toEqual(["mission", "return 1"]);
    expect(gui.calls).toEqual([]);
  });

  it("reports a statement with no value as null rather than nothing", async () => {
    gui.answer("replEval", () => ({ ok: true }));
    await send({ type: "eval", code: "x = 1" });
    // `undefined` would drop out of the JSON message entirely and the webview
    // would sit waiting for a result that never arrives.
    expect(posted("result")).toEqual({ type: "result", value: null });
  });

  it("shows the Lua error a failed chunk produced", async () => {
    gui.answer("replEval", () => ({ ok: false, err: "attempt to index a nil value" }));
    await send({ type: "eval", code: "return nil.x" });
    expect(posted("error")).toEqual({
      type: "error",
      message: "attempt to index a nil value",
    });
  });

  it("still says something when a failure carries no message", async () => {
    gui.answer("replEval", () => ({ ok: false }));
    await send({ type: "eval", code: "return 1" });
    expect(posted("error")).toEqual({ type: "error", message: "error" });
  });

  it("reports a bridge that dropped mid-call", async () => {
    gui.answer("replEval", () => Promise.reject(new Error("gui bridge not connected")));
    await send({ type: "eval", code: "return 1" });
    // DCS quitting mid-eval must land as a console error, not an unhandled
    // rejection with the prompt stuck.
    expect(posted("error")).toEqual({ type: "error", message: "gui bridge not connected" });
  });

  it("ignores an eval with no code", async () => {
    await send({ type: "eval" });
    expect(gui.calls).toEqual([]);
  });
});

describe("the explorer", () => {
  it("answers an inspect with the Lua type, keeping the envelope's own type", async () => {
    gui.answer("replInspect", () => ({ ok: true, type: "table", value: "{...}", ref: 7 }));
    await send({ type: "inspect", id: 3, expr: "Group" });
    // `luaType`, not `type`: the envelope's `type` is how the webview routes
    // the message at all, so a Lua value called "table" must not shadow it.
    expect(posted("inspectResult")).toEqual({
      type: "inspectResult",
      id: 3,
      env: "gui",
      expr: "Group",
      ok: true,
      err: undefined,
      luaType: "table",
      value: "{...}",
      ref: 7,
    });
  });

  it("answers a failed inspect against the same request id", async () => {
    gui.answer("replInspect", () => Promise.reject(new Error("bridge closed")));
    await send({ type: "inspect", id: 9, expr: "Group", env: "gui" });
    // The webview keys pending nodes by id; an unanswered one spins forever.
    expect(posted("inspectResult")).toEqual({
      type: "inspectResult",
      id: 9,
      env: "gui",
      expr: "Group",
      ok: false,
      err: "bridge closed",
    });
  });

  it("ignores an inspect with no expression", async () => {
    await send({ type: "inspect", id: 1 });
    expect(gui.calls).toEqual([]);
  });

  it("expands a table into its children", async () => {
    gui.answer("replExpand", () => ({ variables: [{ name: "id", value: "1" }] }));
    await send({ type: "expand", ref: 7, nodeId: 12 });
    expect(gui.lastCall("replExpand")?.args).toEqual(["gui", 7]);
    expect(posted("expandResult")).toEqual({
      type: "expandResult",
      nodeId: 12,
      ok: true,
      variables: [{ name: "id", value: "1" }],
    });
  });

  it("treats an expansion with no variables as an empty node", async () => {
    gui.answer("replExpand", () => ({}));
    await send({ type: "expand", ref: 7, nodeId: 12 });
    // A missing list would leave the tree node marked as still loading.
    expect(posted("expandResult")).toMatchObject({ ok: true, variables: [] });
  });

  it("answers a failed expansion so the node stops loading", async () => {
    gui.answer("replExpand", () => Promise.reject(new Error("ref expired")));
    await send({ type: "expand", ref: 7, nodeId: 12 });
    expect(posted("expandResult")).toEqual({
      type: "expandResult",
      nodeId: 12,
      ok: false,
      err: "ref expired",
    });
  });

  it("ignores an expand with no ref", async () => {
    await send({ type: "expand", nodeId: 1 });
    expect(gui.calls).toEqual([]);
  });

  it("resolves a function signature on demand", async () => {
    gui.answer("replSignature", () => ({ ok: true, params: ["id", "name"], native: false }));
    await send({ type: "signature", ref: 4, reqId: 88 });
    expect(posted("signatureResult")).toEqual({
      type: "signatureResult",
      reqId: 88,
      ok: true,
      params: ["id", "name"],
      native: false,
      err: undefined,
    });
  });

  it("answers a failed signature lookup against its request id", async () => {
    gui.answer("replSignature", () => Promise.reject("not a function"));
    await send({ type: "signature", ref: 4, reqId: 88 });
    // A non-Error rejection still has to come back as text the tooltip can show.
    expect(posted("signatureResult")).toEqual({
      type: "signatureResult",
      reqId: 88,
      ok: false,
      err: "not a function",
    });
  });

  it("ignores a signature request with no ref", async () => {
    await send({ type: "signature", reqId: 1 });
    expect(gui.calls).toEqual([]);
  });

  it("releases held refs in each env the tree touched", async () => {
    await send({ type: "clearExplorer", envs: ["gui", "mission"] });
    // Refs pin Lua values in the sim; never releasing them leaks memory inside
    // DCS for as long as it runs.
    expect(gui.lastCall("replClear")?.args).toEqual(["gui"]);
    expect(mission.lastCall("replClear")?.args).toEqual(["mission"]);
  });

  it("keeps clearing the other envs when one is already gone", async () => {
    mission.answer("replClear", () => Promise.reject(new Error("mission bridge not connected")));
    await send({ type: "clearExplorer", envs: ["mission", "gui"] });
    // A finished mission took its refs with it — nothing to release, and no
    // reason to abandon the GUI state's.
    expect(gui.lastCall("replClear")?.args).toEqual(["gui"]);
  });

  it("clears nothing when the tree never reached a bridge", async () => {
    await send({ type: "clearExplorer" });
    expect(gui.calls).toEqual([]);
    expect(mission.calls).toEqual([]);
  });
});

describe("exporting a table", () => {
  beforeEach(() => {
    gui.answer("replExport", () => ({ path: TEMP, bytes: 1024 }));
    seedFile(TEMP, '{"a":1}');
  });

  it("copies the sim's file to the chosen path and opens it", async () => {
    state.saveDialogReplies = [TARGET];
    await send({ type: "export", ref: 5, label: "db.Units", reqId: 2 });

    // The sim serializes to disk because a whole table would never fit through
    // the WebSocket.
    expect(gui.lastCall("replExport")?.args).toEqual(["gui", { ref: 5, expr: undefined }]);
    expect(seededText(TARGET)).toBe('{"a":1}');
    expect(state.shownDocuments).toEqual([TARGET]);
    expect(posted("exportDone")).toEqual({ type: "exportDone", reqId: 2, saved: true });
  });

  it("names the file after the node the user exported", async () => {
    state.saveDialogReplies = [TARGET];
    await send({ type: "export", expr: "db.Units", label: "db.Units", reqId: 2 });
    const options = state.saveDialogOptions[0] as { defaultUri: { fsPath: string } };
    expect(options.defaultUri.fsPath).toBe("C:\\work\\db.Units.json");
  });

  it("proposes the home directory when no folder is open", async () => {
    resetVscode();
    seedFile(TEMP, "{}");
    state.saveDialogReplies = [TARGET];
    await send({ type: "export", ref: 5, reqId: 2 });
    const options = state.saveDialogOptions[0] as { defaultUri: { fsPath: string } };
    expect(options.defaultUri.fsPath).toBe(`${os.homedir()}/lua-export.json`);
  });

  it("announces an export too large to open rather than opening it", async () => {
    gui.answer("replExport", () => ({ path: TEMP, bytes: EXPORT_OPEN_LIMIT_BYTES }));
    state.saveDialogReplies = [TARGET];

    await send({ type: "export", ref: 5, reqId: 2 });

    // Loading tens of MB of JSON into an editor tab locks VS Code up.
    expect(state.shownDocuments).toEqual([]);
    expect(state.info).toEqual([expect.stringContaining(TARGET)]);
  });

  it("reports a cancelled save and still clears the sim's temp file", async () => {
    state.saveDialogReplies = [undefined];

    await send({ type: "export", ref: 5, reqId: 2 });

    expect(posted("exportDone")).toEqual({ type: "exportDone", reqId: 2, saved: false });
    // The sim already wrote it; leaving it behind litters the DCS write dir.
    expect(seededText(TEMP)).toBeUndefined();
  });

  it("keeps the export when the sim's temp file cannot be removed", async () => {
    vi.spyOn(vscode.workspace.fs, "delete").mockRejectedValueOnce(new Error("EBUSY"));
    state.saveDialogReplies = [TARGET];

    await send({ type: "export", ref: 5, reqId: 2 });

    expect(seededText(TARGET)).toBe('{"a":1}');
    expect(posted("exportDone")).toMatchObject({ saved: true });
  });

  it("tidies the sim's temp file even when the copy to the workspace fails", async () => {
    // The failure path leaked: a full disk or a read-only destination left a
    // multi-megabyte dcs-studio-export-*.json in the DCS write dir, forever,
    // with nothing in the UI to suggest it was there.
    vi.spyOn(vscode.workspace.fs, "copy").mockRejectedValueOnce(
      new Error("ENOSPC: no space left on device"),
    );
    state.saveDialogReplies = [TARGET];

    await send({ type: "export", ref: 5, reqId: 2 });

    expect(posted("exportDone")).toEqual({
      type: "exportDone",
      reqId: 2,
      saved: false,
      error: "ENOSPC: no space left on device",
    });
    expect(seededText(TEMP)).toBeUndefined();
    expect(seededText(TARGET)).toBeUndefined();
  });

  it("answers with the failure when the sim could not serialize the table", async () => {
    gui.answer("replExport", () => Promise.reject(new Error("cannot serialize userdata")));

    await send({ type: "export", ref: 5, reqId: 2 });

    expect(posted("exportDone")).toEqual({
      type: "exportDone",
      reqId: 2,
      saved: false,
      error: "cannot serialize userdata",
    });
  });
});

describe("the offline call to action", () => {
  it("funnels the status line's launch button into the launch command", async () => {
    await send({ type: "launch" });
    // One implementation of launching, shared with the palette and status bar.
    expect(state.executedCommands).toEqual([{ command: "dcs.bridge.launch", args: [] }]);
  });

  it("ignores a message type it does not handle", async () => {
    await send({ type: "somethingElse" });
    expect(gui.calls).toEqual([]);
    expect(state.executedCommands).toEqual([]);
  });
});

describe("tailing sim output", () => {
  it("reads nothing while a bridge is offline", async () => {
    await vi.advanceTimersByTimeAsync(1000);
    // Polling a closed socket just throws once a second for the whole session.
    expect(gui.calls).toEqual([]);
    expect(mission.calls).toEqual([]);
  });

  it("streams print output from both bridges independently", async () => {
    gui.emit(CONNECTED);
    mission.emit(CONNECTED);
    gui.answer("consoleRead", () => ({ lines: [{ seq: 1, text: "gui line" }], latest: 1 }));
    mission.answer("consoleRead", () => ({
      lines: [{ seq: 1, text: "mission line" }],
      latest: 1,
    }));

    await vi.advanceTimersByTimeAsync(1000);

    // Each bridge has its own output ring, so both have to be tailed or half
    // the sim's print output never appears.
    const texts = panel.webview
      .postedOfType("print")
      .flatMap((m) => (m.lines as { text: string }[]).map((l) => l.text));
    expect(texts.sort()).toEqual(["gui line", "mission line"]);
  });

  it("says nothing while the sim is idle", async () => {
    gui.emit(CONNECTED);
    gui.answer("consoleRead", () => ({ lines: [], latest: 0 }));

    await vi.advanceTimersByTimeAsync(3000);

    // A mission that never calls print still polls once a second; posting an
    // empty batch each time would churn the webview forever.
    expect(panel.webview.postedOfType("print")).toEqual([]);
    expect(gui.calls.map((c) => c.args[0])).toEqual([0, 0, 0]);
  });

  it("advances the cursor without posting when the ring only dropped old lines", async () => {
    gui.emit(CONNECTED);
    gui.answer("consoleRead", () => ({ lines: [], latest: 40 }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(panel.webview.postedOfType("print")).toEqual([]);

    gui.answer("consoleRead", () => ({ lines: [{ seq: 41, text: "next" }], latest: 41 }));
    await vi.advanceTimersByTimeAsync(1000);
    // Re-reading from 0 would replay the whole ring as if it were new output.
    expect(gui.lastCall("consoleRead")?.args).toEqual([40]);
  });

  it("reads from the cursor it reached, not from the start", async () => {
    gui.emit(CONNECTED);
    gui.answer("consoleRead", () => ({ lines: [{ seq: 5, text: "a" }], latest: 5 }));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(gui.calls.map((c) => c.args[0])).toEqual([0, 5]);
  });

  it("rereads the ring from the start after DCS restarts", async () => {
    gui.emit(CONNECTED);
    gui.answer("consoleRead", () => ({ lines: [{ seq: 9, text: "a" }], latest: 9 }));
    await vi.advanceTimersByTimeAsync(1000);

    gui.emit(OFFLINE);
    await vi.advanceTimersByTimeAsync(1000);
    gui.emit(CONNECTED);
    await vi.advanceTimersByTimeAsync(1000);

    // The bridge server restarts with DCS and its ring starts again at zero;
    // keeping the old cursor would hide every line of the new session.
    expect(gui.calls.map((c) => c.args[0])).toEqual([0, 0]);
  });

  it("keeps polling after a read fails", async () => {
    gui.emit(CONNECTED);
    gui.answer("consoleRead", () => Promise.reject(new Error("timed out")));
    await vi.advanceTimersByTimeAsync(1000);
    gui.answer("consoleRead", () => ({ lines: [{ seq: 1, text: "back" }], latest: 1 }));
    await vi.advanceTimersByTimeAsync(1000);
    // A dropped frame must not end the tail for the rest of the session.
    expect(posted("print")).toMatchObject({ lines: [{ seq: 1, text: "back" }] });
  });
});

describe("closing the console", () => {
  it("stops polling and drops every subscription", async () => {
    gui.emit(CONNECTED);

    panel.dispose();

    expect(ConsolePanel.current).toBeUndefined();
    // A panel that keeps its timer and listeners goes on calling a disposed
    // webview for the rest of the session.
    expect(gui.listenerCount).toBe(0);
    expect(mission.listenerCount).toBe(0);
    const before = gui.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(gui.calls.length).toBe(before);
  });
});
