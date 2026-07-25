import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mappedBridgeFs } from "../bridge/mappedBridgeFs";
import { resetVscode, state, vscodeMock } from "../support/vscode";

vi.mock("vscode", () => vscodeMock());

const transport = vi.hoisted(() => ({ conns: [] as { closed: boolean }[] }));
vi.mock("../../../src/adapters/node/wsTransport", () => ({
  WsBridgeTransport: class {
    connect(): { send(): void; close(): void } {
      const conn = {
        closed: false,
        send: () => {},
        close: () => {
          conn.closed = true;
        },
      };
      transport.conns.push(conn);
      return conn;
    }
  },
}));

import * as vscode from "vscode";
import { useBridgeFs } from "../../../src/bridge/deploy";
import { activate, deactivate } from "../../../src/extension";

// Shutdown. `deactivate()` is the last thing VS Code calls, and it is the only
// place the bridge DLLs get taken back out of a user's DCS install — skip it
// and the extension's DLLs stay loaded into every later DCS run, including runs
// started outside the editor entirely.
//
// This lives apart from the activation spec because the module-level bridge
// handle survives for the life of the extension host: reaching the
// "deactivate before anything was ever activated" state needs a module that
// has not been activated yet, and within this file that means going first.

const EXT = "C:\\ext";
const SAVED_GAMES = "D:\\Saved Games\\DCS";
const GUI_DLL = `${SAVED_GAMES}\\Mods\\tech\\DcsStudio\\bin\\dcs_studio_gui.dll`;
const HOOK = `${SAVED_GAMES}\\Scripts\\Hooks\\DcsStudio.lua`;

let root: string;
let io: ReturnType<typeof mappedBridgeFs>;
let restoreBridgeFs: () => void;

/** The eject is fire-and-forget (nothing may block shutdown), so poll for it. */
async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
}

/** An install with the bridge currently injected. */
function seedInjectedBridge(): void {
  io.seed(GUI_DLL, "gui");
  io.seed(`${SAVED_GAMES}\\Mods\\tech\\DcsStudio\\bin\\dcs_studio_mission.dll`, "mission");
  io.seed(HOOK, "hook");
}

beforeEach(() => {
  root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "dcs-studio-deactivate-"));
  io = mappedBridgeFs(root);
  restoreBridgeFs = useBridgeFs(io);
  resetVscode({ config: { "dcsStudio.savedGamesPath": SAVED_GAMES } });
  transport.conns.length = 0;
});

afterEach(() => {
  restoreBridgeFs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("deactivate", () => {
  it("ejects the bridge even when activation never got as far as the clients", async () => {
    seedInjectedBridge();

    deactivate();
    await until(() => !io.exists(HOOK));

    // A failed activation still leaves whatever a previous session injected;
    // shutdown has to be safe to call with nothing wired up.
    expect(io.exists(GUI_DLL)).toBe(false);
    expect(io.exists(HOOK)).toBe(false);
  });

  it("closes the bridge sockets and ejects the DLLs when the window goes away", async () => {
    seedInjectedBridge();
    activate({
      subscriptions: [],
      extensionUri: vscode.Uri.file(EXT),
      extensionPath: EXT,
      extensionMode: vscode.ExtensionMode.Production,
      globalState: { get: () => undefined, update: () => Promise.resolve() },
      workspaceState: { get: () => undefined, update: () => Promise.resolve() },
    } as unknown as vscode.ExtensionContext);
    expect(transport.conns).toHaveLength(2);

    deactivate();
    await until(() => !io.exists(GUI_DLL));

    // Leaving the sockets open keeps the reconnect backoff timers alive after
    // the host is meant to be gone.
    expect(transport.conns.map((c) => c.closed)).toEqual([true, true]);
    expect(io.exists(GUI_DLL)).toBe(false);
    expect(state.errors).toEqual([]);
  });
});
