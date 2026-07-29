import { describe, expect, it } from "vitest";
import type {
  ConsoleBridge,
  ConsoleEffect,
  ConsoleExportSave,
  ConsoleInbound,
  ConsolePresenterDeps,
} from "../../../src/core/app/consolePresenter";
import { ConsolePresenter } from "../../../src/core/app/consolePresenter";
import type { DualBridgeStatus } from "../../../src/core/domain/bridgeProtocol";

// The Lua console's host-side behaviour, tested without VS Code.
//
// The console brokers between one webview and two independent bridges, so the
// decisions worth asserting are all about keeping those two straight: a
// mission-env eval sent to the GUI bridge runs in the wrong Lua universe and
// quietly returns nonsense; a request that fails still has to answer against
// its correlation id or the webview waits forever; and each bridge's output
// ring has its own cursor that must go back to zero when its server restarts.

interface RecordedCall {
  method: string;
  args: unknown[];
}

/** A scriptable stand-in for one bridge client — "what the sim answered". */
class FakeBridge implements ConsoleBridge {
  current = { connected: false };
  readonly calls: RecordedCall[] = [];
  private readonly answers = new Map<string, (...args: unknown[]) => unknown>();

  /** Script one method's answer. Reject from `fn` to model a failing RPC. */
  answer(method: string, fn: (...args: unknown[]) => unknown): void {
    this.answers.set(method, fn);
  }

  consoleRead = this.rpc("consoleRead", () => ({ lines: [], latest: 0 }));
  replEval = this.rpc("replEval", () => ({ ok: true }));
  replInspect = this.rpc("replInspect", () => ({ ok: true }));
  replExpand = this.rpc("replExpand", () => ({ variables: [] }));
  replSignature = this.rpc("replSignature", () => ({ ok: true }));
  replClear = this.rpc("replClear", () => ({}));
  replExport = this.rpc("replExport", () => ({ path: "", bytes: 0 }));

  /** The last call to `method`, or undefined if it was never made. */
  lastCall(method: string): RecordedCall | undefined {
    return [...this.calls].reverse().find((c) => c.method === method);
  }

  /** Record the call, then answer from the script (or the default). */
  private rpc(method: string, fallback: () => unknown) {
    return async (...args: unknown[]): Promise<never> => {
      this.calls.push({ method, args });
      return (this.answers.get(method) ?? fallback)(...args) as never;
    };
  }
}

const CONNECTED = { connected: true, dcsTime: 0 };
const OFFLINE = { connected: false, dcsTime: null };
const STATUS: DualBridgeStatus = { gui: CONNECTED, mission: OFFLINE };

interface Harness {
  presenter: ConsolePresenter;
  gui: FakeBridge;
  mission: FakeBridge;
  posted: Record<string, unknown>[];
  effects: ConsoleEffect[];
  saves: ConsoleExportSave[];
  /** Every posted message of `type`, in order. */
  ofType(type: string): Record<string, unknown>[];
  /** The one message of `type`, failing loudly if there isn't exactly one. */
  one(type: string): Record<string, unknown>;
}

function harness(
  over: Partial<Pick<ConsolePresenterDeps, "wildcardDepth" | "saveExport">> & {
    status?: DualBridgeStatus;
  } = {},
): Harness {
  const gui = new FakeBridge();
  const mission = new FakeBridge();
  const posted: Record<string, unknown>[] = [];
  const effects: ConsoleEffect[] = [];
  const saves: ConsoleExportSave[] = [];

  const presenter = new ConsolePresenter({
    bridges: {
      forEnv: (env) => (env === "mission" ? mission : gui),
      get current(): DualBridgeStatus {
        return over.status ?? { gui: gui.current as never, mission: mission.current as never };
      },
    },
    tailed: [gui, mission],
    wildcardDepth: over.wildcardDepth ?? (() => 1),
    post: (msg) => posted.push(msg as Record<string, unknown>),
    effect: (e) => effects.push(e),
    saveExport:
      over.saveExport ??
      (async (request) => {
        saves.push(request);
        return true;
      }),
  });

  const ofType = (type: string): Record<string, unknown>[] => posted.filter((m) => m.type === type);
  return {
    presenter,
    gui,
    mission,
    posted,
    effects,
    saves,
    ofType,
    one: (type) => {
      const all = ofType(type);
      expect(all).toHaveLength(1);
      return all[0];
    },
  };
}

