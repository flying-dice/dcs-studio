import { describe, expect, it } from "vitest";
import type { DebugFrame, DebugSnapshot, DebugState } from "../../src/core/domain/bridgeProtocol";
import {
  actionForResume,
  INITIAL_TRACKING,
  noDebugOutcome,
  pathOfSource,
  pollTransition,
  runFastPathDecision,
  type SessionTracking,
  showUserForFailure,
  sourceId,
  threadName,
  toBreakpointsResponse,
  toBridgeBreakpoints,
  toEvaluateOutcome,
  toScopesResponse,
  toStackTraceResponse,
  toVariablesResponse,
} from "../../src/core/domain/dapTranslation";

// ── chunkname ↔ path ──

describe("sourceId / pathOfSource", () => {
  it("prefixes '=' the way the DLL normalizes debug_run chunknames", () => {
    expect(sourceId("C:\\missions\\main.lua")).toBe("=C:\\missions\\main.lua");
  });

  it("round-trips windows paths (backslash and forward slash) and posix paths", () => {
    for (const p of [
      "C:\\Users\\me\\script.lua",
      "c:/saved games/dcs/x.lua",
      "Z:\\a.lua",
      "/home/user/mission.lua",
    ]) {
      expect(pathOfSource(sourceId(p))).toBe(p);
    }
  });

  it("maps '@' dofile chunknames to their path", () => {
    expect(pathOfSource("@C:\\Scripts\\Hooks\\DcsStudio.lua")).toBe(
      "C:\\Scripts\\Hooks\\DcsStudio.lua",
    );
    expect(pathOfSource("@/opt/dcs/x.lua")).toBe("/opt/dcs/x.lua");
  });

  it("rejects chunknames that do not name a file", () => {
    expect(pathOfSource('[string "return 1"]')).toBeUndefined();
    expect(pathOfSource("=main chunk")).toBeUndefined();
    expect(pathOfSource("=relative\\path.lua")).toBeUndefined();
    expect(pathOfSource("")).toBeUndefined();
  });
});

// ── plumbing rules ──

describe("showUserForFailure", () => {
  it("keeps evaluate/hover failures quiet, surfaces everything else", () => {
    expect(showUserForFailure("evaluate")).toBe(false);
    expect(showUserForFailure("launch")).toBe(true);
    expect(showUserForFailure("variables")).toBe(true);
  });
});

describe("threadName", () => {
  it("names the single thread per env", () => {
    expect(threadName("mission")).toBe("DCS Mission");
    expect(threadName("gui")).toBe("DCS GUI (hooks)");
  });
});

// ── breakpoints ──

describe("toBridgeBreakpoints", () => {
  it("omits (does not null) absent conditions", () => {
    const out = toBridgeBreakpoints([{ line: 3 }, { line: 7, condition: "x > 1" }]);
    expect(out).toEqual([{ line: 3 }, { line: 7, condition: "x > 1" }]);
    expect("condition" in out[0]).toBe(false);
  });

  it("treats an empty-string condition as absent", () => {
    expect("condition" in toBridgeBreakpoints([{ line: 1, condition: "" }])[0]).toBe(false);
  });
});

describe("toBreakpointsResponse", () => {
  it("verifies every breakpoint at its requested line", () => {
    expect(toBreakpointsResponse([{ line: 2 }, { line: 9, condition: "c" }])).toEqual({
      breakpoints: [
        { verified: true, line: 2 },
        { verified: true, line: 9 },
      ],
    });
  });

  it("handles an empty set", () => {
    expect(toBreakpointsResponse([])).toEqual({ breakpoints: [] });
  });
});

// ── snapshot → DAP shapes ──

const fileFrame: DebugFrame = {
  index: 0,
  source: "=C:\\m\\main.lua",
  line: 12,
  name: "doThing",
  scopes: [
    { name: "Locals", ref: 100 },
    { name: "Globals", ref: 101 },
  ],
};

const nativeFrame: DebugFrame = {
  index: 1,
  source: '[string "chunk"]',
  line: 1,
  name: "?",
  scopes: [],
};

