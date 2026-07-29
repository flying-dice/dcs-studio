import * as os from "node:os";
import * as nodePath from "node:path";
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

// The shell around ConsolePresenter: the webview panel, the settings read, the
// poll timer, and the URI plumbing behind a table export. The console's own
// decisions — env routing, request validation, error→message mapping, the
// per-bridge output cursor — belong to the presenter and are asserted without
// an editor in test/unit/bridge/consolePresenter.test.ts. What is left here is
// the wiring, and it is worth its own layer: a settings read that never reaches
// the explorer, a timer that outlives its panel, or a sim-side temp file nobody
// deletes are all failures no amount of pure-logic testing would catch.

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
const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

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
  it("pushes the sweep budget read from the user's settings", () => {
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
    // the WebSocket, so the editor half of the export is a file copy.
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
    expect(options.defaultUri.fsPath).toBe(nodePath.join(os.homedir(), "lua-export.json"));
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
});

describe("the offline call to action", () => {
  it("funnels the status line's launch button into the launch command", async () => {
    await send({ type: "launch" });
    // One implementation of launching, shared with the palette and status bar.
    expect(state.executedCommands).toEqual([{ command: "dcs.bridge.launch", args: [] }]);
  });
});

describe("tailing sim output", () => {
  it("polls both bridges on the interval the panel starts", async () => {
    gui.emit(CONNECTED);
    mission.emit(CONNECTED);
    gui.answer("consoleRead", () => ({ lines: [{ seq: 1, text: "gui line" }], latest: 1 }));
    mission.answer("consoleRead", () => ({
      lines: [{ seq: 1, text: "mission line" }],
      latest: 1,
    }));

    await vi.advanceTimersByTimeAsync(1000);

    // Each bridge has its own output ring, so both have to be handed to the
    // presenter or half the sim's print output never appears.
    const texts = panel.webview
      .postedOfType("print")
      .flatMap((m) => (m.lines as { text: string }[]).map((l) => l.text));
    expect(texts.sort()).toEqual(["gui line", "mission line"]);
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
