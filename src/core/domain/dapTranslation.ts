// Pure DAP ↔ bridge translation for the DCS Lua debugger. The vscode
// DebugAdapter (src/debug/adapter.ts) owns timers, the BridgeClient and the
// event emitter; every decision — chunkname↔path rules, stop-reason mapping,
// pause_id dedupe, snapshot→StackFrame/Scope/Variable mapping, and the poll
// state machine — lives here so it can be characterization-tested without a sim.

import * as path from "path";
import { DebugFrame, DebugSnapshot, DebugState, DebugValue, ReplVariable } from "./bridgeProtocol";

// ── Chunkname ↔ path ──

/** Chunkname the sim sees for a file: "=<abs path>" (normalized by the DLL). */
export function sourceId(fsPath: string): string {
  return "=" + fsPath;
}

/** Map a snapshot chunkname back to a file path, if it names one. */
export function pathOfSource(chunkname: string): string | undefined {
  const p = chunkname.replace(/^[=@]/, "");
  if (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("/")) return p;
  return undefined;
}

// ── DAP plumbing rules ──

/** Failure responses stay quiet in the UI for evaluate/hover; anything else surfaces. */
export function showUserForFailure(command: string): boolean {
  return command !== "evaluate";
}

/** The single thread's display name for a debug env. */
export function threadName(env: string): string {
  return env === "mission" ? "DCS Mission" : "DCS GUI (hooks)";
}

// ── Breakpoints ──

export interface StoredBreakpoint {
  line: number;
  condition?: string;
}

/** Bridge `debug_set_breakpoints` payload: omit (don't null) absent conditions. */
export function toBridgeBreakpoints(
  bps: readonly StoredBreakpoint[],
): { line: number; condition?: string }[] {
  return bps.map((b) => (b.condition ? { line: b.line, condition: b.condition } : { line: b.line }));
}

/** DAP setBreakpoints response body: everything verified at its requested line. */
export function toBreakpointsResponse(bps: readonly StoredBreakpoint[]): {
  breakpoints: { verified: boolean; line: number }[];
} {
  return { breakpoints: bps.map((b) => ({ verified: true, line: b.line })) };
}

// ── Snapshot → DAP shapes ──

export interface DapStackFrame {
  id: number;
  name: string;
  line: number;
  column: number;
  source?: { name: string; path: string };
  presentationHint?: string;
}

/** Snapshot frames → DAP stackTrace body. Non-file chunknames render "subtle". */
export function toStackTraceResponse(frames: readonly DebugFrame[]): {
  stackFrames: DapStackFrame[];
  totalFrames: number;
} {
  return {
    stackFrames: frames.map((f) => {
      const p = pathOfSource(f.source);
      return {
        id: f.index,
        name: f.name,
        line: f.line,
        column: 1,
        source: p ? { name: path.basename(p), path: p } : undefined,
        presentationHint: p ? undefined : "subtle",
      };
    }),
    totalFrames: frames.length,
  };
}

/** A paused frame's scopes → DAP scopes body ("Globals" is expensive). */
export function toScopesResponse(frame: DebugFrame | undefined): {
  scopes: { name: string; variablesReference: number; expensive: boolean }[];
} {
  return {
    scopes: (frame?.scopes ?? []).map((s) => ({
      name: s.name,
      variablesReference: s.ref,
      expensive: s.name === "Globals",
    })),
  };
}

/** Bridge variables → DAP variables body. */
export function toVariablesResponse(variables: readonly ReplVariable[]): {
  variables: { name: string; value: string; type: string; variablesReference: number }[];
} {
  return {
    variables: variables.map((v) => ({
      name: v.name,
      value: v.value,
      type: v.type,
      variablesReference: v.ref,
    })),
  };
}

/** debug_eval result → DAP evaluate outcome (an assignment invalidates variables). */
export type EvaluateOutcome =
  | { ok: false; message: string }
  | {
      ok: true;
      body: { result: string; type?: string; variablesReference: number };
      invalidatesVariables: boolean;
    };

export function toEvaluateOutcome(r: DebugValue): EvaluateOutcome {
  if (!r.ok) return { ok: false, message: r.err ?? "evaluation failed" };
  return {
    ok: true,
    body: {
      result: r.assigned ? `${r.value} (assigned)` : (r.value ?? "nil"),
      type: r.type,
      variablesReference: r.ref ?? 0,
    },
    invalidatesVariables: r.assigned === true,
  };
}

// ── Resume / stop-reason bookkeeping ──