describe("toStackTraceResponse", () => {
  it("maps file frames with basename + path and no hint", () => {
    const r = toStackTraceResponse([fileFrame]);
    expect(r).toEqual({
      stackFrames: [
        {
          id: 0,
          name: "doThing",
          line: 12,
          column: 1,
          source: { name: "main.lua", path: "C:\\m\\main.lua" },
          presentationHint: undefined,
        },
      ],
      totalFrames: 1,
    });
  });

  it("renders non-file frames subtle with no source", () => {
    const r = toStackTraceResponse([nativeFrame]);
    expect(r.stackFrames[0].source).toBeUndefined();
    expect(r.stackFrames[0].presentationHint).toBe("subtle");
  });

  it("handles an empty stack", () => {
    expect(toStackTraceResponse([])).toEqual({ stackFrames: [], totalFrames: 0 });
  });
});

describe("toScopesResponse", () => {
  it("marks Globals expensive, everything else cheap", () => {
    expect(toScopesResponse(fileFrame)).toEqual({
      scopes: [
        { name: "Locals", variablesReference: 100, expensive: false },
        { name: "Globals", variablesReference: 101, expensive: true },
      ],
    });
  });

  it("yields no scopes for a missing frame", () => {
    expect(toScopesResponse(undefined)).toEqual({ scopes: [] });
  });
});

describe("toVariablesResponse", () => {
  it("maps bridge variables to DAP variables", () => {
    expect(
      toVariablesResponse([
        { name: "t", type: "table", value: "{...}", ref: 5 },
        { name: "n", type: "number", value: "1", ref: 0 },
      ]),
    ).toEqual({
      variables: [
        { name: "t", value: "{...}", type: "table", variablesReference: 5 },
        { name: "n", value: "1", type: "number", variablesReference: 0 },
      ],
    });
  });
});

describe("toEvaluateOutcome", () => {
  it("fails with the bridge error, defaulting the message", () => {
    expect(toEvaluateOutcome({ ok: false, err: "nope" })).toEqual({ ok: false, message: "nope" });
    expect(toEvaluateOutcome({ ok: false })).toEqual({ ok: false, message: "evaluation failed" });
  });

  it("maps a plain value with its ref", () => {
    expect(toEvaluateOutcome({ ok: true, value: "42", type: "number", ref: 7 })).toEqual({
      ok: true,
      body: { result: "42", type: "number", variablesReference: 7 },
      invalidatesVariables: false,
    });
  });

  it("renders a missing value as nil with ref 0", () => {
    expect(toEvaluateOutcome({ ok: true })).toEqual({
      ok: true,
      body: { result: "nil", type: undefined, variablesReference: 0 },
      invalidatesVariables: false,
    });
  });

  it("marks assignments and invalidates variables", () => {
    expect(toEvaluateOutcome({ ok: true, value: "5", assigned: true })).toEqual({
      ok: true,
      body: { result: "5 (assigned)", type: undefined, variablesReference: 0 },
      invalidatesVariables: true,
    });
  });
});

describe("actionForResume", () => {
  it("continue clears the pending action; any step records 'step'", () => {
    expect(actionForResume("continue")).toBeUndefined();
    expect(actionForResume("step_over")).toBe("step");
    expect(actionForResume("step_into")).toBe("step");
    expect(actionForResume("step_out")).toBe("step");
  });
});

// ── the poll state machine ──

function snapJson(over: Partial<DebugSnapshot> = {}): string {
  const snap: DebugSnapshot = { frames: [fileFrame], pause_id: 1, ...over };
  return JSON.stringify(snap);
}

function tracking(over: Partial<SessionTracking> = {}): SessionTracking {
  return { ...INITIAL_TRACKING, ...over };
}

