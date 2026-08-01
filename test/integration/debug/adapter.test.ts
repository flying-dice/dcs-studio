import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetVscode, state, vscodeMock } from "../support/vscode";

vi.mock("vscode", () => vscodeMock());

// The adapter probes MissionScripting.lua through a raw `fs.readFileSync` at a
// path built with win32 semantics — the extension ships for Windows only, so on
// a POSIX test host no real file can ever sit there. Only that one read is
// intercepted; the program itself is loaded off a genuine temp file, which is
// what makes the async load path worth exercising at all.
const disk = vi.hoisted(() => ({ missionScript: undefined as string | undefined }));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    default: actual,
    readFileSync: (p: unknown, enc: unknown) =>
      disk.missionScript !== undefined && String(p).endsWith("MissionScripting.lua")
        ? disk.missionScript
        : (actual.readFileSync as (a: unknown, b: unknown) => unknown)(p, enc),
  };
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as vscode from "vscode";
import { installRoots } from "../../../src/adapters/vscode/installRoots";
import type { BridgeClient } from "../../../src/bridge/client";
import { BridgeClients } from "../../../src/bridge/clients";
import {
  BRIDGE_TORN_DOWN,
  BridgeRpcError,
  PUMP_STALLED,
} from "../../../src/core/domain/bridgeProtocol";
import type { DebugSnapshot, DebugState } from "../../../src/core/domain/debugProtocol";
import { DcsDebugAdapter } from "../../../src/debug/adapter";
import { FakeBridge, FakeScheduler, flush, settle } from "./fakes";

// The DAP session shell for DCS Lua: the piece between VS Code's debugger UI
// and the in-sim engine. Every translation decision it makes is pure and lives
// in core/domain/dapTranslation (unit-tested there); what is exercised here is
// the orchestration nothing else can see — the lifecycle, the breakpoint
// registry, and above all the poll loop.
//
// The poll loop is not bookkeeping. `debug_state` stamps the engine's liveness
// timestamp, and a pause with no polling client auto-continues after 30 seconds
// so a crashed editor can never freeze the sim. The heartbeat therefore has to
// keep beating for as long as a user sits on a breakpoint, and has to stop the
// instant the session is over. The injected scheduler is what makes both
// halves of that assertable without waiting on a real clock.

/** A DAP message. Open-shaped, as the wire format is. */
type Msg = Record<string, any>;

/** Drives an adapter as VS Code would and records everything it sends back. */
class Dap {
  readonly sent: Msg[] = [];
  private seq = 1;

  constructor(readonly adapter: DcsDebugAdapter) {
    adapter.onDidSendMessage((m) => this.sent.push(m as Msg));
  }

  /** Send a request and settle it; returns the matching response. */
  async request(command: string, args?: unknown): Promise<Msg> {
    const seq = this.seq++;
    const before = this.sent.length;
    const responded = () => this.sent.some((m) => m.type === "response" && m.request_seq === seq);
    this.adapter.handleMessage({
      seq,
      type: "request",
      command,
      arguments: args,
    } as vscode.DebugProtocolMessage);
    // configurationDone is answered immediately and only THEN starts the
    // session, so its response says nothing: what is being waited for is the
    // session's first word — the "Debugging…" line, or the reason it refused.
    // Everything else is done when it has answered.
    await settle(command === "configurationDone" ? () => this.sent.length > before + 1 : responded);
    const res = this.sent.find((m) => m.type === "response" && m.request_seq === seq);
    if (!res) throw new Error(`no response to ${command}`);
    return res;
  }

  events(event: string): Msg[] {
    return this.sent.filter((m) => m.type === "event" && m.event === event);
  }

  /** Debug Console text of one category, in order. */
  output(category: "stdout" | "stderr" | "console"): string[] {
    return this.events("output")
      .filter((e) => e.body.category === category)
      .map((e) => e.body.output as string);
  }
}

const SNAPSHOT: DebugSnapshot = {
  pause_id: 1,
  frames: [
    {
      index: 0,
      source: "=C:\\mods\\script.lua",
      line: 12,
      name: "main chunk",
      scopes: [
        { name: "Locals", ref: 7 },
        { name: "Globals", ref: 8 },
      ],
    },
  ],
};

const PAUSED: DebugState = { paused: true, running: true, snapshot: JSON.stringify(SNAPSHOT) };
const RUNNING: DebugState = { paused: false, running: true };
const ENDED: DebugState = { paused: false, running: false };
/** The engine with no session on it — what a starting session has to see. */
const IDLE: DebugState = { paused: false, running: false };

