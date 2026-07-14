import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { BridgeClient, DebugEnv, DebugState } from "../bridge/client";
import { BridgeClients } from "../bridge/clients";
import { missionStartFailure } from "../core/domain/bridgeProtocol";
import { scanItems } from "../core/domain/missionSanitize";
import { missionScriptPath } from "../mission/missionPanel";
import {
  INITIAL_TRACKING,
  SessionEvent,
  SessionTracking,
  StoredBreakpoint,
  actionForResume,
  noDebugOutcome,
  pollTransition,
  runFastPathDecision,
  showUserForFailure,
  sourceId,
  threadName,
  toBreakpointsResponse,
  toBridgeBreakpoints,
  toEvaluateOutcome,
  toScopesResponse,
  toStackTraceResponse,
  toVariablesResponse,
} from "../core/domain/dapTranslation";
import { showError } from "../errors";

// Inline Debug Adapter Protocol implementation for DCS World Lua.
//
// VS Code's debugger UI speaks DAP; the in-sim engine speaks the bridge's
// JSON-RPC (debug_run / debug_state / debug_continue / debug_expand /
// debug_eval / debug_set_breakpoints). Each session talks to the bridge that
// owns its environment: env=gui → the GUI bridge (port 25569), env=mission →
// the mission bridge (port 25570, alive only while a mission runs). This
// adapter is the stateful shell, run in-process via
// DebugAdapterInlineImplementation so it can share the extension's two
// BridgeClient connections. Every translation decision (chunkname↔path rules,
// stop-reason mapping, pause_id dedupe, snapshot→DAP shapes, the poll state
// machine) is pure and lives in core/domain/dapTranslation.
//
// Session model (mirrors dcs-studio's debug-session state machine): debug_run
// BLOCKS bridge-side for the whole session, and the server drops responses
// after its 30s timeout — so the run call is only a fast-path end signal for
// short scripts. The authoritative signal is polling debug_state every 250ms:
// a new snapshot pause_id ⇒ emit `stopped`; running true→false ⇒ emit
// `terminated`. Console output rides the shared console ring (console_read),
// polled alongside and emitted as `output` events.

const POLL_MS = 250;
const CONSOLE_POLL_MS = 500;

interface DapRequest {
  seq: number;
  type: "request";
  command: string;
  arguments?: any;
}

export interface DcsLaunchConfig extends vscode.DebugConfiguration {
  program?: string;
  env?: DebugEnv;
  pauseOnError?: boolean;
  noDebug?: boolean;
}

export class DcsDebugAdapter implements vscode.DebugAdapter {
  private readonly emitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  readonly onDidSendMessage = this.emitter.event;

  private seq = 1;
  private config: DcsLaunchConfig;
  private env: DebugEnv = "mission";
  /** The client serving this session's env; re-selected when launch fixes the env. */
  private client: BridgeClient;

  /** Full breakpoint state per file, keyed by lower-cased path (pushed whole per source). */
  private readonly breakpoints = new Map<string, { fsPath: string; bps: StoredBreakpoint[] }>();

  private started = false;
  private finished = false;

  /** Pure poll-machine state (pause dedupe, live snapshot, stop-reason bookkeeping). */
  private tracking: SessionTracking = { ...INITIAL_TRACKING };

  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private consoleTimer: ReturnType<typeof setInterval> | undefined;
  private consoleAfter = 0;
  private polling = false;

  constructor(
    private readonly clients: BridgeClients,
    config: vscode.DebugConfiguration,
  ) {
    this.config = config as DcsLaunchConfig;
    this.env = this.config.env === "gui" ? "gui" : "mission";
    this.client = clients.forEnv(this.env);
  }

  handleMessage(message: vscode.DebugProtocolMessage): void {
    const m = message as DapRequest;
    if (m.type === "request") void this.dispatch(m);
  }

  dispose(): void {
    this.stopTimers();
    this.emitter.dispose();
  }

  // ── DAP plumbing ──

