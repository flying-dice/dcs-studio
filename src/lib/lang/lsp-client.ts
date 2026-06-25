// JSON-RPC client for a backend-hosted language server (decisions/005).
//
// The Rust side (`crates/app/src/lsp.rs`) is a dumb framed byte pump;
// this class owns the protocol: request ids, response correlation,
// notification dispatch, lifecycle. The transport is injectable so the
// browser e2e suite (`/lab/lsp`) exercises this exact code against an
// in-page fake server.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Why a server exited, handed to {@link LspClient.onServerExit} handlers. */
export interface LspExitInfo {
  /**
   * True when the process died on its own (a crash); false on a deliberate
   * {@link LspClient.stop} — project switch, re-index, or shutdown. Lets a
   * consumer notify on a genuine failure without flagging an orderly teardown.
   */
  unexpected: boolean;
  /** The trailing stderr lines captured before the exit, as failure context. */
  stderr: string[];
}

/** How a client reaches its server; production = the Tauri host pump. */
export interface LspTransport {
  /**
   * Attach to the server. Resolves `true` when it was freshly spawned (the
   * caller must run the LSP initialize handshake) and `false` when it
   * re-attached to a server that outlived a webview reload and is already
   * initialized (skip the handshake — re-initializing a live server is the
   * issue-#31 protocol violation). `onStderr` receives the server's stderr
   * lines for an exit's failure context (issue #61).
   */
  start(
    onMessage: (raw: string) => void,
    onExit: () => void,
    onStderr?: (line: string) => void,
  ): Promise<boolean>;
  send(message: string): Promise<void>;
  stop(): Promise<void>;
  /**
   * Record that the initialize handshake completed, so a later re-attach
   * can skip it. Absent on transports with no backend lifecycle to track
   * (the in-page browser fake).
   */
  markInitialized?(): Promise<void>;
}

/** A request that outlives this has hit a dead or wedged server. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Trailing stderr lines kept for an exit's failure context (bounded). */
export const STDERR_BUFFER_LINES = 50;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class TauriTransport implements LspTransport {
  private unlisten: UnlistenFn[] = [];
  // The backend-assigned PHYSICAL id this spawn answers on — the key for
  // every send/stop/mark. Learned from `lsp_get_or_start`; `logicalId` is
  // the stable name the backend resolves against.
  private physicalId = "";

  constructor(
    private readonly logicalId: string,
    private readonly program: string,
    private readonly args: string[],
    // The scope this spawn is bound to (a root-bound server's project root),
    // or null when root-agnostic. The backend grants a re-attach only for a
    // matching root, so a server rooted at the old project is never silently
    // reused after a switch (issue #31 / MR !20).
    private readonly root: string | null,
  ) {}

  async start(
    onMessage: (raw: string) => void,
    onExit: () => void,
    onStderr?: (line: string) => void,
  ): Promise<boolean> {
    const { serverId: physicalId, isNew } = await invoke<{
      serverId: string;
      isNew: boolean;
    }>("lsp_get_or_start", {
      logicalId: this.logicalId,
      program: this.program,
      args: this.args,
      root: this.root,
    });
    this.physicalId = physicalId;
    // Listen only after the spawn returns the physical id. The gap is safe:
    // a fresh server stays silent until it receives `initialize`, and a
    // re-attached one until its next request, so no message is missed.
    this.unlisten.push(
      await listen<string>(`lsp://message/${physicalId}`, (event) =>
        onMessage(event.payload),
      ),
    );
    this.unlisten.push(await listen(`lsp://exit/${physicalId}`, () => onExit()));
    // Forward server stderr to the client's context buffer (surfaced on an
    // unexpected exit) and mirror it to the devtools console.
    this.unlisten.push(
      await listen<string>(`lsp://stderr/${physicalId}`, (event) => {
        onStderr?.(event.payload);
        console.debug(`[${physicalId}]`, event.payload);
      }),
    );
    return isNew;
  }

  async send(message: string): Promise<void> {
    await invoke("lsp_send", { serverId: this.physicalId, message });
  }

  async stop(): Promise<void> {
    await invoke("lsp_stop", { serverId: this.physicalId });
    for (const stop of this.unlisten) stop();
    this.unlisten = [];
  }

  async markInitialized(): Promise<void> {
    await invoke("lsp_mark_initialized", { serverId: this.physicalId });
  }
}

export class LspClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly notificationHandlers = new Map<
    string,
    (params: unknown) => void
  >();
  private readonly exitHandlers: ((info: LspExitInfo) => void)[] = [];
  private alive = true;
  // Set at the start of stop(), before its first await. Two roles: a
  // single-flight latch so a racing or repeat stop() short-circuits without
  // re-sending shutdown/exit or re-reaping (the reindex.restart()-vs-switch-mount
  // race), and the deliberate-teardown flag so the exit it provokes — direct
  // onExit() below or the backend's racing exit event — is reported as expected,
  // never a crash. Separate from `alive` (which gates caller requests and marks
  // "reaped"): flipping that first would suppress stop()'s own polite shutdown.
  private stopping = false;
  // A bounded tail of the server's recent stderr, attached to an exit as the
  // failure context (issue #61).
  private readonly recentStderr: string[] = [];

  private constructor(private readonly transport: LspTransport) {}

  /**
   * Spawn (or re-attach to) `program args` behind the backend host. `root`
   * binds the spawn to a scope (a root-bound server's project root, or null
   * when root-agnostic): the backend re-attaches only for a matching root,
   * else spawns fresh. The `isNew` flag is true for a fresh spawn the caller
   * must hand-shake, false when re-attached to a server that survived a
   * webview reload AND is rooted where the caller now wants it.
   */
  static async start(
    logicalId: string,
    program: string,
    args: string[],
    root: string | null,
  ): Promise<{ client: LspClient; isNew: boolean }> {
    return LspClient.withTransport(
      new TauriTransport(logicalId, program, args, root),
    );
  }

  /** Attach over any transport — the browser test seam. */
  static async withTransport(
    transport: LspTransport,
  ): Promise<{ client: LspClient; isNew: boolean }> {
    const client = new LspClient(transport);
    const isNew = await transport.start(
      (raw) => client.onMessage(raw),
      () => client.onExit(),
      (line) => client.captureStderr(line),
    );
    return { client, isNew };
  }

  get isAlive(): boolean {
    return this.alive;
  }

  onNotification(method: string, handler: (params: unknown) => void): void {
    this.notificationHandlers.set(method, handler);
  }

  /** Runs when the server goes away — crash or teardown; `info.unexpected`
   * tells them apart. */
  onServerExit(handler: (info: LspExitInfo) => void): void {
    this.exitHandlers.push(handler);
  }

  /**
   * Tell the host the initialize handshake landed, so a re-attach after a
   * webview reload skips it (issue #31). A no-op on transports that don't
   * track backend lifecycle (the in-page browser fake).
   */
  async markInitialized(): Promise<void> {
    await this.transport.markInitialized?.();
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
    // Mark the teardown deliberate up front: the exit it provokes is expected.
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

  /** Buffer a stderr line as exit context, bounded to the recent tail. */
  private captureStderr(line: string): void {
    this.recentStderr.push(line);
    if (this.recentStderr.length > STDERR_BUFFER_LINES) this.recentStderr.shift();
  }

  private onExit(): void {
    if (!this.alive) return;
    this.alive = false;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("language server exited"));
    }
    this.pending.clear();
    const info: LspExitInfo = {
      unexpected: !this.stopping,
      stderr: [...this.recentStderr],
    };
    for (const handler of this.exitHandlers) handler(info);
  }
}