describe("DcsDebugAdapter", () => {
  let gui: FakeBridge;
  let mission: FakeBridge;
  let clients: BridgeClients;
  let scheduler: FakeScheduler;
  let dir: string;
  let program: string;

  beforeEach(() => {
    resetVscode();
    disk.missionScript = undefined;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-debug-"));
    program = path.join(dir, "script.lua");
    fs.writeFileSync(program, "print('on disk')", "utf8");
    gui = new FakeBridge();
    mission = new FakeBridge();
    clients = new BridgeClients(gui as unknown as BridgeClient, mission as unknown as BridgeClient);
    scheduler = new FakeScheduler();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function open(config: Record<string, unknown> = {}): Dap {
    return new Dap(
      new DcsDebugAdapter(
        clients,
        {
          type: "dcs-lua",
          name: "Debug in DCS Mission",
          request: "launch",
          program,
          ...config,
        } as vscode.DebugConfiguration,
        scheduler,
        installRoots,
      ),
    );
  }

  /**
   * A session past configurationDone, i.e. with the run fired and polling live.
   *
   * The adapter asks debug_state once, before it touches the shared registry,
   * to find out whether another session already holds the engine. That first
   * answer is queued as idle here so a spec can script the POLL loop's
   * `debugState` with a plain `mockResolvedValue(PAUSED)` and still start; a
   * spec about the probe itself queues its own answer first, which is consumed
   * ahead of this one.
   */
  async function started(config: Record<string, unknown> = {}): Promise<Dap> {
    gui.debugState.mockResolvedValueOnce(IDLE);
    mission.debugState.mockResolvedValueOnce(IDLE);
    const dap = open(config);
    await dap.request("initialize");
    await dap.request("launch", { program, ...config });
    await dap.request("configurationDone");
    return dap;
  }

  /** A debug_run that never resolves — the normal case for anything but a
   * trivial script, since the run blocks bridge-side for the whole session. */
  function longRun(bridge: FakeBridge): void {
    bridge.debugRun.mockImplementation(() => new Promise(() => {}));
  }

  // ── Handshake ──

  it("advertises the capabilities the DCS engine actually supports", async () => {
    const dap = open();
    const res = await dap.request("initialize");
    expect(res.body).toEqual({
      supportsConfigurationDoneRequest: true,
      supportsConditionalBreakpoints: true,
      supportsEvaluateForHovers: true,
      supportsTerminateRequest: true,
      supportSuspendDebuggee: false,
      supportTerminateDebuggee: true,
    });
    // Without `initialized` the UI never sends its breakpoints.
    expect(dap.events("initialized")).toHaveLength(1);
  });

  it("ignores anything that is not a request", async () => {
    const dap = open();
    dap.adapter.handleMessage({ type: "event", event: "noise" } as vscode.DebugProtocolMessage);
    await flush();
    expect(dap.sent).toEqual([]);
  });

  it("acknowledges commands it does not implement so the UI never hangs", async () => {
    const dap = open();
    expect(await dap.request("loadedSources")).toMatchObject({ success: true, body: undefined });
  });

  it("reports no exception filters — DCS breaks on error via pauseOnError instead", async () => {
    const dap = open();
    expect((await dap.request("setExceptionBreakpoints")).body).toEqual({ breakpoints: [] });
  });

  // ── env routing ──

  it("routes a mission session to the mission bridge", async () => {
    longRun(mission);
    const dap = await started();
    expect(mission.debugRun).toHaveBeenCalled();
    expect(gui.debugRun).not.toHaveBeenCalled();
    expect((await dap.request("threads")).body).toEqual({
      threads: [{ id: 1, name: "DCS Mission" }],
    });
  });

  it("re-selects the bridge when launch arguments change the env", async () => {
    // The configuration reaching the constructor is the resolved launch config,
    // but VS Code sends the authoritative one with the launch request — an env
    // switch there has to move the session to the other bridge, or the run goes
    // to a DLL that does not own that Lua state.
    longRun(gui);
    const dap = await started({ env: "gui" });
    expect(gui.debugRun).toHaveBeenCalled();
    expect(mission.debugRun).not.toHaveBeenCalled();
    expect((await dap.request("threads")).body).toEqual({
      threads: [{ id: 1, name: "DCS GUI (hooks)" }],
    });
  });

  // ── Refusing to start ──

  it("aborts when the launch configuration names no program", async () => {
    const dap = await started({ program: undefined });
    expect(dap.output("stderr")).toEqual([
      "No program to run — set `program` in the launch configuration.\n",
    ]);
    // The popup carries the Report Issue affordance; the console keeps the text.
    expect(state.errors).toHaveLength(1);
    // Quiet finish: the reason was already shown, so it is not repeated as the
    // session's exit error.
    expect(dap.events("exited")[0].body).toEqual({ exitCode: 0 });
    expect(dap.events("terminated")).toHaveLength(1);
    expect(scheduler.liveCount).toBe(0);
  });

  it("explains a missing mission with the reason, not a generic failure", async () => {
    mission.status = { connected: false, dcsTime: null };
    const dap = await started();
    expect(dap.output("stderr")[0]).toContain("start a mission in DCS");
    expect(mission.debugRun).not.toHaveBeenCalled();
  });

  it("blames a sanitized MissionScripting.lua when that is what is stopping the bridge", async () => {
    // The single most common first-run failure: the mission bridge DLL cannot
    // load at all while the lockdown is active, so "start a mission" would be
    // useless advice.
    resetVscode({ config: { "dcsStudio.gameInstallPath": "C:\\DCS" } });
    disk.missionScript = "do\n  sanitizeModule('os')\nend\n";
    mission.status = { connected: false, dcsTime: null };

    const dap = await started();
    expect(dap.output("stderr")[0]).toContain("MissionScripting.lua is sanitized");
  });

  it("does not blame sanitization when the file is already desanitized", async () => {
    resetVscode({ config: { "dcsStudio.gameInstallPath": "C:\\DCS" } });
    disk.missionScript = "do\n  -- sanitizeModule('os')\nend\n";
    mission.status = { connected: false, dcsTime: null };

    const dap = await started();
    expect(dap.output("stderr")[0]).toContain("start a mission in DCS");
  });

  it("survives a configured DCS install whose MissionScripting.lua is unreadable", async () => {
    // No install path configured at all is the other half: both leave the
    // sanitize question unanswered rather than guessing.
    resetVscode({ config: { "dcsStudio.gameInstallPath": "C:\\DCS" } });
    mission.status = { connected: false, dcsTime: null };
    const dap = await started();
    expect(dap.output("stderr")[0]).toContain("start a mission in DCS");
  });

  it("aborts a GUI session with the launch nudge when DCS is down", async () => {
    gui.status = { connected: false, dcsTime: null };
    const dap = await started({ env: "gui" });
    expect(dap.output("stderr")[0]).toContain("Launch DCS with the bridge");
    expect(gui.debugRun).not.toHaveBeenCalled();
  });

  it("aborts when the program cannot be read", async () => {
    longRun(mission);
    const missing = path.join(dir, "gone.lua");
    const dap = await started({ program: missing });
    expect(dap.output("stderr")[0]).toContain(`Cannot read ${missing}`);
    expect(mission.debugRun).not.toHaveBeenCalled();
  });

  it.each([
    ["running", RUNNING],
    ["paused at a breakpoint", PAUSED],
  ])("refuses to start while the engine is already %s", async (_label, engine) => {
    // The breakpoint registry is process-wide DLL state and the engine runs one
    // session at a time. Clearing the registry and only THEN having the run
    // refused is how the session that is genuinely attached loses every
    // breakpoint it set, silently.
    mission.debugState.mockResolvedValueOnce(engine);
    const dap = await started();

    expect(dap.output("stderr")[0]).toContain("A debug session is already running in DCS");
    expect(state.errors).toHaveLength(1);
    expect(mission.debugClearBreakpoints).not.toHaveBeenCalled();
    expect(mission.debugSetBreakpoints).not.toHaveBeenCalled();
    expect(mission.debugRun).not.toHaveBeenCalled();
    expect(dap.events("exited")[0].body).toEqual({ exitCode: 0 });
  });

  it("leaves the live session's breakpoints alone when the refused one is dismissed", async () => {
    // The other half of the same bug: the second session cleared the registry
    // again on its way out, so even a user who read the refusal lost the first
    // session's breakpoints by closing the one that failed.
    mission.debugState.mockResolvedValueOnce(RUNNING);
    const dap = await started();

    expect((await dap.request("disconnect")).success).toBe(true);
    expect(mission.debugClearBreakpoints).not.toHaveBeenCalled();
    expect(mission.debugStop).not.toHaveBeenCalled();
  });

  it("refuses to start rather than clear a registry it cannot ask about", async () => {
    // A sim paused in DCS queues every call behind the model-time pump, which
    // does not run — so the probe times out. Proceeding on no answer is exactly
    // the case that clears somebody else's breakpoints.
    mission.debugState.mockRejectedValueOnce(
      new Error("Mission bridge call 'debug_state' timed out"),
    );
    const dap = await started();

    expect(dap.output("stderr")[0]).toBe(
      "Cannot start the debug session: Mission bridge call 'debug_state' timed out\n",
    );
    // No code came back — nothing answered at all — so this stays reportable.
    expect(state.errors).toHaveLength(1);
    expect(mission.debugClearBreakpoints).not.toHaveBeenCalled();
    expect(mission.debugRun).not.toHaveBeenCalled();
  });

  // Pressing Debug while a mission is unloading is a mistiming, not a defect.
  // The refusal is still correct and the user still has to be told — but the
  // bridge told us plainly which case this was, so offering to file it as a
  // bug would be asking the user to report the sim for ending.
  it("refuses without offering a bug report when the mission ended under the probe", async () => {
    mission.debugState.mockRejectedValueOnce(
      new BridgeRpcError("bridge torn down", BRIDGE_TORN_DOWN),
    );
    const dap = await started();

    expect(dap.output("stderr")[0]).toBe("Cannot start the debug session: bridge torn down\n");
    expect(state.errors).toEqual([]);
    expect(mission.debugRun).not.toHaveBeenCalled();
  });

  it("refuses without offering a bug report when the sim was not pumping", async () => {
    mission.debugState.mockRejectedValueOnce(new BridgeRpcError("pump stalled", PUMP_STALLED));
    const dap = await started();

    expect(dap.output("stderr")[0]).toBe("Cannot start the debug session: pump stalled\n");
    expect(state.errors).toEqual([]);
    expect(mission.debugRun).not.toHaveBeenCalled();
  });

  it("still offers a bug report when the bridge failed for a reason that is one", async () => {
    mission.debugState.mockRejectedValueOnce(new BridgeRpcError("internal error", -32603));
    const dap = await started();

    expect(dap.output("stderr")[0]).toBe("Cannot start the debug session: internal error\n");
    expect(state.errors).toHaveLength(1);
  });

  it("does not clear the registry when a run-without-debugging session ends", async () => {
    // repl_eval never touched the registry; clearing it on the way out would
    // drop the breakpoints of a debug session running alongside.
    const dap = await started({ noDebug: true });
    await dap.request("disconnect");
    expect(mission.debugClearBreakpoints).not.toHaveBeenCalled();
  });

  it("starts the run only once however many times configurationDone arrives", async () => {
    longRun(mission);
    const dap = await started();
    await dap.request("configurationDone");
    expect(mission.debugRun).toHaveBeenCalledTimes(1);
  });

  // ── Source selection ──

  it("runs the unsaved buffer rather than what is on disk", async () => {
    // Debugging what the editor shows is the whole point; running the saved
    // copy would put breakpoints on lines the user cannot see.
    state.textDocuments.push(
      { uri: { fsPath: program, scheme: "file" }, isDirty: true, getText: () => "print('buffer')" },
      // A same-named document from another scheme (a diff view, say) must not win.
      { uri: { fsPath: program, scheme: "git" }, isDirty: false, getText: () => "print('git')" },
      { uri: { fsPath: path.join(dir, "other.lua"), scheme: "file" }, isDirty: false },
    );
    longRun(mission);
    await started();
    expect(mission.debugRun.mock.calls[0][2]).toBe("print('buffer')");
  });

  it("falls back to disk when the file is not open", async () => {
    longRun(mission);
    await started();
    const [env, source, code, pauseOnError] = mission.debugRun.mock.calls[0];
    expect(env).toBe("mission");
    expect(source).toBe(`=${program}`);
    expect(code).toBe("print('on disk')");
    expect(pauseOnError).toBe(true);
  });

  it("honours pauseOnError: false", async () => {
    longRun(mission);
    await started({ pauseOnError: false });
    expect(mission.debugRun.mock.calls[0][3]).toBe(false);
  });

  // ── Console tailing ──

  it("tails the console from the current ring position, not the start", async () => {
    // The console ring is shared with the Lua console; replaying it would dump
    // a previous session's output into this one's Debug Console.
    mission.consoleRead.mockResolvedValueOnce({ lines: [], latest: 41 });
    longRun(mission);
    await started();
    mission.consoleRead.mockResolvedValueOnce({
      lines: [{ seq: 42, text: "hello" }],
      latest: 42,
    });
    await scheduler.advance(500);
    expect(mission.consoleRead.mock.calls[1][0]).toBe(41);
  });

  it("starts from zero when the ring position cannot be read", async () => {
    mission.consoleRead.mockRejectedValueOnce(new Error("bridge busy"));
    longRun(mission);
    await started();
    await scheduler.advance(500);
    expect(mission.consoleRead.mock.calls[1][0]).toBe(0);
  });

  it("streams console lines and advances the cursor only when there are any", async () => {
    mission.consoleRead.mockResolvedValueOnce({ lines: [], latest: undefined as never });
    longRun(mission);
    const dap = await started();

    mission.consoleRead.mockResolvedValueOnce({
      lines: [
        { seq: 1, text: "first" },
        { seq: 2, text: "already newline\n" },
      ],
      latest: 2,
    });
    await scheduler.advance(500);
    // An empty read must not move the cursor, or lines written between polls
    // would be skipped.
    mission.consoleRead.mockResolvedValueOnce({ lines: [], latest: 99 });
    await scheduler.advance(500);
    mission.consoleRead.mockRejectedValueOnce(new Error("transient"));
    await scheduler.advance(500);

    expect(dap.output("stdout")).toEqual(["first\n", "already newline\n"]);
    expect(mission.consoleRead.mock.calls.slice(1).map((c) => c[0])).toEqual([0, 2, 2]);
  });

  // ── Breakpoints ──

  it("pushes the whole breakpoint set after clearing the registry", async () => {
    // The registry is DLL state that outlives a session: a stale breakpoint
    // from a previous run would stop the sim on a line the user removed.
    fs.writeFileSync(program, Array.from({ length: 10 }, (_, i) => `x = ${i}`).join("\n"), "utf8");
    const dap = open();
    await dap.request("initialize");
    const res = await dap.request("setBreakpoints", {
      source: { path: program },
      breakpoints: [{ line: 3 }, { line: 9, condition: "i > 2" }],
    });
    expect(res.body).toEqual({
      breakpoints: [
        { verified: true, line: 3 },
        { verified: true, line: 9 },
      ],
    });
    expect(mission.debugSetBreakpoints).not.toHaveBeenCalled();

    longRun(mission);
    await dap.request("configurationDone");
    expect(mission.debugClearBreakpoints).toHaveBeenCalled();
    expect(mission.debugSetBreakpoints).toHaveBeenCalledWith(`=${program}`, [
      { line: 3 },
      { line: 9, condition: "i > 2" },
    ]);
  });

  it("answers a breakpoint that cannot bind as unverified, judged against the file", async () => {
    // The line hook only fires on lines the chunk executes: a breakpoint on a
    // comment or past the end of the file never stops anything. Drawing it as
    // bound promises a stop the sim will never make.
    fs.writeFileSync(program, "local i = 0\n\n-- count up\ni = i + 1\n", "utf8");
    const dap = open();
    const res = await dap.request("setBreakpoints", {
      source: { path: program },
      breakpoints: [{ line: 1 }, { line: 2 }, { line: 3 }, { line: 5 }],
    });
    expect(res.body.breakpoints).toEqual([
      { verified: true, line: 1 },
      {
        verified: false,
        line: 2,
        reason: "failed",
        message: "Blank line — nothing here for the sim to execute.",
      },
      {
        verified: false,
        line: 3,
        reason: "failed",
        message: "Comment — nothing here for the sim to execute.",
      },
      {
        verified: false,
        line: 5,
        reason: "failed",
        message: "Past the end of the file — nothing here for the sim to execute.",
      },
    ]);
  });

  it("judges the lines against the unsaved buffer, not the saved file", async () => {
    // The user sets breakpoints on what the editor shows; verifying against
    // disk would grey out breakpoints on lines they just typed.
    state.textDocuments.push({
      uri: { fsPath: program, scheme: "file" },
      isDirty: true,
      getText: () => "print(1)\nprint(2)\n",
    });
    const dap = open();
    const res = await dap.request("setBreakpoints", {
      source: { path: program },
      breakpoints: [{ line: 2 }],
    });
    expect(res.body.breakpoints).toEqual([{ verified: true, line: 2 }]);
  });

  it("claims nothing about a file it cannot read", async () => {
    // Breakpoints restored for a file that has since been moved: with no lines
    // to judge against, greying them all out would be its own lie.
    const dap = open();
    const res = await dap.request("setBreakpoints", {
      source: { path: path.join(dir, "gone.lua") },
      breakpoints: [{ line: 4000 }],
    });
    expect(res.body.breakpoints).toEqual([{ verified: true, line: 4000 }]);
  });

  it("aborts when the breakpoint set cannot be installed", async () => {
    // Running with breakpoints silently missing is worse than not running.
    mission.debugClearBreakpoints.mockRejectedValueOnce(new Error("registry locked"));
    const dap = await started();
    expect(dap.output("stderr")[0]).toContain("Failed to set breakpoints: registry locked");
    expect(state.errors).toHaveLength(1);
    expect(mission.debugRun).not.toHaveBeenCalled();
  });

  it("aborts quietly when the mission ended while breakpoints were going in", async () => {
    // Same suppression as the pre-flight probe: the session is still refused
    // and still explained, without the Report Issue button.
    mission.debugClearBreakpoints.mockRejectedValueOnce(
      new BridgeRpcError("bridge torn down", BRIDGE_TORN_DOWN),
    );
    const dap = await started();
    expect(dap.output("stderr")[0]).toContain("Failed to set breakpoints: bridge torn down");
    expect(state.errors).toEqual([]);
    expect(mission.debugRun).not.toHaveBeenCalled();
  });

  it("answers a source with no path without touching the bridge", async () => {
    const dap = open();
    const res = await dap.request("setBreakpoints", { source: {} });
    expect(res.body).toEqual({ breakpoints: [] });
    expect(mission.debugSetBreakpoints).not.toHaveBeenCalled();
  });

  it("clears a source when the UI sends it with no breakpoints array", async () => {
    longRun(mission);
    const dap = await started();
    const res = await dap.request("setBreakpoints", { source: { path: program } });
    expect(res.body).toEqual({ breakpoints: [] });
    expect(mission.debugSetBreakpoints).toHaveBeenLastCalledWith(`=${program}`, []);
  });

  it("pushes a breakpoint added mid-session", async () => {
    // Shared DLL state, so this works even while the sim is frozen at a
    // breakpoint — the paused state's own pump serves the call.
    longRun(mission);
    const dap = await started();
    await dap.request("setBreakpoints", {
      source: { path: program },
      breakpoints: [{ line: 5 }],
    });
    expect(mission.debugSetBreakpoints).toHaveBeenCalledWith(`=${program}`, [{ line: 5 }]);
  });

  it("keeps the session alive when a mid-session breakpoint push fails", async () => {
    longRun(mission);
    const dap = await started();
    mission.debugSetBreakpoints.mockRejectedValueOnce(new Error("bridge busy"));
    const res = await dap.request("setBreakpoints", {
      source: { path: program },
      breakpoints: [{ line: 5 }],
    });
    expect(dap.output("stderr")).toEqual([
      "Could not update breakpoints in script.lua: bridge busy\n",
    ]);
    expect(res.success).toBe(true);
    expect(dap.events("terminated")).toHaveLength(0);
  });

  it("does not push breakpoints for a run-without-debugging session", async () => {
    // repl_eval runs outside the line hook, so a breakpoint would either be
    // ignored or stop an unrelated script.
    mission.replEval.mockImplementation(() => new Promise(() => {}));
    const dap = await started({ noDebug: true });
    await dap.request("setBreakpoints", {
      source: { path: program },
      breakpoints: [{ line: 5 }],
    });
    expect(mission.debugSetBreakpoints).not.toHaveBeenCalled();
  });

  it("does not push breakpoints once the session is over", async () => {
    const dap = await started();
    expect(dap.events("terminated")).toHaveLength(1);
    await dap.request("setBreakpoints", {
      source: { path: program },
      breakpoints: [{ line: 5 }],
    });
    expect(mission.debugSetBreakpoints).not.toHaveBeenCalled();
  });

  // ── The run call as a fast path ──

  it("ends the session when a short script's run call comes back clean", async () => {
    const dap = await started();
    expect(dap.output("console")[0]).toBe("Debugging script.lua in the mission environment…\n");
    expect(dap.events("exited")[0].body).toEqual({ exitCode: 0 });
    expect(dap.events("terminated")).toHaveLength(1);
  });

  it("reports a failed run and exits non-zero", async () => {
    mission.debugRun.mockResolvedValueOnce({ ran: false, error: "attempt to index a nil value" });
    const dap = await started();
    expect(dap.output("stderr")).toEqual(["attempt to index a nil value\n"]);
    expect(dap.events("exited")[0].body).toEqual({ exitCode: 1 });
  });

  it("leaves a dispatched mission run to the poll loop", async () => {
    // The resident mission runtime executes asynchronously (DCS ≥ 2.9.27), so
    // the immediate ack says nothing about the script's outcome — treating it
    // as the end would terminate the session before the first line ran.
    mission.debugRun.mockResolvedValueOnce({ dispatched: true });
    const dap = await started();
    expect(dap.events("terminated")).toHaveLength(0);
    expect(scheduler.liveIntervals).toEqual(expect.arrayContaining([250]));
  });

  it("leaves the outcome to the poll loop when the run call times out", async () => {
    // Sessions longer than the server's 30s response window always land here.
    mission.debugRun.mockRejectedValueOnce(new Error("call 'debug_run' timed out"));
    mission.debugState.mockResolvedValue(RUNNING);
    const dap = await started();
    expect(dap.events("terminated")).toHaveLength(0);

    mission.debugState.mockResolvedValue({ ...ENDED, error: "runtime error" });
    await scheduler.advance(250);
    expect(dap.output("stderr")).toEqual(["runtime error\n"]);
    expect(dap.events("exited")[0].body).toEqual({ exitCode: 1 });
  });

  it("does not end the session when the run call resolves while paused", async () => {
    let settleRun: (v: { ran?: boolean }) => void = () => {};
    mission.debugRun.mockImplementation(() => new Promise((r) => (settleRun = r)));
    mission.debugState.mockResolvedValue(PAUSED);
    const dap = await started();
    await scheduler.advance(250);
    expect(dap.events("stopped")).toHaveLength(1);

    settleRun({ ran: true });
    await flush();
    expect(dap.events("terminated")).toHaveLength(0);
  });

  // ── The heartbeat ──

  it("keeps the heartbeat beating for the whole time a user sits on a breakpoint", async () => {
    // THE safety property. debug_state doubles as the engine's liveness ping,
    // and a pause with no polling client auto-continues after 30 seconds. If
    // this loop ever stalls while paused, the sim walks off the breakpoint
    // underneath the user mid-inspection.
    longRun(mission);
    mission.debugState.mockResolvedValue(PAUSED);
    const dap = await started();

    await scheduler.advance(30_000);
    expect(dap.events("stopped")).toHaveLength(1); // one stop, deduped by pause_id
    // 250ms cadence over the sim's 30s idle window, with a wide margin.
    expect(mission.debugState.mock.calls.length).toBeGreaterThanOrEqual(120);
  });

  it("never overlaps polls, so a stalled debug_state cannot pile up requests", async () => {
    // The other side of the heartbeat: the guard means a single stalled call
    // suppresses the ping entirely, which is exactly why debugState carries a
    // 5s client-side timeout — well inside the sim's 30s idle window.
    let release: (v: DebugState) => void = () => {};
    longRun(mission);
    await started(); // one debug_state already spent on the start-up probe

    mission.debugState.mockImplementationOnce(() => new Promise((r) => (release = r)));
    await scheduler.advance(5_000);
    expect(mission.debugState).toHaveBeenCalledTimes(2);

    mission.debugState.mockResolvedValue(RUNNING);
    release(RUNNING);
    await flush();
    await scheduler.advance(250);
    expect(mission.debugState).toHaveBeenCalledTimes(3);
  });

  it("stops the heartbeat the moment the session ends", async () => {
    // Leaving it running would keep polling a dead session forever — and keep
    // renewing the liveness stamp of a pause nobody is watching.
    longRun(mission);
    mission.debugState.mockResolvedValue(RUNNING);
    const dap = await started();
    expect(scheduler.liveIntervals.sort()).toEqual([250, 500]);

    await dap.request("disconnect");
    expect(scheduler.liveCount).toBe(0);

    const polls = mission.debugState.mock.calls.length;
    await scheduler.advance(10_000);
    expect(mission.debugState.mock.calls.length).toBe(polls);
  });

  it("drops its timers on dispose, armed or not", async () => {
    const idle = open();
    idle.adapter.dispose(); // never started — nothing to clear
    expect(scheduler.liveCount).toBe(0);

    longRun(mission);
    const dap = await started();
    expect(scheduler.liveCount).toBe(2);
    dap.adapter.dispose();
    expect(scheduler.liveCount).toBe(0);
  });

  it("ignores a snapshot that arrives after the session ended", async () => {
    // A poll in flight when the user hits stop would otherwise re-open the
    // stopped UI on a session that no longer exists.
    let release: (v: DebugState) => void = () => {};
    longRun(mission);
    const dap = await started();
    mission.debugState.mockImplementationOnce(() => new Promise((r) => (release = r)));
    await scheduler.advance(250);

    await dap.request("disconnect");
    release(PAUSED);
    await flush();
    expect(dap.events("stopped")).toHaveLength(0);
  });

  it("retries after a lone poll failure but abandons the session when the bridge drops", async () => {
    longRun(mission);
    const dap = await started();
    mission.debugState.mockRejectedValueOnce(new Error("timed out"));
    await scheduler.advance(250);
    expect(dap.events("terminated")).toHaveLength(0);

    mission.debugState.mockRejectedValue(new Error("disconnected"));
    mission.status = { connected: false, dcsTime: null };
    await scheduler.advance(250);
    expect(dap.output("stderr")).toEqual([
      "The DCS bridge disconnected — the debug session was abandoned.\n",
    ]);
  });

  // ── Stopping and inspection ──

  it("surfaces a conditional-breakpoint error alongside the stop it caused", async () => {
    // A broken condition would otherwise look like a breakpoint that fires at
    // random; the engine reports it rather than swallowing it.
    longRun(mission);
    mission.debugState.mockResolvedValue({
      ...PAUSED,
      snapshot: JSON.stringify({
        ...SNAPSHOT,
        cond_error: "attempt to compare nil with number",
        stop_reason: "error",
        error: "boom",
      }),
    });
    const dap = await started();
    await scheduler.advance(250);

    expect(dap.output("stderr")).toEqual(["attempt to compare nil with number\n", "boom\n"]);
    expect(dap.events("stopped")[0].body).toEqual({
      reason: "exception",
      threadId: 1,
      allThreadsStopped: true,
      description: "Paused on error",
      text: "boom",
    });
  });

  it("serves the stack, scopes and variables of the live pause", async () => {
    longRun(mission);
    mission.debugState.mockResolvedValue(PAUSED);
    const dap = await started();

    expect((await dap.request("stackTrace")).body).toEqual({ stackFrames: [], totalFrames: 0 });

    await scheduler.advance(250);
    expect((await dap.request("stackTrace")).body).toEqual({
      stackFrames: [
        {
          id: 0,
          name: "main chunk",
          line: 12,
          column: 1,
          source: { name: "script.lua", path: "C:\\mods\\script.lua" },
          presentationHint: undefined,
        },
      ],
      totalFrames: 1,
    });
    expect((await dap.request("scopes", { frameId: 0 })).body).toEqual({
      scopes: [
        { name: "Locals", variablesReference: 7, expensive: false },
        { name: "Globals", variablesReference: 8, expensive: true },
      ],
    });
    // A frame the snapshot does not have (a stale request after a resume).
    expect((await dap.request("scopes", { frameId: 99 })).body).toEqual({ scopes: [] });

    mission.debugExpand.mockResolvedValueOnce({
      variables: [{ name: "i", type: "number", value: "3", ref: 0 }],
    });
    expect((await dap.request("variables", { variablesReference: 7 })).body).toEqual({
      variables: [{ name: "i", value: "3", type: "number", variablesReference: 0 }],
    });
    expect(mission.debugExpand).toHaveBeenCalledWith(7);
  });

  it("fails a request whose bridge call throws, and says whether to show it", async () => {
    longRun(mission);
    const dap = await started();
    mission.debugExpand.mockRejectedValueOnce(new Error("ref released"));
    const res = await dap.request("variables", { variablesReference: 7 });
    expect(res).toMatchObject({ success: false, message: "ref released" });
    expect(res.body.error.showUser).toBe(true);
  });

  it("reports a non-Error rejection verbatim", async () => {
    // Lua-side failures can surface as bare strings; dropping them would leave
    // the user with an empty failure.
    longRun(mission);
    const dap = await started();
    mission.debugExpand.mockRejectedValueOnce("no such ref");
    expect(await dap.request("variables", { variablesReference: 7 })).toMatchObject({
      success: false,
      message: "no such ref",
    });
  });

  // ── Resuming ──

  it.each([
    ["continue", "continue", { allThreadsContinued: true }],
    ["next", "step_over", undefined],
    ["stepIn", "step_into", undefined],
    ["stepOut", "step_out", undefined],
  ])("maps %s to the engine's %s and drops the stale pause", async (command, mode, body) => {
    longRun(mission);
    mission.debugState.mockResolvedValue(PAUSED);
    const dap = await started();
    await scheduler.advance(250);

    const res = await dap.request(command);
    expect(mission.debugContinue).toHaveBeenCalledWith(mode);
    expect(res.body).toEqual(body);
    // The snapshot goes immediately, not at the next poll: a stackTrace served
    // from the old frames after a step would point at the wrong line.
    expect((await dap.request("stackTrace")).body.totalFrames).toBe(0);
  });

  it("reports a step's stop as a step, not a breakpoint", async () => {
    longRun(mission);
    mission.debugState.mockResolvedValue(PAUSED);
    const dap = await started();
    await scheduler.advance(250);
    await dap.request("next");

    mission.debugState.mockResolvedValue({
      ...PAUSED,
      snapshot: JSON.stringify({ ...SNAPSHOT, pause_id: 2 }),
    });
    await scheduler.advance(250);
    expect(dap.events("stopped")[1].body.reason).toBe("step");
  });

  it("break-all pauses at the next executed line", async () => {
    longRun(mission);
    mission.debugState.mockResolvedValue(RUNNING);
    const dap = await started();
    expect((await dap.request("pause")).success).toBe(true);
    expect(mission.debugPause).toHaveBeenCalled();

    mission.debugState.mockResolvedValue(PAUSED);
    await scheduler.advance(250);
    expect(dap.events("stopped")[0].body.reason).toBe("pause");
  });

  // ── Evaluate ──

  it("refuses to evaluate while the session is running", async () => {
    // debug_eval only has frames to evaluate against at a stop; the failure is
    // silent because VS Code hovers expressions constantly.
    longRun(mission);
    const dap = await started();
    const res = await dap.request("evaluate", { expression: "x", context: "hover" });
    expect(res).toMatchObject({ success: false, message: "not paused" });
    expect(res.body.error.showUser).toBe(false);
    expect(mission.debugEval).not.toHaveBeenCalled();
  });

  it("evaluates in the requested frame and invalidates locals after an assignment", async () => {
    longRun(mission);
    mission.debugState.mockResolvedValue(PAUSED);
    const dap = await started();
    await scheduler.advance(250);

    mission.debugEval.mockResolvedValueOnce({ ok: true, value: "3", type: "number", ref: 0 });
    expect((await dap.request("evaluate", { expression: "i", frameId: 0 })).body).toEqual({
      result: "3",
      type: "number",
      variablesReference: 0,
    });
    expect(mission.debugEval).toHaveBeenCalledWith(0, "i");
    expect(dap.events("invalidated")).toHaveLength(0);

    // An assignment really changes locals the Variables view already rendered.
    mission.debugEval.mockResolvedValueOnce({ ok: true, value: "9", assigned: true });
    await dap.request("evaluate", { expression: "i = 9" });
    expect(mission.debugEval).toHaveBeenLastCalledWith(0, "i = 9");
    expect(dap.events("invalidated")[0].body).toEqual({ areas: ["variables"] });

    mission.debugEval.mockResolvedValueOnce({ ok: false, err: "syntax error" });
    expect(await dap.request("evaluate", { expression: "((" })).toMatchObject({
      success: false,
      message: "syntax error",
    });
  });

  // ── Run without debugging ──

  it("runs without the debugger via repl_eval and prints the returned value", async () => {
    mission.replEval.mockResolvedValueOnce({ ok: true, result: { hits: 2 } });
    const dap = await started({ noDebug: true });
    expect(mission.replEval).toHaveBeenCalledWith("mission", "print('on disk')");
    expect(mission.debugRun).not.toHaveBeenCalled();
    expect(mission.debugClearBreakpoints).not.toHaveBeenCalled();
    expect(dap.output("console")).toEqual([
      "Running script.lua in the mission environment…\n",
      '→ {"hits":2}\n',
    ]);
    expect(dap.events("exited")[0].body).toEqual({ exitCode: 0 });
  });

  it("says nothing extra when the script returns nothing", async () => {
    const dap = await started({ noDebug: true });
    expect(dap.output("console")).toEqual(["Running script.lua in the mission environment…\n"]);
    expect(dap.events("exited")[0].body).toEqual({ exitCode: 0 });
  });

  it("reports a script error from a no-debug run", async () => {
    mission.replEval.mockResolvedValueOnce({ ok: false, err: "attempt to call a nil value" });
    const dap = await started({ noDebug: true });
    expect(dap.output("stderr")).toEqual(["attempt to call a nil value\n"]);
    expect(dap.events("exited")[0].body).toEqual({ exitCode: 1 });
  });

  it("reports a transport failure from a no-debug run", async () => {
    mission.replEval.mockRejectedValueOnce(new Error("mission bridge not connected"));
    const dap = await started({ noDebug: true });
    expect(dap.output("stderr")).toEqual(["mission bridge not connected\n"]);
  });

  // ── Ending ──

  it("stops the chunk and clears the registry on disconnect", async () => {
    // The breakpoints live in the DLL; leaving them behind would stop a later
    // unrelated script in the same Lua state.
    longRun(mission);
    mission.debugState.mockResolvedValue(RUNNING);
    const dap = await started();
    expect((await dap.request("terminate")).success).toBe(true);
    expect(mission.debugStop).toHaveBeenCalledTimes(1);
    expect(mission.debugClearBreakpoints).toHaveBeenCalledTimes(2); // start + end
    expect(dap.events("terminated")).toHaveLength(1);
  });

  it("still tears down when the bridge refuses both teardown calls", async () => {
    longRun(mission);
    const dap = await started();
    mission.debugStop.mockRejectedValueOnce(new Error("already gone"));
    mission.debugClearBreakpoints.mockRejectedValueOnce(new Error("already gone"));
    expect((await dap.request("disconnect")).success).toBe(true);
    expect(dap.events("terminated")).toHaveLength(1);
  });

  it("does not try to stop a chunk that already ended", async () => {
    const dap = await started(); // the fast path already finished it
    await dap.request("disconnect");
    expect(mission.debugStop).not.toHaveBeenCalled();
    // One terminated event, not two: VS Code disconnects after a terminate.
    expect(dap.events("terminated")).toHaveLength(1);
  });
});