describe("status and configuration", () => {
  it("pushes the sweep budget the explorer has to plan against", () => {
    const h = harness({ wildcardDepth: () => 3 });
    h.presenter.pushConfig();
    // A `**` sweep is bounded by this number; a stale value makes the explorer
    // either refuse legal searches or fire off far more than the sim can serve.
    expect(h.one("explorerConfig")).toEqual({ type: "explorerConfig", wildcardDepth: 3 });
  });

  it("reads the sweep budget fresh on every push", () => {
    let depth = 1;
    const h = harness({ wildcardDepth: () => depth });
    h.presenter.pushConfig();
    depth = 5;
    h.presenter.pushConfig();
    expect(h.ofType("explorerConfig").at(-1)).toEqual({
      type: "explorerConfig",
      wildcardDepth: 5,
    });
  });

  it("forwards a bridge status change to the webview", () => {
    const h = harness();
    h.presenter.pushStatus(STATUS);
    expect(h.one("status")).toEqual({ type: "status", status: STATUS });
  });

  it("replays status and config when the webview says it has booted", async () => {
    const h = harness({ status: STATUS });
    await h.presenter.handle({ type: "ready" });
    // The webview reloads on its own (hidden tab, VS Code restart) and comes
    // back blank; without a replay it shows "offline" over a live bridge.
    expect(h.one("status")).toEqual({ type: "status", status: STATUS });
    expect(h.ofType("explorerConfig")).toHaveLength(1);
  });
});

describe("evaluating Lua", () => {
  it("runs code in the GUI state by default and returns the value", async () => {
    const h = harness();
    h.gui.answer("replEval", () => ({ ok: true, result: 42 }));
    await h.presenter.handle({ type: "eval", code: "return 42" });
    expect(h.gui.lastCall("replEval")?.args).toEqual(["gui", "return 42"]);
    expect(h.one("result")).toEqual({ type: "result", value: 42 });
  });

  it("routes a mission-env eval to the mission bridge", async () => {
    const h = harness();
    h.mission.answer("replEval", () => ({ ok: true, result: "ok" }));
    await h.presenter.handle({ type: "eval", env: "mission", code: "return 1" });
    // The mission scripting state is a different Lua universe; the GUI bridge
    // cannot see anything the mission defined.
    expect(h.mission.lastCall("replEval")?.args).toEqual(["mission", "return 1"]);
    expect(h.gui.calls).toEqual([]);
  });

  it("reports a statement with no value as null rather than nothing", async () => {
    const h = harness();
    h.gui.answer("replEval", () => ({ ok: true }));
    await h.presenter.handle({ type: "eval", code: "x = 1" });
    // `undefined` would drop out of the JSON message entirely and the webview
    // would sit waiting for a result that never arrives.
    expect(h.one("result")).toEqual({ type: "result", value: null });
  });

  it("shows the Lua error a failed chunk produced", async () => {
    const h = harness();
    h.gui.answer("replEval", () => ({ ok: false, err: "attempt to index a nil value" }));
    await h.presenter.handle({ type: "eval", code: "return nil.x" });
    expect(h.one("error")).toEqual({ type: "error", message: "attempt to index a nil value" });
  });

  it("still says something when a failure carries no message", async () => {
    const h = harness();
    h.gui.answer("replEval", () => ({ ok: false }));
    await h.presenter.handle({ type: "eval", code: "return 1" });
    expect(h.one("error")).toEqual({ type: "error", message: "error" });
  });

  it("reports a bridge that dropped mid-call", async () => {
    const h = harness();
    h.gui.answer("replEval", () => Promise.reject(new Error("gui bridge not connected")));
    await h.presenter.handle({ type: "eval", code: "return 1" });
    // DCS quitting mid-eval must land as a console error, not an unhandled
    // rejection with the prompt stuck.
    expect(h.one("error")).toEqual({ type: "error", message: "gui bridge not connected" });
  });

  it("ignores an eval with no code", async () => {
    const h = harness();
    await h.presenter.handle({ type: "eval" });
    expect(h.gui.calls).toEqual([]);
    expect(h.posted).toEqual([]);
  });
});