  private send(msg: Record<string, unknown>): void {
    this.emitter.fire({ ...msg, seq: this.seq++ } as vscode.DebugProtocolMessage);
  }

  private respond(req: DapRequest, body?: unknown): void {
    this.send({ type: "response", request_seq: req.seq, success: true, command: req.command, body });
  }

  private fail(req: DapRequest, message: string): void {
    this.send({
      type: "response",
      request_seq: req.seq,
      success: false,
      command: req.command,
      message,
      // showUser via the error body: evaluate/hover failures stay quiet in the
      // UI; anything else surfaces.
      body: { error: { id: 1, format: message, showUser: showUserForFailure(req.command) } },
    });
  }

  private event(event: string, body?: unknown): void {
    this.send({ type: "event", event, body });
  }

  private output(text: string, category: "stdout" | "stderr" | "console" = "stdout"): void {
    this.event("output", { category, output: text.endsWith("\n") ? text : text + "\n" });
  }

  private async dispatch(req: DapRequest): Promise<void> {
    try {
      switch (req.command) {
        case "initialize":
          this.respond(req, {
            supportsConfigurationDoneRequest: true,
            supportsConditionalBreakpoints: true,
            supportsEvaluateForHovers: true,
            supportsTerminateRequest: true,
            supportSuspendDebuggee: false,
            supportTerminateDebuggee: true,
          });
          this.event("initialized");
          break;
        case "launch":
          this.config = { ...this.config, ...(req.arguments as DcsLaunchConfig) };
          this.env = this.config.env === "gui" ? "gui" : "mission";
          this.client = this.clients.forEnv(this.env);
          this.respond(req);
          break;
        case "setBreakpoints":
          await this.onSetBreakpoints(req);
          break;
        case "setExceptionBreakpoints":
          this.respond(req, { breakpoints: [] });
          break;
        case "configurationDone":
          this.respond(req);
          void this.begin();
          break;
        case "threads":
          this.respond(req, {
            threads: [{ id: 1, name: threadName(this.env) }],
          });
          break;
        case "stackTrace":
          this.respond(req, toStackTraceResponse(this.tracking.snapshot?.frames ?? []));
          break;
        case "scopes":
          this.onScopes(req);
          break;
        case "variables":
          await this.onVariables(req);
          break;
        case "continue":
          await this.resume(req, "continue");
          break;
        case "next":
          await this.resume(req, "step_over");
          break;
        case "stepIn":
          await this.resume(req, "step_into");
          break;
        case "stepOut":
          await this.resume(req, "step_out");
          break;
        case "pause":
          this.tracking.lastAction = "pause";
          await this.client.debugPause();
          this.respond(req);
          break;
        case "evaluate":
          await this.onEvaluate(req);
          break;
        case "terminate":
        case "disconnect":
          await this.onDisconnect(req);
          break;
        default:
          // Anything unimplemented is acknowledged so the UI never hangs.
          this.respond(req);
          break;
      }
    } catch (e) {
      this.fail(req, e instanceof Error ? e.message : String(e));
    }
  }

  // ── Session lifecycle ──