/** What the user last asked for — picks the `stopped` event reason at the next pause. */
export type LastAction = "step" | "pause" | undefined;

/** The `lastAction` a resume request implies: steps stop as "step", continue clears it. */
export function actionForResume(mode: string): LastAction {
  return mode === "continue" ? undefined : "step";
}

// ── The poll state machine ──

/** Adapter-held session tracking threaded through each debug_state poll. */
export interface SessionTracking {
  /** The session was ever seen running or paused (guards premature terminate). */
  sawActive: boolean;
  /** The debug_run call itself settled (fast-path end for short scripts). */
  runSettled: boolean;
  /** Last snapshot pause_id already surfaced — a different value is a NEW stop. */
  lastPauseId: number;
  lastAction: LastAction;
  /** The live pause snapshot, present while the UI shows a stopped state. */
  snapshot: DebugSnapshot | undefined;
}

export const INITIAL_TRACKING: SessionTracking = {
  sawActive: false,
  runSettled: false,
  lastPauseId: 0,
  lastAction: undefined,
  snapshot: undefined,
};

export type SessionEvent =
  | { type: "output"; text: string; category: "stderr" }
  | {
      type: "stopped";
      body: {
        reason: string;
        threadId: number;
        allThreadsStopped: boolean;
        description?: string;
        text?: string;
      };
    }
  | { type: "finish"; error?: string };

/**
 * One debug_state poll: decide which DAP events to emit and the next tracking
 * state. Mirrors the session model exactly: a new pause_id ⇒ `stopped` (reason
 * "exception" for error stops, else the pending step/pause action, else
 * "breakpoint"); not paused clears any stale pause UI; running true→false after
 * the session was seen active (or the run call settled) ⇒ `finish`.
 */
export function pollTransition(
  st: DebugState,
  s: SessionTracking,
): { events: SessionEvent[]; next: SessionTracking } {
  const next: SessionTracking = { ...s };
  const events: SessionEvent[] = [];

  if (st.running || st.paused) next.sawActive = true;

  if (st.paused && st.snapshot) {
    let snap: DebugSnapshot;
    try {
      snap = JSON.parse(st.snapshot) as DebugSnapshot;
    } catch {
      return { events, next };
    }
    if (snap.pause_id !== s.lastPauseId) {
      next.lastPauseId = snap.pause_id;
      // Missing frames should never happen, but guard the UI anyway.
      if (!Array.isArray(snap.frames)) snap.frames = [];
      next.snapshot = snap;
      const isError = snap.stop_reason === "error";
      const reason = isError ? "exception" : (s.lastAction ?? "breakpoint");
      next.lastAction = undefined;
      if (snap.cond_error) events.push({ type: "output", text: snap.cond_error, category: "stderr" });
      if (isError && snap.error) events.push({ type: "output", text: snap.error, category: "stderr" });
      events.push({
        type: "stopped",
        body: {
          reason,
          threadId: 1,
          allThreadsStopped: true,
          description: isError ? "Paused on error" : undefined,
          text: isError ? (snap.error ?? undefined) : undefined,
        },
      });
    }
    return { events, next };
  }

  // Not paused: drop any stale pause UI (e.g. resumed from another client).
  next.snapshot = undefined;

  if (!st.running && (next.sawActive || s.runSettled)) {
    events.push({ type: "finish", error: st.error ?? undefined });
  }
  return { events, next };
}

/**
 * debug_run resolved (fast-path end for short scripts): finish now unless a
 * pause snapshot is live — then the poll loop owns the outcome. A mission run
 * resolves `{ dispatched: true }` immediately (the resident mission runtime
 * executes it asynchronously — DCS ≥ 2.9.27); the poll loop owns that outcome
 * entirely, including its errors, which arrive via debug_state.
 */
export function runFastPathDecision(
  res: { ran?: boolean; error?: string | null; dispatched?: boolean },
  hasSnapshot: boolean,
): { finish: boolean; error?: string } {
  if (res && res.dispatched === true) return { finish: false };
  if (hasSnapshot) return { finish: false };
  return { finish: true, error: res.ran ? undefined : (res.error ?? undefined) };
}

/** Run-without-debugging (repl_eval) outcome → console output + terminal error. */
export function noDebugOutcome(res: { ok: boolean; result?: unknown; err?: string }): {
  output?: string;
  error?: string;
} {
  if (res.ok) {
    return res.result !== undefined && res.result !== null
      ? { output: `→ ${JSON.stringify(res.result)}` }
      : {};
  }
  return { error: res.err ?? "script failed" };
}
