import * as vscode from "vscode";
import { BridgeConnection, BridgeTransportPort } from "../core/ports/bridgeTransport";
import {
  BRIDGE_INITIAL_BACKOFF_MS,
  BridgeStatus,
  DebugEnv,
  DebugState,
  DebugValue,
  INITIAL_BRIDGE_STATUS,
  LuaEnv,
  PING_INTERVAL_MS,
  PING_TIMEOUT_MS,
  ReplInspectResult,
  ReplVariable,
  buildRequest,
  dcsTimeFromPing,
  formatRequestId,
  nextBackoff,
  parseResponse,
} from "../core/domain/bridgeProtocol";
import { WsBridgeTransport } from "../adapters/node/wsTransport";

// Editor-side WebSocket JSON-RPC client for the in-DCS bridge (dcs_studio.dll on
// ws://127.0.0.1:25569/ws). Reconnects with backoff, pings for live status, and
// matches responses to calls by string id (the bridge's serde rejects numeric
// ids). Mirrors dcs-studio's dcs-bridge-client behaviour. This class is the
// stateful shell — sockets via `BridgeTransportPort`, timers, the pending map —
// over the pure protocol rules in core/domain/bridgeProtocol.
export {
  BridgeStatus,
  LuaEnv,
  DebugEnv,
  ReplVariable,
  ReplInspectResult,
  DebugFrame,
  DebugSnapshot,
  DebugState,
  DebugValue,
} from "../core/domain/bridgeProtocol";

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class BridgeClient {
  private conn: BridgeConnection | undefined;
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private backoff = BRIDGE_INITIAL_BACKOFF_MS;
  private disposed = false;
  private status: BridgeStatus = INITIAL_BRIDGE_STATUS;
  private readonly listeners = new Set<(s: BridgeStatus) => void>();
  private readonly transport: BridgeTransportPort;

  constructor(
    private readonly host = "127.0.0.1",
    private readonly port = 25569,
    transport?: BridgeTransportPort,
  ) {
    this.transport = transport ?? new WsBridgeTransport();
  }

  get current(): BridgeStatus {
    return this.status;
  }

  onStatus(fn: (s: BridgeStatus) => void): vscode.Disposable {
    this.listeners.add(fn);
    fn(this.status);
    return new vscode.Disposable(() => this.listeners.delete(fn));
  }

  start(): void {
    if (!this.disposed && !this.conn) this.connect();
  }

  /** Force an immediate reconnect attempt (e.g. after launching DCS). */
  reconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.backoff = BRIDGE_INITIAL_BACKOFF_MS;
    if (!this.conn) this.connect();
  }

  /** Run Lua in the sim's GUI/hooks env; resolves with its return value. */
  eval(code: string, timeoutMs = 15000): Promise<unknown> {
    return this.call("eval", { code }, timeoutMs);
  }

  /** Console lines printed since `after`: { lines: [{seq,text}], latest }. */
  consoleRead(after: number): Promise<{ lines: { seq: number; text: string }[]; latest: number }> {
    return this.call("console_read", { after }) as Promise<{
      lines: { seq: number; text: string }[];
      latest: number;
    }>;
  }

  /** A repl_* call that transparently completes forwarded mission jobs. For
   * the mission env the bridge answers `{ pending, token }` immediately (the
   * resident mission runtime executes asynchronously — a_do_script cannot
   * return values on DCS ≥ 2.9.27) and the result is collected via repl_poll
   * once the sim ticks it through. Direct envs return their result as-is. */
  private async replCall<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 35000,
  ): Promise<T> {
    const first = (await this.call(method, params, timeoutMs)) as
      | T
      | { pending?: boolean; token?: number };
    const forwarded = first as { pending?: boolean; token?: number };
    if (forwarded?.pending !== true || typeof forwarded.token !== "number") {
      return first as T;
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
      const res = (await this.call("repl_poll", { token: forwarded.token }, 15000)) as
        | T
        | { pending?: boolean };
      if ((res as { pending?: boolean })?.pending !== true) {
        return res as T;
      }
    }
    throw new Error("the mission did not answer in time — is the sim unpaused?");
  }

  /** Run Lua in the chosen environment; { ok, result?, err? }. print() output
   * lands in the console ring (streamed by consoleRead) for every env. */
  replEval(env: LuaEnv, code: string): Promise<{ ok: boolean; result?: unknown; err?: string }> {
    return this.replCall("repl_eval", { env, code }, 35000);
  }

  /** Evaluate an expression for the table explorer; a ref > 0 drills further. */
  replInspect(env: LuaEnv, expr: string): Promise<ReplInspectResult> {
    return this.replCall("repl_inspect", { env, expr });
  }

  /** Children of a ref handed out by replInspect/replExpand in the same env. */
  replExpand(env: LuaEnv, ref: number): Promise<{ variables: ReplVariable[] }> {
    return this.replCall("repl_expand", { env, ref });
  }

  /** Release every explorer ref held inside `env`. */
  replClear(env: LuaEnv): Promise<unknown> {
    return this.replCall("repl_clear", { env });
  }

  /** Serialize a value (by explorer ref, else by evaluating `expr`) to a JSON
   * file in the DCS write dir; returns its path — big exports never ride the
   * WebSocket. Long timeout: the sim thread does the whole serialization. */
  replExport(env: LuaEnv, spec: { ref?: number; expr?: string }): Promise<{ path: string; bytes: number }> {
    const params = { env, ref: spec.ref, expr: spec.expr };
    return this.replCall("repl_export", params, 35000);
  }

  // ── Debugger (drives the in-sim engine; see bridge/Scripts/Hooks/DcsStudio.lua) ──

  /** Start a debug session: run `code` (chunkname `source`) under the line
   * hook in `env`. A gui run BLOCKS bridge-side for the whole session — never
   * await the result as the end-of-session signal (the server drops responses
   * after its 30s timeout); poll debugState instead. The resolved value is a
   * fast-path result for short gui runs; a mission run resolves immediately
   * with { dispatched: true } (the resident mission runtime executes it) and
   * the poll loop owns the outcome entirely. */
  debugRun(
    env: DebugEnv,
    source: string,
    code: string,
    pauseOnError: boolean,
    timeoutMs = 600_000,
  ): Promise<{ ran?: boolean; error?: string | null; dispatched?: boolean }> {
    return this.call(
      "debug_run",
      { env, source, code, pause_on_error: pauseOnError },
      timeoutMs,
    ) as Promise<{ ran?: boolean; error?: string | null; dispatched?: boolean }>;
  }

  /** The session poll: paused/running/error + pause snapshot. Also the
   * liveness signal that keeps a held pause from auto-continuing. */
  debugState(): Promise<DebugState> {
    return this.call("debug_state", {}, 5000) as Promise<DebugState>;
  }

  /** Resume a paused session: "continue" | "step_over" | "step_into" | "step_out". */
  debugContinue(mode: string): Promise<unknown> {
    return this.call("debug_continue", { mode });
  }

  /** Break-all: pause at the next executed line of debugged code. */
  debugPause(): Promise<unknown> {
    return this.call("debug_pause", {});
  }

  /** Terminate the running chunk (cooperative unwind at its next line). */
  debugStop(): Promise<unknown> {
    return this.call("debug_stop", {});
  }

  /** Children of a scope/variable ref from the pause snapshot. */
  debugExpand(ref: number): Promise<{ variables: ReplVariable[] }> {
    return this.call("debug_expand", { ref }) as Promise<{ variables: ReplVariable[] }>;
  }

  /** Evaluate (or `name = value`-assign) in paused frame `frame` (0-based). */
  debugEval(frame: number, expr: string): Promise<DebugValue> {
    return this.call("debug_eval", { frame, expr }) as Promise<DebugValue>;
  }

  /** Replace one source's breakpoints (with optional per-line conditions).
   * The registry is process-wide in the DLL: it works before and during a
   * session, whichever Lua state is serving. Omit (don't null) absent conditions. */
  debugSetBreakpoints(
    source: string,
    breakpoints: { line: number; condition?: string }[],
  ): Promise<{ count: number }> {
    return this.call("debug_set_breakpoints", { source, breakpoints }) as Promise<{ count: number }>;
  }

  /** Drop every breakpoint and condition (session start/end hygiene). */
  debugClearBreakpoints(): Promise<unknown> {
    return this.call("debug_clear_breakpoints", {});
  }

  call(method: string, params?: unknown, timeoutMs = 15000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.conn || !this.status.connected) {
        reject(new Error("bridge not connected"));
        return;
      }
      const id = formatRequestId(this.nextId++);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`bridge call '${method}' timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.conn.send(JSON.stringify(buildRequest(method, id, params)));
    });
  }

  dispose(): void {
    this.disposed = true;
    this.stopPing();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.failAll("disposed");
    this.conn?.close();
    this.conn = undefined;
  }

  private connect(): void {
    if (this.disposed) return;
    this.conn = this.transport.connect(
      { host: this.host, port: this.port, path: "/ws" },
      {
        onOpen: () => {
          this.backoff = BRIDGE_INITIAL_BACKOFF_MS;
          this.emit({ connected: true });
          this.startPing();
        },
        onMessage: (data) => this.onMessage(data),
        onClose: () => this.onDisconnect(),
        onError: () => this.onDisconnect(),
      },
    );
  }

  private onDisconnect(): void {
    this.stopPing();
    this.failAll("bridge disconnected");
    this.conn = undefined;
    this.emit({ connected: false, dcsTime: null });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    const delay = this.backoff;
    this.backoff = nextBackoff(this.backoff);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  private startPing(): void {
    this.stopPing();
    const tick = async () => {
      try {
        const r = (await this.call("ping", undefined, PING_TIMEOUT_MS)) as
          | { dcs_time?: number }
          | undefined;
        this.emit({ dcsTime: dcsTimeFromPing(r) });
      } catch {
        /* a real drop is handled by onDisconnect; a lone timeout is ignored */
      }
    };
    void tick();
    this.pingTimer = setInterval(() => void tick(), PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
  }

  private onMessage(data: string): void {
    const parsed = parseResponse(data);
    if (parsed.kind === "ignore") return;
    const p = this.pending.get(parsed.id);
    if (!p) return;
    this.pending.delete(parsed.id);
    clearTimeout(p.timer);
    if (parsed.kind === "error") p.reject(new Error(parsed.message));
    else p.resolve(parsed.result);
  }

  private failAll(reason: string): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private emit(patch: Partial<BridgeStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const l of this.listeners) l(this.status);
  }
}
