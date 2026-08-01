import * as os from "node:os";
import * as nodePath from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetVscode, seededText, seedFile, state, vscodeMock } from "../support/vscode";

vi.mock("vscode", () => vscodeMock());

import * as vscode from "vscode";
import type { BridgeClient } from "../../../src/bridge/client";
import { BridgeClients } from "../../../src/bridge/clients";
import { dbExportCommand } from "../../../src/bridge/dbExport";
import { EXPORT_OPEN_LIMIT_BYTES } from "../../../src/core/domain/bridgeConsole";
import {
  BRIDGE_TORN_DOWN,
  BridgeRpcError,
  PUMP_STALLED,
} from "../../../src/core/domain/bridgeProtocol";
import { CONNECTED, FakeBridgeClient } from "./fakeBridgeClient";

// Exporting the DCS database is a quick-pick funnel onto one RPC, and the whole
// point of the design is that the dump never rides the WebSocket: the sim writes
// a file inside its own write dir and this copies it where the user asked. Every
// step after that is about not losing or stranding data — a save the user
// cancelled, a temp file left in Saved Games, a dump too large to open without
// hanging the editor.

const TEMP = "D:\\Saved Games\\DCS\\dcs-studio-db-export.json";
const TARGET = "C:\\work\\dump.json";
const WORKSPACE = "C:\\work";

let gui: FakeBridgeClient;
let mission: FakeBridgeClient;
let clients: BridgeClients;

/** The scope quick-pick's reply, as the command's own items are shaped. */
function scope(s: "all" | "weapons" | "category" | "unit"): { scope: string } {
  return { scope: s };
}

function saveDialogDefault(index = 0): string {
  return (state.saveDialogOptions[index] as { defaultUri: { fsPath: string } }).defaultUri.fsPath;
}

beforeEach(() => {
  resetVscode({ workspaceFolders: [WORKSPACE] });
  gui = new FakeBridgeClient();
  mission = new FakeBridgeClient();
  gui.status = CONNECTED;
  clients = new BridgeClients(gui as unknown as BridgeClient, mission as unknown as BridgeClient);
  gui.answer("dbExport", () => ({ path: TEMP, bytes: 2048 }));
  seedFile(TEMP, "{}");
});

describe("when the sim is not reachable", () => {
  it("explains how to get connected instead of opening a picker", async () => {
    gui.status = { connected: false, dcsTime: null, stalled: false };
    await dbExportCommand(clients);
    // db_export runs inside DCS; without the bridge there is nothing to ask.
    expect(state.errors).toEqual([expect.stringContaining("Launch DCS with the bridge")]);
    expect(state.saveDialogOptions).toEqual([]);
    expect(gui.calls).toEqual([]);
  });
});

