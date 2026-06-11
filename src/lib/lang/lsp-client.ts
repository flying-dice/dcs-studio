// JSON-RPC client for a backend-hosted language server (decisions/005).
//
// The Rust side (`crates/app/src/lsp.rs`) is a dumb framed byte pump;
// this class owns the protocol: request ids, response correlation,
// notification dispatch, lifecycle. One instance per server.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class LspClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly notificationHandlers = new Map<
    string,
    (params: unknown) => void
  >();
  private unlisten: UnlistenFn[] = [];
  private alive = true;

  private constructor(private readonly serverId: string) {}

  /** Spawn `program args` behind the backend host and attach. */
  static async start(
    serverId: string,
    program: string,
    args: string[],
  ): Promise<LspClient> {
    const client = new LspClient(serverId);
    client.unlisten.push(
      await listen<string>(`lsp://message/${serverId}`, (event) =>
        client.onMessage(event.payload),
      ),
    );
    client.unlisten.push(
      await listen(`lsp://exit/${serverId}`, () => client.onExit()),
    );
    await invoke("lsp_start", { serverId, program, args });
    return client;
  }

  onNotification(method: string, handler: (params: unknown) => void): void {
    this.notificationHandlers.set(method, handler);
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (!this.alive) throw new Error(`language server '${this.serverId}' exited`);
    const id = this.nextId++;
    const settled = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    await this.send({ jsonrpc: "2.0", id, method, params });
    return settled;
  }

  async notify(method: string, params: unknown): Promise<void> {
    if (!this.alive) return;
    await this.send({ jsonrpc: "2.0", method, params });
  }

  /** Polite LSP teardown, then reap the process. */
  async stop(): Promise<void> {
    try {
      await Promise.race([
        this.request("shutdown", null),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
      await this.notify("exit", null);
    } catch {
      /* the host's kill path covers an impolite server */
    }
    await invoke("lsp_stop", { serverId: this.serverId });
    this.onExit();
  }

  private async send(message: unknown): Promise<void> {
    await invoke("lsp_send", {
      serverId: this.serverId,
      message: JSON.stringify(message),
    });
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
      if (message.error) {
        pending.reject(new Error(message.error.message ?? "lsp error"));
      } else {
        pending.resolve(message.result ?? null);
      }
      return;
    }
    if (message.method) {
      // Server-to-client requests are unsupported; notifications dispatch.
      this.notificationHandlers.get(message.method)?.(message.params);
    }
  }

  private onExit(): void {
    this.alive = false;
    for (const [, pending] of this.pending) {
      pending.reject(new Error(`language server '${this.serverId}' exited`));
    }
    this.pending.clear();
    for (const stop of this.unlisten) stop();
    this.unlisten = [];
  }
}
