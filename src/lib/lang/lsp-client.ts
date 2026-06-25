// JSON-RPC client for a backend-hosted language server (decisions/005).
//
// The Rust side (`crates/app/src/lsp.rs`) is a dumb framed byte pump;
// this class owns the protocol: request ids, response correlation,
// notification dispatch, lifecycle. The transport is injectable so the
// browser e2e suite (`/lab/lsp`) exercises this exact code against an
// in-page fake server.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** How a client reaches its server; production = the Tauri host pump. */
export interface LspTransport {
  start(onMessage: (raw: string) => void, onExit: () => void): Promise<void>;
  send(message: string): Promise<void>;
  stop(): Promise<void>;
}

/** A request that outlives this has hit a dead or wedged server. */
const REQUEST_TIMEOUT_MS = 15_000;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class TauriTransport implements LspTransport {
  private unlisten: UnlistenFn[] = [];

  constructor(
    private readonly serverId: string,
    private readonly program: string,
    private readonly args: string[],
  ) {}

  async start(
    onMessage: (raw: string) => void,
    onExit: () => void,
  ): Promise<void> {
    this.unlisten.push(
      await listen<string>(`lsp://message/${this.serverId}`, (event) =>
        onMessage(event.payload),
      ),
    );
    this.unlisten.push(
      await listen(`lsp://exit/${this.serverId}`, () => onExit()),
    );
    // Surface server stderr in the devtools console until the Output
    // panel grows a consumer.
    this.unlisten.push(
      await listen<string>(`lsp://stderr/${this.serverId}`, (event) =>
        console.debug(`[${this.serverId}]`, event.payload),
      ),
    );
    await invoke("lsp_start", {
      serverId: this.serverId,
      program: this.program,
      args: this.args,
    });
  }

  async send(message: string): Promise<void> {
    await invoke("lsp_send", { serverId: this.serverId, message });
  }

  async stop(): Promise<void> {
    await invoke("lsp_stop", { serverId: this.serverId });
    for (const stop of this.unlisten) stop();
    this.unlisten = [];
  }
}

export class LspClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly notificationHandlers = new Map<
    string,
    (params: unknown) => void
  >();
  private readonly exitHandlers: (() => void)[] = [];
  private alive = true;
  // Single-flight latch for stop(), claimed before its first await so a racing
  // or repeat stop() short-circuits without re-sending shutdown/exit or
  // re-reaping. Separate from `alive` (which gates caller requests and marks
  // "reaped"): flipping that first would suppress stop()'s own polite shutdown.
  private stopping = false;

  private constructor(private readonly transport: LspTransport) {}

  /** Spawn `program args` behind the backend host and attach. */
  static async start(
    serverId: string,
    program: string,
    args: string[],
  ): Promise<LspClient> {
    return LspClient.withTransport(new TauriTransport(serverId, program, args));
  }

  /** Attach over any transport — the browser test seam. */
  static async withTransport(transport: LspTransport): Promise<LspClient> {
    const client = new LspClient(transport);
    await transport.start(
      (raw) => client.onMessage(raw),
      () => client.onExit(),
    );
    return client;
  }

  get isAlive(): boolean {
    return this.alive;
  }

  onNotification(method: string, handler: (params: unknown) => void): void {
    this.notificationHandlers.set(method, handler);
  }

  /** Runs when the server goes away — crash or teardown. */
  onServerExit(handler: () => void): void {
    this.exitHandlers.push(handler);
  }

  async request(
    method: string,
    params: unknown,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    if (!this.alive) throw new Error("language server exited");
    const id = this.nextId++;
    const settled = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`lsp request '${method}' timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    await this.send({ jsonrpc: "2.0", id, method, params });
    return settled;
  }

  async notify(method: string, params: unknown): Promise<void> {
    if (!this.alive) throw new Error("language server exited");
    await this.send({ jsonrpc: "2.0", method, params });
  }

  /** Polite LSP teardown, then reap the process. Idempotent and race-safe: the
   *  first caller claims the teardown; a second or concurrent stop() — e.g.
   *  reindex.restart() racing a switch-mount on the shared client — returns at
   *  the latch, so shutdown/exit go out once and onExit fires once. */
  async stop(): Promise<void> {
    if (this.stopping || !this.alive) return;
    this.stopping = true;
    try {
      await this.request("shutdown", null, 1000);
      await this.notify("exit", null);
    } catch {
      /* the host's kill path covers an impolite server */
    }
    await this.transport.stop();
    this.onExit();
  }

  private async send(message: unknown): Promise<void> {
    await this.transport.send(JSON.stringify(message));
  }

  private onMessage(raw: string): void {
    let message: {
      id?: number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { message?: string };
    };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? "lsp error"));
      } else {
        pending.resolve(message.result ?? null);
      }
      return;
    }
    if (message.id !== undefined && message.method !== undefined) {
      // Server→client REQUEST: must be answered or servers that gate on
      // the reply (rust-analyzer does) stall their pipelines.
      this.respond(message.id, message.method, message.params);
      return;
    }
    if (message.method) {
      this.notificationHandlers.get(message.method)?.(message.params);
    }
  }

  /** Answer a server→client request with the minimal honest reply. */
  private respond(id: number, method: string, params: unknown): void {
    let reply: { result: unknown } | { error: unknown };
    if (method === "workspace/configuration") {
      // "No opinion" per requested item keeps server defaults in force.
      const items = (params as { items?: unknown[] } | null)?.items ?? [];
      reply = { result: items.map(() => null) };
    } else if (
      method === "client/registerCapability" ||
      method === "client/unregisterCapability" ||
      method === "window/workDoneProgress/create"
    ) {
      reply = { result: null };
    } else {
      reply = { error: { code: -32601, message: "method not found" } };
    }
    this.send({ jsonrpc: "2.0", id, ...reply }).catch(() => {
      /* a dying transport already surfaces via onExit */
    });
  }

  private onExit(): void {
    if (!this.alive) return;
    this.alive = false;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("language server exited"));
    }
    this.pending.clear();
    for (const handler of this.exitHandlers) handler();
  }
}