describe("choosing what to export", () => {
  it("exports the whole database", async () => {
    state.quickPickReplies = [scope("all")];
    state.saveDialogReplies = [TARGET];

    await dbExportCommand(clients);

    expect(gui.lastCall("dbExport")?.args).toEqual(["all"]);
    expect(saveDialogDefault()).toBe("C:\\work\\dcs-db-all.json");
  });

  it("exports the weapons table without asking for a category", async () => {
    state.quickPickReplies = [scope("weapons")];
    state.saveDialogReplies = [TARGET];

    await dbExportCommand(clients);

    // db.Weapons is not a unit category, so the category listing would be a
    // dead end.
    expect(gui.calls.map((c) => c.method)).toEqual(["dbExport"]);
    expect(gui.lastCall("dbExport")?.args).toEqual(["weapons"]);
  });

  it("lists the sim's own categories and exports the chosen one", async () => {
    gui.answer("dbCategories", () => ({
      categories: [{ name: "Planes", entry_key: "Planes", count: 120 }],
    }));
    state.quickPickReplies = [scope("category"), { label: "Planes" }];
    state.saveDialogReplies = [TARGET];

    await dbExportCommand(clients);

    // The categories come from the installed modules, so they cannot be a
    // hard-coded list.
    expect(gui.calls.map((c) => c.method)).toEqual(["dbCategories", "dbExport"]);
    expect(gui.lastCall("dbExport")?.args).toEqual(["category:Planes"]);
    expect(saveDialogDefault()).toBe("C:\\work\\dcs-db-category-Planes.json");
  });

  it("narrows a category down to one unit type", async () => {
    gui.answer("dbCategories", () => ({
      categories: [{ name: "Planes", entry_key: "Planes", count: 120 }],
    }));
    gui.answer("dbUnitTypes", () => ({
      units: [{ type: "F-16C_50", display_name: "F-16C Viper", category: "Planes" }],
    }));
    state.quickPickReplies = [scope("unit"), { label: "Planes" }, { label: "F-16C_50" }];
    state.saveDialogReplies = [TARGET];

    await dbExportCommand(clients);

    // The unit list is scoped to the picked category — the full type list runs
    // to thousands of entries.
    expect(gui.lastCall("dbUnitTypes")?.args).toEqual([{ category: "Planes" }]);
    expect(gui.lastCall("dbExport")?.args).toEqual(["unit:F-16C_50"]);
  });

  it("stops when the scope pick is dismissed", async () => {
    state.quickPickReplies = [undefined];
    await dbExportCommand(clients);
    expect(gui.calls).toEqual([]);
    expect(state.saveDialogOptions).toEqual([]);
  });

  it("stops when the category pick is dismissed", async () => {
    gui.answer("dbCategories", () => ({ categories: [] }));
    state.quickPickReplies = [scope("category"), undefined];
    await dbExportCommand(clients);
    expect(gui.lastCall("dbExport")).toBeUndefined();
  });

  it("stops when the unit pick is dismissed", async () => {
    gui.answer("dbCategories", () => ({ categories: [] }));
    gui.answer("dbUnitTypes", () => ({ units: [] }));
    state.quickPickReplies = [scope("unit"), { label: "Planes" }, undefined];
    await dbExportCommand(clients);
    expect(gui.lastCall("dbExport")).toBeUndefined();
  });
});

describe("saving the dump", () => {
  it("copies the sim's file to the chosen path and opens it", async () => {
    state.quickPickReplies = [scope("all")];
    state.saveDialogReplies = [TARGET];
    seedFile(TEMP, '{"units":1}');

    await dbExportCommand(clients);

    expect(seededText(TARGET)).toBe('{"units":1}');
    expect(state.shownDocuments).toEqual([TARGET]);
  });

  it("announces a dump too large to open rather than opening it", async () => {
    gui.answer("dbExport", () => ({ path: TEMP, bytes: EXPORT_OPEN_LIMIT_BYTES }));
    state.quickPickReplies = [scope("all")];
    state.saveDialogReplies = [TARGET];

    await dbExportCommand(clients);

    // "Everything" is tens of MB; opening it in an editor locks VS Code up.
    expect(state.shownDocuments).toEqual([]);
    expect(state.info).toEqual([expect.stringContaining(TARGET)]);
    expect(seededText(TARGET)).toBe("{}");
  });

  it("proposes the home directory when no folder is open", async () => {
    resetVscode();
    gui.status = CONNECTED;
    seedFile(TEMP, "{}");
    state.quickPickReplies = [scope("all")];
    state.saveDialogReplies = [TARGET];

    await dbExportCommand(clients);

    expect(saveDialogDefault()).toBe(nodePath.join(os.homedir(), "dcs-db-all.json"));
  });

  it("writes nothing when the save dialog is cancelled, but still tidies up", async () => {
    state.quickPickReplies = [scope("all")];
    state.saveDialogReplies = [undefined];

    await dbExportCommand(clients);

    expect(seededText(TARGET)).toBeUndefined();
    // The sim wrote the file regardless; leaving it behind litters Saved Games
    // with multi-megabyte dumps nobody knows about.
    expect(seededText(TEMP)).toBeUndefined();
    expect(state.errors).toEqual([]);
  });

  it("removes the sim-side temp file after a successful copy", async () => {
    state.quickPickReplies = [scope("all")];
    state.saveDialogReplies = [TARGET];

    await dbExportCommand(clients);

    expect(seededText(TEMP)).toBeUndefined();
    expect(seededText(TARGET)).toBe("{}");
  });

  it("keeps the export when the temp file cannot be removed", async () => {
    // The tidy-up is a courtesy: DCS may still hold the file open, and the
    // user's dump is already safely saved.
    vi.spyOn(vscode.workspace.fs, "delete").mockRejectedValueOnce(new Error("EBUSY"));
    state.quickPickReplies = [scope("all")];
    state.saveDialogReplies = [TARGET];

    await dbExportCommand(clients);

    expect(seededText(TARGET)).toBe("{}");
    expect(state.errors).toEqual([]);
  });

  it("tidies the sim-side temp file even when the copy fails", async () => {
    // The failure path leaked: a full disk left tens of megabytes of dump in
    // the DCS write dir with nothing in the UI to suggest it was there.
    vi.spyOn(vscode.workspace.fs, "copy").mockRejectedValueOnce(
      new Error("ENOSPC: no space left on device"),
    );
    state.quickPickReplies = [scope("all")];
    state.saveDialogReplies = [TARGET];

    await dbExportCommand(clients);

    expect(state.errors).toEqual(["DCS database export failed: ENOSPC: no space left on device"]);
    expect(seededText(TEMP)).toBeUndefined();
  });
});

