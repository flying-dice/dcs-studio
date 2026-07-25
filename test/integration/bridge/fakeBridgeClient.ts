import type { BridgeStatus } from "../../../src/core/domain/bridgeProtocol";

// A scriptable stand-in for BridgeClient, shared by the specs that exercise the
// shells sitting on top of it (BridgeClients, the console panel, the database
// export command).
//
// A real BridgeClient needs a socket, and the behaviour those shells care about
// is entirely "what the sim answered": a bridge that is offline, a bridge that
// drops mid-conversation, an RPC that returns a Lua error rather than throwing.
// Scripting the answers is the only way to reach those.

/** Every RPC the shells under test make, in order, for call-site assertions. */
export interface RecordedCall {
  method: string;
  args: unknown[];
}

export class FakeBridgeClient {
  status: BridgeStatus = { connected: false, dcsTime: null };
  readonly calls: RecordedCall[] = [];
  started = 0;
  reconnected = 0;
  disposed = 0;

  private readonly listeners: ((s: BridgeStatus) => void)[] = [];
  /** Scripted answers per method; a function may throw to model a failed RPC. */
  private readonly answers = new Map<string, (...args: unknown[]) => unknown>();

  get current(): BridgeStatus {
    return this.status;
  }

  onStatus(fn: (s: BridgeStatus) => void): { dispose(): void } {
    this.listeners.push(fn);
    // The real client replays the current status to every new subscriber.
    fn(this.status);
    return {
      dispose: () => {
        const i = this.listeners.indexOf(fn);
        if (i >= 0) this.listeners.splice(i, 1);
      },
    };
  }

  /** Play a status change, as a connect/disconnect/ping would. */
  emit(status: BridgeStatus): void {
    this.status = status;
    for (const fn of [...this.listeners]) fn(status);
  }

  /** How many callers are currently subscribed — a leak check for disposal. */
  get listenerCount(): number {
    return this.listeners.length;
  }

  /** Script one method's answer. Throw from `fn` to model a failing RPC. */
  answer(method: string, fn: (...args: unknown[]) => unknown): void {
    this.answers.set(method, fn);
  }

  start(): void {
    this.started++;
  }

  reconnect(): void {
    this.reconnected++;
  }

  dispose(): void {
    this.disposed++;
  }

  // ── the RPC surface the shells use ──
  consoleRead = this.rpc("consoleRead", () => ({ lines: [], latest: 0 }));
  replEval = this.rpc("replEval", () => ({ ok: true }));
  replInspect = this.rpc("replInspect", () => ({ ok: true }));
  replExpand = this.rpc("replExpand", () => ({ variables: [] }));
  replSignature = this.rpc("replSignature", () => ({ ok: true }));
  replClear = this.rpc("replClear", () => ({}));
  replExport = this.rpc("replExport", () => ({ path: "", bytes: 0 }));
  dbCategories = this.rpc("dbCategories", () => ({ categories: [] }));
  dbUnitTypes = this.rpc("dbUnitTypes", () => ({ units: [] }));
  dbExport = this.rpc("dbExport", () => ({ path: "", bytes: 0 }));

  /** Record the call, then answer from the script (or the default). */
  private rpc(method: string, fallback: () => unknown) {
    return async (...args: unknown[]): Promise<never> => {
      this.calls.push({ method, args });
      return (this.answers.get(method) ?? fallback)(...args) as never;
    };
  }

  /** The last call to `method`, or undefined if it was never made. */
  lastCall(method: string): RecordedCall | undefined {
    return [...this.calls].reverse().find((c) => c.method === method);
  }
}

export const CONNECTED: BridgeStatus = { connected: true, dcsTime: 0 };
export const OFFLINE: BridgeStatus = { connected: false, dcsTime: null };