  /** configurationDone: breakpoints are in — start the run. */
  private async begin(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const program = this.config.program;
    if (!program) {
      this.abort("No program to run — set `program` in the launch configuration.");
      return;
    }

    if (!this.client.current.connected) {
      // env=mission gets the precise reason (no mission running vs sanitized
      // MissionScripting.lua vs DCS down); env=gui the generic launch nudge.
      const message =
        this.env === "mission"
          ? (missionStartFailure(this.clients.current, missionSanitizedOnDisk()) ??
            "The mission bridge is not connected.")
          : "The DCS bridge is not connected. Launch DCS with the bridge (command: “DCS Studio: Launch DCS (with bridge)”) and wait for the status bar to show DCS online.";
      this.abort(message);
      return;
    }

    let code: string;
    try {
      // Prefer the live buffer (unsaved edits run as seen), else disk.
      const open = vscode.workspace.textDocuments.find(
        (d) => d.uri.scheme === "file" && samePath(d.uri.fsPath, program),
      );
      code = open ? open.getText() : await fs.promises.readFile(program, "utf8");
    } catch (e) {
      this.abort(`Cannot read ${program}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    // Output stream: start tailing AFTER the current ring position so a prior
    // session's lines don't replay.
    try {
      const tail = await this.client.consoleRead(Number.MAX_SAFE_INTEGER);
      this.consoleAfter = tail.latest ?? 0;
    } catch {
      this.consoleAfter = 0;
    }
    this.consoleTimer = setInterval(() => void this.drainConsole(), CONSOLE_POLL_MS);

    if (this.config.noDebug) {
      await this.runWithoutDebugging(code, program);
      return;
    }

    // Fresh registry, then the full current breakpoint set.
    try {
      await this.client.debugClearBreakpoints();
      await this.pushAllBreakpoints();
    } catch (e) {
      this.abort(`Failed to set breakpoints: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    this.output(`Debugging ${path.basename(program)} in the ${this.env} environment…`, "console");

    // Fire the run. Its resolution is a fast-path end for short scripts; long
    // sessions outlive the server's response window, so polling is the truth.
    this.client
      .debugRun(this.env, sourceId(program), code, this.config.pauseOnError !== false)
      .then((res) => {
        this.tracking.runSettled = true;
        const d = runFastPathDecision(res, this.tracking.snapshot !== undefined);
        if (d.finish) this.finish(d.error);
      })
      .catch(() => {
        // Timeout / reconnect: the poll loop owns the outcome.
        this.tracking.runSettled = true;
      });

    this.pollTimer = setInterval(() => void this.poll(), POLL_MS);
  }

  /** Run (no debugger): plain repl_eval in the target env, then terminate. */
  private async runWithoutDebugging(code: string, program: string): Promise<void> {
    this.output(`Running ${path.basename(program)} in the ${this.env} environment…`, "console");
    try {
      const res = await this.client.replEval(this.env, code);
      await this.drainConsole();
      const d = noDebugOutcome(res);
      if (d.output) this.output(d.output, "console");
      this.finish(d.error);
    } catch (e) {
      this.finish(e instanceof Error ? e.message : String(e));
    }
  }

  private abort(message: string): void {
    this.output(message, "stderr");
    void showError(message);
    this.finish(undefined, /*quiet*/ true);
  }

  private finish(error?: string, quiet = false): void {
    if (this.finished) return;
    this.finished = true;
    this.stopTimers();
    void this.drainConsole().finally(() => {
      if (error && !quiet) this.output(error, "stderr");
      this.event("exited", { exitCode: error ? 1 : 0 });
      this.event("terminated");
    });
  }

  private stopTimers(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.consoleTimer) clearInterval(this.consoleTimer);
    this.pollTimer = this.consoleTimer = undefined;
  }

  // ── Polling ──

  private async poll(): Promise<void> {
    if (this.polling || this.finished) return; // never overlap slow polls
    this.polling = true;
    try {
      const st = await this.client.debugState();
      this.onState(st);
    } catch {
      if (!this.client.current.connected) {
        this.finish("The DCS bridge disconnected — the debug session was abandoned.");
      }
      // A lone timeout (e.g. the state request got batched behind debug_run)
      // is retried on the next tick.
    } finally {
      this.polling = false;
    }
  }

  private onState(st: DebugState): void {
    const { events, next } = pollTransition(st, this.tracking);
    this.tracking = next;
    for (const ev of events) this.applyEvent(ev);
  }

  private applyEvent(ev: SessionEvent): void {
    switch (ev.type) {
      case "output":
        this.output(ev.text, ev.category);
        break;
      case "stopped":
        this.event("stopped", ev.body);
        break;
      case "finish":
        this.finish(ev.error);
        break;
    }
  }

  private async drainConsole(): Promise<void> {
    try {
      const r = await this.client.consoleRead(this.consoleAfter);
      if (r.lines.length) {
        this.consoleAfter = r.latest;
        for (const l of r.lines) this.output(l.text, "stdout");
      }
    } catch {
      /* transient — next tick retries */
    }
  }

  // ── Breakpoints ──

  private async onSetBreakpoints(req: DapRequest): Promise<void> {
    const args = req.arguments as {
      source: { path?: string };
      breakpoints?: { line: number; condition?: string }[];
    };
    const fsPath = args.source.path;
    if (!fsPath) {
      this.respond(req, { breakpoints: [] });
      return;
    }
    const bps: StoredBreakpoint[] = (args.breakpoints ?? []).map((b) => ({
      line: b.line,
      condition: b.condition,
    }));
    this.breakpoints.set(fsPath.toLowerCase(), { fsPath, bps });

    // Live push (before launch the whole set goes with begin()). The registry
    // is shared DLL state, so this works even while paused — the paused
    // state's own pump serves it.
    if (this.started && !this.finished && !this.config.noDebug) {
      try {
        await this.pushSource(fsPath, bps);
      } catch (e) {
        this.output(
          `Could not update breakpoints in ${path.basename(fsPath)}: ${e instanceof Error ? e.message : String(e)}`,
          "stderr",
        );
      }
    }

    this.respond(req, toBreakpointsResponse(bps));
  }

  private pushSource(fsPath: string, bps: StoredBreakpoint[]): Promise<unknown> {
    return this.client.debugSetBreakpoints(sourceId(fsPath), toBridgeBreakpoints(bps));
  }

  private async pushAllBreakpoints(): Promise<void> {
    for (const { fsPath, bps } of this.breakpoints.values()) {
      await this.pushSource(fsPath, bps);
    }
  }

  // ── Stack / variables / eval ──

  private onScopes(req: DapRequest): void {
    const frameId = (req.arguments as { frameId: number }).frameId;
    const frame = this.tracking.snapshot?.frames.find((f) => f.index === frameId);
    this.respond(req, toScopesResponse(frame));
  }

  private async onVariables(req: DapRequest): Promise<void> {
    const ref = (req.arguments as { variablesReference: number }).variablesReference;
    const r = await this.client.debugExpand(ref);
    this.respond(req, toVariablesResponse(r.variables));
  }

  private async resume(req: DapRequest, mode: string): Promise<void> {
    this.tracking.lastAction = actionForResume(mode);
    this.tracking.snapshot = undefined;
    await this.client.debugContinue(mode);
    this.respond(req, mode === "continue" ? { allThreadsContinued: true } : undefined);
  }

  private async onEvaluate(req: DapRequest): Promise<void> {
    const args = req.arguments as { expression: string; frameId?: number; context?: string };
    if (!this.tracking.snapshot) {
      this.fail(req, "not paused");
      return;
    }
    const r = await this.client.debugEval(args.frameId ?? 0, args.expression);
    const outcome = toEvaluateOutcome(r);
    if (!outcome.ok) {
      this.fail(req, outcome.message);
      return;
    }
    this.respond(req, outcome.body);
    // A real assignment changes locals the UI already rendered.
    if (outcome.invalidatesVariables) this.event("invalidated", { areas: ["variables"] });
  }

  private async onDisconnect(req: DapRequest): Promise<void> {
    if (!this.finished) {
      try {
        await this.client.debugStop();
      } catch {
        /* already gone */
      }
    }
    try {
      await this.client.debugClearBreakpoints();
    } catch {
      /* best effort — cleared again at next session start */
    }
    this.finish(undefined, /*quiet*/ true);
    this.respond(req);
  }
}

/** Case-insensitive path equality (Windows drive letters, separators). */
function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/** Whether MissionScripting.lua on disk still has its lockdown active (the
 * mission bridge can't boot then). undefined when the file can't be read. */
function missionSanitizedOnDisk(): boolean | undefined {
  const p = missionScriptPath();
  if (!p) return undefined;
  try {
    const items = scanItems(fs.readFileSync(p, "utf8"));
    return items.some((i) => i.present && i.sanitized);
  } catch {
    return undefined;
  }
}