describe("when the export fails", () => {
  it("reports the reason the sim gave", async () => {
    gui.answer("dbExport", () => {
      throw new Error("db_export: out of memory");
    });
    state.quickPickReplies = [scope("all")];

    await dbExportCommand(clients);

    expect(state.errors).toEqual(["DCS database export failed: db_export: out of memory"]);
  });

  it("reports a non-Error failure rather than finishing silently", async () => {
    gui.answer("dbCategories", () => Promise.reject("bridge closed"));
    state.quickPickReplies = [scope("category")];

    await dbExportCommand(clients);

    expect(state.errors).toEqual(["DCS database export failed: bridge closed"]);
  });

  // A long export straddling a mission change, or a held breakpoint stopping
  // the GUI bridge's frame drain, are both ordinary. The user still needs to
  // hear that the export did not finish — what they must not be handed is a
  // button offering to file the sim's own lifecycle as an extension bug.
  it("does not invite a bug report when the mission ended mid-export", async () => {
    gui.answer("dbExport", () => {
      throw new BridgeRpcError("bridge torn down", BRIDGE_TORN_DOWN);
    });
    state.quickPickReplies = [scope("all")];

    await dbExportCommand(clients);

    expect(state.errors).toEqual([]);
    expect(state.warnings).toEqual(["DCS database export did not finish: bridge torn down"]);
  });

  it("does not invite a bug report when the sim was not pumping", async () => {
    gui.answer("dbExport", () => {
      throw new BridgeRpcError("pump stalled", PUMP_STALLED);
    });
    state.quickPickReplies = [scope("all")];

    await dbExportCommand(clients);

    expect(state.errors).toEqual([]);
    expect(state.warnings).toEqual(["DCS database export did not finish: pump stalled"]);
  });

  it("still invites a bug report for a genuine bridge fault", async () => {
    // The suppression has to be narrow: an internal error carries a code too,
    // and it is exactly the kind of thing worth a report.
    gui.answer("dbExport", () => {
      throw new BridgeRpcError("internal error", -32603);
    });
    state.quickPickReplies = [scope("all")];

    await dbExportCommand(clients);

    expect(state.errors).toEqual(["DCS database export failed: internal error"]);
    expect(state.warnings).toEqual([]);
  });
});