describe("the explorer", () => {
  it("answers an inspect with the Lua type, keeping the envelope's own type", async () => {
    const h = harness();
    h.gui.answer("replInspect", () => ({ ok: true, type: "table", value: "{...}", ref: 7 }));
    await h.presenter.handle({ type: "inspect", id: 3, expr: "Group" });
    // `luaType`, not `type`: the envelope's `type` is how the webview routes
    // the message at all, so a Lua value called "table" must not shadow it.
    expect(h.one("inspectResult")).toEqual({
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
    const h = harness();
    h.gui.answer("replInspect", () => Promise.reject(new Error("bridge closed")));
    await h.presenter.handle({ type: "inspect", id: 9, expr: "Group", env: "gui" });
    // The webview keys pending nodes by id; an unanswered one spins forever.
    expect(h.one("inspectResult")).toEqual({
      type: "inspectResult",
      id: 9,
      env: "gui",
      expr: "Group",
      ok: false,
      err: "bridge closed",
    });
  });

  it("ignores an inspect with no expression", async () => {
    const h = harness();
    await h.presenter.handle({ type: "inspect", id: 1 });
    expect(h.gui.calls).toEqual([]);
    expect(h.posted).toEqual([]);
  });

  it("expands a table into its children", async () => {
    const h = harness();
    h.gui.answer("replExpand", () => ({ variables: [{ name: "id", value: "1" }] }));
    await h.presenter.handle({ type: "expand", ref: 7, nodeId: 12 });
    expect(h.gui.lastCall("replExpand")?.args).toEqual(["gui", 7]);
    expect(h.one("expandResult")).toEqual({
      type: "expandResult",
      nodeId: 12,
      ok: true,
      variables: [{ name: "id", value: "1" }],
    });
  });

  it("treats an expansion with no variables as an empty node", async () => {
    const h = harness();
    h.gui.answer("replExpand", () => ({}));
    await h.presenter.handle({ type: "expand", ref: 7, nodeId: 12 });
    // A missing list would leave the tree node marked as still loading.
    expect(h.one("expandResult")).toMatchObject({ ok: true, variables: [] });
  });

  it("answers a failed expansion so the node stops loading", async () => {
    const h = harness();
    h.gui.answer("replExpand", () => Promise.reject(new Error("ref expired")));
    await h.presenter.handle({ type: "expand", ref: 7, nodeId: 12 });
    expect(h.one("expandResult")).toEqual({
      type: "expandResult",
      nodeId: 12,
      ok: false,
      err: "ref expired",
    });
  });

  it("ignores an expand with no ref", async () => {
    const h = harness();
    await h.presenter.handle({ type: "expand", nodeId: 1 });
    expect(h.gui.calls).toEqual([]);
    expect(h.posted).toEqual([]);
  });

  it("resolves a function signature on demand", async () => {
    const h = harness();
    h.gui.answer("replSignature", () => ({ ok: true, params: "id, name", native: false }));
    await h.presenter.handle({ type: "signature", ref: 4, reqId: 88 });
    expect(h.gui.lastCall("replSignature")?.args).toEqual(["gui", 4]);
    expect(h.one("signatureResult")).toEqual({
      type: "signatureResult",
      reqId: 88,
      ok: true,
      params: "id, name",
      native: false,
      err: undefined,
    });
  });

  it("answers a failed signature lookup against its request id", async () => {
    const h = harness();
    h.gui.answer("replSignature", () => Promise.reject("not a function"));
    await h.presenter.handle({ type: "signature", ref: 4, reqId: 88 });
    // A non-Error rejection still has to come back as text the tooltip can show.
    expect(h.one("signatureResult")).toEqual({
      type: "signatureResult",
      reqId: 88,
      ok: false,
      err: "not a function",
    });
  });

  it("ignores a signature request with no ref", async () => {
    const h = harness();
    await h.presenter.handle({ type: "signature", reqId: 1 });
    expect(h.gui.calls).toEqual([]);
    expect(h.posted).toEqual([]);
  });

  it("releases held refs in each env the tree touched", async () => {
    const h = harness();
    await h.presenter.handle({ type: "clearExplorer", envs: ["gui", "mission"] });
    // Refs pin Lua values in the sim; never releasing them leaks memory inside
    // DCS for as long as it runs.
    expect(h.gui.lastCall("replClear")?.args).toEqual(["gui"]);
    expect(h.mission.lastCall("replClear")?.args).toEqual(["mission"]);
  });

  it("keeps clearing the other envs when one is already gone", async () => {
    const h = harness();
    h.mission.answer("replClear", () => Promise.reject(new Error("mission bridge not connected")));
    await h.presenter.handle({ type: "clearExplorer", envs: ["mission", "gui"] });
    // A finished mission took its refs with it — nothing to release, and no
    // reason to abandon the GUI state's.
    expect(h.gui.lastCall("replClear")?.args).toEqual(["gui"]);
  });

  it("clears nothing when the tree never reached a bridge", async () => {
    const h = harness();
    await h.presenter.handle({ type: "clearExplorer" });
    expect(h.gui.calls).toEqual([]);
    expect(h.mission.calls).toEqual([]);
  });
});

describe("exporting a table", () => {
  it("hands the sim's file to the host under the exported node's name", async () => {
    const h = harness();
    h.gui.answer("replExport", () => ({ path: "D:\\DCS\\lua-export.json", bytes: 1024 }));
    await h.presenter.handle({ type: "export", ref: 5, label: "db.Units", reqId: 2 });

    // The sim serializes to disk because a whole table would never fit through
    // the WebSocket.
    expect(h.gui.lastCall("replExport")?.args).toEqual(["gui", { ref: 5, expr: undefined }]);
    expect(h.saves).toEqual([
      { path: "D:\\DCS\\lua-export.json", baseName: "db.Units", bytes: 1024 },
    ]);
    expect(h.one("exportDone")).toEqual({ type: "exportDone", reqId: 2, saved: true });
  });

  it("falls back to a generic file name when the node had no label", async () => {
    const h = harness();
    h.gui.answer("replExport", () => ({ path: "D:\\t.json", bytes: 1 }));
    await h.presenter.handle({ type: "export", expr: "db.Units", reqId: 2 });
    expect(h.saves[0].baseName).toBe("lua-export");
    expect(h.gui.lastCall("replExport")?.args).toEqual([
      "gui",
      { ref: undefined, expr: "db.Units" },
    ]);
  });

  it("routes a mission-env export to the mission bridge", async () => {
    const h = harness();
    h.mission.answer("replExport", () => ({ path: "D:\\t.json", bytes: 1 }));
    await h.presenter.handle({ type: "export", env: "mission", ref: 5, reqId: 2 });
    expect(h.mission.lastCall("replExport")).toBeDefined();
    expect(h.gui.calls).toEqual([]);
  });

  it("reports a cancelled save rather than leaving the request hanging", async () => {
    const h = harness({ saveExport: async () => false });
    h.gui.answer("replExport", () => ({ path: "D:\\t.json", bytes: 1 }));
    await h.presenter.handle({ type: "export", ref: 5, reqId: 2 });
    expect(h.one("exportDone")).toEqual({ type: "exportDone", reqId: 2, saved: false });
  });

  it("reports a save that failed on the way to disk", async () => {
    const h = harness({
      saveExport: () => Promise.reject(new Error("ENOSPC: no space left on device")),
    });
    h.gui.answer("replExport", () => ({ path: "D:\\t.json", bytes: 1 }));
    await h.presenter.handle({ type: "export", ref: 5, reqId: 2 });
    expect(h.one("exportDone")).toEqual({
      type: "exportDone",
      reqId: 2,
      saved: false,
      error: "ENOSPC: no space left on device",
    });
  });

  it("answers with the failure when the sim could not serialize the table", async () => {
    const h = harness();
    h.gui.answer("replExport", () => Promise.reject(new Error("cannot serialize userdata")));
    await h.presenter.handle({ type: "export", ref: 5, reqId: 2 });
    expect(h.saves).toEqual([]);
    expect(h.one("exportDone")).toEqual({
      type: "exportDone",
      reqId: 2,
      saved: false,
      error: "cannot serialize userdata",
    });
  });
});

describe("the offline call to action", () => {
  it("describes the status line's launch button as a launch effect", async () => {
    const h = harness();
    await h.presenter.handle({ type: "launch" });
    // One implementation of launching, shared with the palette and status bar.
    expect(h.effects).toEqual([{ kind: "launchBridge" }]);
  });

  it("ignores a message type it does not handle", async () => {
    const h = harness();
    // Cast deliberately: `ConsoleInbound` is now the declared union
    // (src/core/app/webviewContract.ts), so this type cannot be written
    // legally — which is the point. It still ARRIVES, from a stale document or
    // a crafted post, and the switch has to survive it.
    await h.presenter.handle({ type: "somethingElse" } as unknown as ConsoleInbound);
    expect(h.gui.calls).toEqual([]);
    expect(h.posted).toEqual([]);
    expect(h.effects).toEqual([]);
  });
});

describe("tailing sim output", () => {
  it("reads nothing while a bridge is offline", async () => {
    const h = harness();
    await h.presenter.poll();
    // Polling a closed socket just throws once a second for the whole session.
    expect(h.gui.calls).toEqual([]);
    expect(h.mission.calls).toEqual([]);
  });

  it("streams print output from both bridges independently", async () => {
    const h = harness();
    h.gui.current = { connected: true };
    h.mission.current = { connected: true };
    h.gui.answer("consoleRead", () => ({ lines: [{ seq: 1, text: "gui line" }], latest: 1 }));
    h.mission.answer("consoleRead", () => ({
      lines: [{ seq: 1, text: "mission line" }],
      latest: 1,
    }));

    await h.presenter.poll();

    // Each bridge has its own output ring, so both have to be tailed or half
    // the sim's print output never appears.
    const texts = h
      .ofType("print")
      .flatMap((m) => (m.lines as { text: string }[]).map((l) => l.text));
    expect(texts.sort()).toEqual(["gui line", "mission line"]);
  });

  it("says nothing while the sim is idle", async () => {
    const h = harness();
    h.gui.current = { connected: true };
    h.gui.answer("consoleRead", () => ({ lines: [], latest: 0 }));

    await h.presenter.poll();
    await h.presenter.poll();
    await h.presenter.poll();

    // A mission that never calls print still polls once a second; posting an
    // empty batch each time would churn the webview forever.
    expect(h.ofType("print")).toEqual([]);
    expect(h.gui.calls.map((c) => c.args[0])).toEqual([0, 0, 0]);
  });

  it("advances the cursor without posting when the ring only dropped old lines", async () => {
    const h = harness();
    h.gui.current = { connected: true };
    h.gui.answer("consoleRead", () => ({ lines: [], latest: 40 }));
    await h.presenter.poll();
    expect(h.ofType("print")).toEqual([]);

    h.gui.answer("consoleRead", () => ({ lines: [{ seq: 41, text: "next" }], latest: 41 }));
    await h.presenter.poll();
    // Re-reading from 0 would replay the whole ring as if it were new output.
    expect(h.gui.calls.map((c) => c.args[0])).toEqual([0, 40]);
  });

  it("reads from the cursor it reached, not from the start", async () => {
    const h = harness();
    h.gui.current = { connected: true };
    h.gui.answer("consoleRead", () => ({ lines: [{ seq: 5, text: "a" }], latest: 5 }));
    await h.presenter.poll();
    await h.presenter.poll();
    expect(h.gui.calls.map((c) => c.args[0])).toEqual([0, 5]);
  });

  it("rereads the ring from the start after DCS restarts", async () => {
    const h = harness();
    h.gui.current = { connected: true };
    h.gui.answer("consoleRead", () => ({ lines: [{ seq: 9, text: "a" }], latest: 9 }));
    await h.presenter.poll();

    h.gui.current = { connected: false };
    await h.presenter.poll();
    h.gui.current = { connected: true };
    await h.presenter.poll();

    // The bridge server restarts with DCS and its ring starts again at zero;
    // keeping the old cursor would hide every line of the new session.
    expect(h.gui.calls.map((c) => c.args[0])).toEqual([0, 0]);
  });

  it("keeps polling after a read fails", async () => {
    const h = harness();
    h.gui.current = { connected: true };
    h.gui.answer("consoleRead", () => Promise.reject(new Error("timed out")));
    await h.presenter.poll();
    h.gui.answer("consoleRead", () => ({ lines: [{ seq: 1, text: "back" }], latest: 1 }));
    await h.presenter.poll();
    // A dropped frame must not end the tail for the rest of the session.
    expect(h.one("print")).toMatchObject({ lines: [{ seq: 1, text: "back" }] });
  });
});