describe("pollTransition", () => {
  it("starts from a clean initial tracking", () => {
    expect(INITIAL_TRACKING).toEqual({
      sawActive: false,
      runSettled: false,
      lastPauseId: 0,
      lastAction: undefined,
      snapshot: undefined,
    });
  });

  it("idle before the run ever became active emits nothing (no premature terminate)", () => {
    const { events, next } = pollTransition({ paused: false, running: false }, tracking());
    expect(events).toEqual([]);
    expect(next.sawActive).toBe(false);
    expect(next.snapshot).toBeUndefined();
  });

  it("running marks the session active without events", () => {
    const { events, next } = pollTransition({ paused: false, running: true }, tracking());
    expect(events).toEqual([]);
    expect(next.sawActive).toBe(true);
  });

  it("running → stopped finishes with the state's error", () => {
    const s = tracking({ sawActive: true });
    const { events } = pollTransition({ paused: false, running: false, error: "boom" }, s);
    expect(events).toEqual([{ type: "finish", error: "boom" }]);
  });

  it("a null state error finishes with undefined", () => {
    const s = tracking({ sawActive: true });
    const { events } = pollTransition({ paused: false, running: false, error: null }, s);
    expect(events).toEqual([{ type: "finish", error: undefined }]);
  });

  it("idle after the run call settled finishes even if never seen active", () => {
    const s = tracking({ runSettled: true });
    const { events } = pollTransition({ paused: false, running: false }, s);
    expect(events).toEqual([{ type: "finish", error: undefined }]);
  });

  it("becoming active in this same poll counts (running:false but paused would set it)", () => {
    // paused:true with no snapshot string falls through to the terminate check,
    // and sawActive was just set by this poll — mirrors the original adapter.
    const { events, next } = pollTransition({ paused: true, running: false }, tracking());
    expect(next.sawActive).toBe(true);
    expect(events).toEqual([{ type: "finish", error: undefined }]);
  });

  it("a new pause_id emits stopped (default reason breakpoint) and stores the snapshot", () => {
    const st: DebugState = { paused: true, running: true, snapshot: snapJson({ pause_id: 3 }) };
    const { events, next } = pollTransition(st, tracking());
    expect(events).toEqual([
      {
        type: "stopped",
        body: {
          reason: "breakpoint",
          threadId: 1,
          allThreadsStopped: true,
          description: undefined,
          text: undefined,
        },
      },
    ]);
    expect(next.lastPauseId).toBe(3);
    expect(next.snapshot?.frames).toEqual([fileFrame]);
    expect(next.sawActive).toBe(true);
  });

  it("the same pause_id is deduped — no repeated stopped events", () => {
    const st: DebugState = { paused: true, running: true, snapshot: snapJson({ pause_id: 3 }) };
    const first = pollTransition(st, tracking());
    const again = pollTransition(st, first.next);
    expect(again.events).toEqual([]);
    expect(again.next.snapshot).toBe(first.next.snapshot);
    expect(again.next.lastPauseId).toBe(3);
  });

  it("a NEW pause_id on the same line is a new stop", () => {
    const first = pollTransition(
      { paused: true, running: true, snapshot: snapJson({ pause_id: 1 }) },
      tracking(),
    );
    const second = pollTransition(
      { paused: true, running: true, snapshot: snapJson({ pause_id: 2 }) },
      first.next,
    );
    expect(second.events.some((e) => e.type === "stopped")).toBe(true);
  });

  it("a pending step action names the stop 'step' and is consumed", () => {
    const s = tracking({ lastAction: "step" });
    const { events, next } = pollTransition(
      { paused: true, running: true, snapshot: snapJson() },
      s,
    );
    expect(events[0]).toMatchObject({ type: "stopped", body: { reason: "step" } });
    expect(next.lastAction).toBeUndefined();
  });

  it("a pending pause action names the stop 'pause'", () => {
    const s = tracking({ lastAction: "pause" });
    const { events } = pollTransition({ paused: true, running: true, snapshot: snapJson() }, s);
    expect(events[0]).toMatchObject({ type: "stopped", body: { reason: "pause" } });
  });

  it("an error stop overrides the pending action with 'exception' + description/text", () => {
    const s = tracking({ lastAction: "step" });
    const st: DebugState = {
      paused: true,
      running: true,
      snapshot: snapJson({ stop_reason: "error", error: "attempt to index nil" }),
    };
    const { events } = pollTransition(st, s);
    expect(events).toEqual([
      { type: "output", text: "attempt to index nil", category: "stderr" },
      {
        type: "stopped",
        body: {
          reason: "exception",
          threadId: 1,
          allThreadsStopped: true,
          description: "Paused on error",
          text: "attempt to index nil",
        },
      },
    ]);
  });

  it("an error stop without message still stops as exception with no text", () => {
    const st: DebugState = {
      paused: true,
      running: true,
      snapshot: snapJson({ stop_reason: "error", error: null }),
    };
    const { events } = pollTransition(st, tracking());
    expect(events).toEqual([
      {
        type: "stopped",
        body: {
          reason: "exception",
          threadId: 1,
          allThreadsStopped: true,
          description: "Paused on error",
          text: undefined,
        },
      },
    ]);
  });

  it("a condition error surfaces on stderr before the stopped event", () => {
    const st: DebugState = {
      paused: true,
      running: true,
      snapshot: snapJson({ cond_error: "bad condition: x >" }),
    };
    const { events } = pollTransition(st, tracking());
    expect(events).toEqual([
      { type: "output", text: "bad condition: x >", category: "stderr" },
      expect.objectContaining({ type: "stopped" }),
    ]);
  });

  it("guards a snapshot with missing frames (coerced to [])", () => {
    const raw = JSON.stringify({ pause_id: 5 });
    const { next } = pollTransition({ paused: true, running: true, snapshot: raw }, tracking());
    expect(next.snapshot?.frames).toEqual([]);
  });

  it("ignores a malformed snapshot JSON (keeps state, no events)", () => {
    const s = tracking({ lastPauseId: 2 });
    const { events, next } = pollTransition(
      { paused: true, running: true, snapshot: "{not json" },
      s,
    );
    expect(events).toEqual([]);
    expect(next.lastPauseId).toBe(2);
    expect(next.sawActive).toBe(true);
  });

  it("not-paused clears a stale snapshot (resumed from another client)", () => {
    const st: DebugState = { paused: true, running: true, snapshot: snapJson() };
    const paused = pollTransition(st, tracking());
    const resumed = pollTransition({ paused: false, running: true }, paused.next);
    expect(resumed.events).toEqual([]);
    expect(resumed.next.snapshot).toBeUndefined();
  });

  it("terminated transition: paused → resumed → done emits exactly one finish", () => {
    let s = tracking();
    s = pollTransition({ paused: true, running: true, snapshot: snapJson() }, s).next;
    s = pollTransition({ paused: false, running: true }, s).next;
    const done = pollTransition({ paused: false, running: false }, s);
    expect(done.events).toEqual([{ type: "finish", error: undefined }]);
  });

  it("does not mutate the input tracking object", () => {
    const s = tracking();
    pollTransition({ paused: true, running: true, snapshot: snapJson() }, s);
    expect(s).toEqual(INITIAL_TRACKING);
  });
});

