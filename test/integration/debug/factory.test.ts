import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetVscode, state, vscodeMock } from "../support/vscode";

vi.mock("vscode", () => vscodeMock());

import * as vscode from "vscode";
import type { BridgeClient } from "../../../src/bridge/client";
import { BridgeClients } from "../../../src/bridge/clients";
import { DcsDebugAdapter } from "../../../src/debug/adapter";
import {
  DcsDebugAdapterFactory,
  DcsDebugConfigProvider,
  DEBUG_TYPE,
  registerDebugCommands,
} from "../../../src/debug/factory";
import { FakeBridge, FakeScheduler, settle } from "./fakes";

// Everything VS Code needs registered before a `dcs-lua` session can exist: the
// inline adapter factory, the configuration provider that makes bare F5 work,
// and the four run/debug commands behind the editor title-bar buttons.

const WORKSPACE = "C:\\work";
const LUA = "C:\\work\\mods\\script.lua";

function uri(fsPath: string, scheme = "file"): vscode.Uri {
  return { fsPath, scheme, toString: () => `${scheme}://${fsPath}` } as unknown as vscode.Uri;
}

describe("debug registration", () => {
  let gui: FakeBridge;
  let clients: BridgeClients;

  beforeEach(() => {
    resetVscode({ workspaceFolders: [WORKSPACE] });
    gui = new FakeBridge();
    clients = new BridgeClients(
      gui as unknown as BridgeClient,
      new FakeBridge() as unknown as BridgeClient,
    );
  });

  describe("the inline adapter factory", () => {
    it("builds an in-process adapter over the shared clients and scheduler", async () => {
      // Inline, not a spawned process: the session has to share the extension's
      // two live connections rather than opening its own. The scheduler has to
      // reach it too, or every session's poll loop runs on real timers.
      const scheduler = new FakeScheduler();
      const factory = new DcsDebugAdapterFactory(clients, scheduler);
      const descriptor = (await factory.createDebugAdapterDescriptor({
        configuration: { type: DEBUG_TYPE, name: "s", request: "launch", program: LUA, env: "gui" },
      } as vscode.DebugSession)) as unknown as { implementation: DcsDebugAdapter };

      expect(descriptor.implementation).toBeInstanceOf(DcsDebugAdapter);

      // The buffer stands in for the file so the session gets past loading it;
      // the run then blocks, as a real one does.
      state.textDocuments.push({
        uri: uri(LUA),
        isDirty: false,
        getText: () => "print(1)",
      });
      gui.debugRun.mockImplementation(() => new Promise(() => {}));
      descriptor.implementation.handleMessage({
        seq: 1,
        type: "request",
        command: "configurationDone",
      } as vscode.DebugProtocolMessage);
      await settle();
      expect(gui.debugRun).toHaveBeenCalled();
      expect(scheduler.liveIntervals.sort()).toEqual([250, 500]);
    });
  });

  describe("the configuration provider", () => {
    it("debugs the active Lua file when F5 is pressed with no launch.json", () => {
      state.textDocuments.push({ uri: uri(LUA), isDirty: false, fileName: LUA });
      (vscode.window as { activeTextEditor: unknown }).activeTextEditor = {
        document: { fileName: LUA },
      };
      expect(
        new DcsDebugConfigProvider().resolveDebugConfiguration(undefined, {} as never),
      ).toEqual({
        type: DEBUG_TYPE,
        name: "Debug Lua in DCS Mission",
        request: "launch",
        program: LUA,
        env: "mission",
      });
    });

    it("refuses a bare F5 when the active editor is not Lua", () => {
      (vscode.window as { activeTextEditor: unknown }).activeTextEditor = {
        document: { fileName: "C:\\work\\README.md" },
      };
      expect(
        new DcsDebugConfigProvider().resolveDebugConfiguration(undefined, {} as never),
      ).toBeUndefined();
      expect(state.errors).toEqual(["Open a .lua file to debug it in DCS."]);
    });

    it("refuses a bare F5 with no editor open at all", () => {
      (vscode.window as { activeTextEditor: unknown }).activeTextEditor = undefined;
      expect(
        new DcsDebugConfigProvider().resolveDebugConfiguration(undefined, {} as never),
      ).toBeUndefined();
      expect(state.errors).toHaveLength(1);
    });

    it("fills the gaps in a hand-written configuration", () => {
      // An unknown env must land on mission rather than being passed to a
      // bridge that would reject it.
      expect(
        new DcsDebugConfigProvider().resolveDebugConfiguration(undefined, {
          type: DEBUG_TYPE,
          name: "mine",
          request: "launch",
          env: "server",
        } as never),
      ).toEqual({
        type: DEBUG_TYPE,
        name: "mine",
        request: "launch",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: VS Code's own launch.json variable
        program: "${file}",
        env: "mission",
      });
    });

    it("leaves an explicit gui configuration alone", () => {
      expect(
        new DcsDebugConfigProvider().resolveDebugConfiguration(undefined, {
          type: DEBUG_TYPE,
          name: "mine",
          request: "launch",
          program: LUA,
          env: "gui",
        } as never),
      ).toMatchObject({ program: LUA, env: "gui" });
    });

    it("offers both environments as launch.json snippets", () => {
      const provided = new DcsDebugConfigProvider().provideDebugConfigurations() as {
        env: string;
      }[];
      expect(provided.map((c) => c.env)).toEqual(["mission", "gui"]);
    });
  });

  describe("the run/debug commands", () => {
    function register(): void {
      registerDebugCommands({ subscriptions: [] } as unknown as vscode.ExtensionContext);
    }

    async function run(command: string, ...args: unknown[]): Promise<void> {
      await state.registeredCommands.get(command)?.(...args);
    }

    it("registers all four editor buttons", () => {
      register();
      expect([...state.registeredCommands.keys()]).toEqual([
        "dcs.debug.runMission",
        "dcs.debug.debugMission",
        "dcs.debug.runGui",
        "dcs.debug.debugGui",
      ]);
    });

    it.each([
      ["dcs.debug.runMission", "mission", true, "Run in DCS Mission"],
      ["dcs.debug.debugMission", "mission", false, "Debug in DCS Mission"],
      ["dcs.debug.runGui", "gui", true, "Run in DCS GUI"],
      ["dcs.debug.debugGui", "gui", false, "Debug in DCS GUI"],
    ])("%s starts a %s session", async (command, env, noDebug, name) => {
      register();
      await run(command, uri(LUA));
      expect(state.startedDebugSessions).toEqual([
        {
          folder: state.workspaceFolders?.[0],
          config: { type: DEBUG_TYPE, name, request: "launch", program: LUA, env },
          options: { noDebug },
        },
      ]);
    });

    it("falls back to the active editor when invoked from the command palette", async () => {
      (vscode.window as { activeTextEditor: unknown }).activeTextEditor = {
        document: { uri: uri(LUA) },
      };
      register();
      await run("dcs.debug.debugMission");
      expect(state.startedDebugSessions[0].config.program).toBe(LUA);
    });

    it("saves an unsaved buffer before running it", async () => {
      // The bridge is handed the file's chunkname; running a stale save would
      // put breakpoints on lines that have moved.
      const save = vi.fn(() => Promise.resolve(true));
      state.textDocuments.push({ uri: uri(LUA), isDirty: true, save });
      register();
      await run("dcs.debug.runMission", uri(LUA));
      expect(save).toHaveBeenCalled();
      expect(state.startedDebugSessions).toHaveLength(1);
    });

    it("leaves a clean buffer alone", async () => {
      const save = vi.fn(() => Promise.resolve(true));
      state.textDocuments.push({ uri: uri(LUA), isDirty: false, save });
      register();
      await run("dcs.debug.runMission", uri(LUA));
      expect(save).not.toHaveBeenCalled();
    });

    it.each([
      ["nothing is open", undefined],
      ["the target is not a file on disk", uri(LUA, "untitled")],
      ["the target is not Lua", uri("C:\\work\\notes.md")],
    ])("refuses when %s", async (_case, target) => {
      (vscode.window as { activeTextEditor: unknown }).activeTextEditor = undefined;
      register();
      await run("dcs.debug.runMission", target);
      expect(state.errors).toEqual(["Open a .lua file to run it in DCS."]);
      expect(state.startedDebugSessions).toEqual([]);
    });

    // MissionScripting.lua is the file that DEFINES the mission sandbox the
    // bridge lives inside; evaluating it in that sandbox re-runs its own
    // sanitization. The menu contributions hide these four commands for it, but
    // a `when` clause only governs menus — the Command Palette, a keybinding
    // and executeCommand all land on the handler, so that is where it has to be
    // refused (issue #23).
    it.each([
      "dcs.debug.runMission",
      "dcs.debug.debugMission",
      "dcs.debug.runGui",
      "dcs.debug.debugGui",
    ])("refuses to send MissionScripting.lua to the sim via %s", async (command) => {
      register();
      await run(command, uri("C:\\DCS\\Scripts\\MissionScripting.lua"));
      expect(state.errors).toEqual([
        "MissionScripting.lua defines the mission sandbox — it cannot be run or debugged in DCS. " +
          "Use “DCS Studio: Desanitize MissionScripting.lua” to edit what it allows.",
      ]);
      expect(state.startedDebugSessions).toEqual([]);
    });

    it.each([
      [
        "invoked from the palette with it as the active editor",
        "C:\\DCS\\Scripts\\missionscripting.lua",
      ],
      ["reached through a posix path", "/opt/dcs/Scripts/MissionScripting.lua"],
    ])("refuses it when %s", async (_case, fsPath) => {
      // The refusal keys off the file NAME, so it holds however the path was
      // spelled — the sim only ever sees the text, not where it came from.
      (vscode.window as { activeTextEditor: unknown }).activeTextEditor = {
        document: { uri: uri(fsPath) },
      };
      register();
      await run("dcs.debug.runMission");
      expect(state.startedDebugSessions).toEqual([]);
      expect(state.errors).toHaveLength(1);
    });

    it("still runs a file that merely ends with the same name", async () => {
      // A path-boundary check, not a suffix one: `my-MissionScripting.lua` is
      // an ordinary script and must not be caught by the exclusion.
      register();
      await run("dcs.debug.runMission", uri("C:\\work\\my-MissionScripting.lua"));
      expect(state.errors).toEqual([]);
      expect(state.startedDebugSessions).toHaveLength(1);
    });
  });
});