describe("runFastPathDecision", () => {
  it("defers to the poll loop while a pause snapshot is live", () => {
    expect(runFastPathDecision({ ran: true }, true)).toEqual({ finish: false });
  });

  it("defers to the poll loop for a dispatched mission run", () => {
    // Forwarded to the resident mission runtime (DCS ≥ 2.9.27): the response
    // says only "dispatched" — outcome and errors arrive via debug_state.
    expect(runFastPathDecision({ dispatched: true }, false)).toEqual({ finish: false });
  });

  it("finishes cleanly when the short run succeeded", () => {
    expect(runFastPathDecision({ ran: true }, false)).toEqual({ finish: true, error: undefined });
  });

  it("finishes with the run error when it failed", () => {
    expect(runFastPathDecision({ ran: false, error: "syntax error" }, false)).toEqual({
      finish: true,
      error: "syntax error",
    });
  });

  it("maps a null error to undefined", () => {
    expect(runFastPathDecision({ ran: false, error: null }, false)).toEqual({
      finish: true,
      error: undefined,
    });
  });
});

describe("noDebugOutcome", () => {
  it("prints a returned value", () => {
    expect(noDebugOutcome({ ok: true, result: { a: 1 } })).toEqual({ output: '→ {"a":1}' });
    expect(noDebugOutcome({ ok: true, result: 0 })).toEqual({ output: "→ 0" });
  });

  it("stays quiet for nil results", () => {
    expect(noDebugOutcome({ ok: true })).toEqual({});
    expect(noDebugOutcome({ ok: true, result: null })).toEqual({});
  });

  it("carries the script error, with a default", () => {
    expect(noDebugOutcome({ ok: false, err: "oops" })).toEqual({ error: "oops" });
    expect(noDebugOutcome({ ok: false })).toEqual({ error: "script failed" });
  });
});
