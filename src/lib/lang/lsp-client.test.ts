// Unit: LspClient.stop() is idempotent and race-safe (issue #63). reindex()'s
// restart() and a concurrent switch-mount can both call stop() on the SAME
// shared dcs-lua client; a non-idempotent stop re-sends shutdown/exit and
// double-reaps, surfacing a transient `failed` status chip. These cover the
// three acceptance scenarios over the production stop() path via the transport
// seam — no Tauri, no DOM.

import { describe, it, expect, vi } from "vitest";

import { LspClient, type LspTransport } from "./lsp-client";

interface WireMessage {
  id?: number;
  method?: string;
  params?: unknown;
}

/** In-memory transport: records every wire send and stop, auto-answers the
 *  polite `shutdown` request so stop() resolves without the 1s timeout, and
 *  exposes `crash()` to fire a spontaneous server exit. */
class FakeTransport implements LspTransport {
  readonly sent: WireMessage[] = [];
  stopCalls = 0;
  private fireExit: (() => void) | null = null;

  async start(
    onMessage: (raw: string) => void,
    onExit: () => void,
  ): Promise<void> {
    this.fireExit = onExit;
    this.onMessage = onMessage;
  }

  async send(message: string): Promise<void> {
    const parsed = JSON.parse(message) as WireMessage;
    this.sent.push(parsed);
    // Answer the shutdown request the way a polite server would, on a
    // microtask, so request("shutdown") settles instead of timing out.
    if (parsed.method === "shutdown" && parsed.id !== undefined) {
      const id = parsed.id;
      queueMicrotask(() =>
        this.onMessage?.(JSON.stringify({ jsonrpc: "2.0", id, result: null })),
      );
    }
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }

  /** Simulate the server going away on its own (crash / host kill). */
  crash(): void {
    this.fireExit?.();
  }

  private onMessage: ((raw: string) => void) | null = null;

  sentMethods(method: string): WireMessage[] {
    return this.sent.filter((m) => m.method === method);
  }
}

describe("LspClient.stop() — second stop on an already-stopped client is a no-op", () => {
  it("returns immediately: onExit fires once, no shutdown/exit re-sent, no second transport stop", async () => {
    const transport = new FakeTransport();
    const client = await LspClient.withTransport(transport);
    const onExit = vi.fn();
    client.onServerExit(onExit);

    await client.stop();
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(transport.sentMethods("shutdown")).toHaveLength(1);
    expect(transport.sentMethods("exit")).toHaveLength(1);
    expect(transport.stopCalls).toBe(1);
    expect(client.isAlive).toBe(false);

    await client.stop();
    expect(onExit).toHaveBeenCalledTimes(1); // not fired a second time
    expect(transport.sentMethods("shutdown")).toHaveLength(1); // nothing re-sent
    expect(transport.sentMethods("exit")).toHaveLength(1);
    expect(transport.stopCalls).toBe(1); // transport reaped once
  });

  it("a stop after a spontaneous crash is a no-op — never talks to a dead server", async () => {
    const transport = new FakeTransport();
    const client = await LspClient.withTransport(transport);
    const onExit = vi.fn();
    client.onServerExit(onExit);

    transport.crash();
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(client.isAlive).toBe(false);

    await client.stop();
    expect(onExit).toHaveBeenCalledTimes(1); // crash already reaped it
    expect(transport.sentMethods("shutdown")).toHaveLength(0); // no shutdown to a dead server
    expect(transport.stopCalls).toBe(0);
  });
});

describe("LspClient.stop() — reindex racing a concurrent mount does not double-stop", () => {
  it("two concurrent stops tear the client down exactly once", async () => {
    const transport = new FakeTransport();
    const client = await LspClient.withTransport(transport);
    const onExit = vi.fn();
    client.onServerExit(onExit);

    // restart()'s stop() and mount()'s switch-stop() both reach the same live
    // client before either nulls it — fire both without awaiting between.
    await Promise.all([client.stop(), client.stop()]);

    expect(onExit).toHaveBeenCalledTimes(1); // one teardown → one `failed` at most
    expect(transport.sentMethods("shutdown")).toHaveLength(1); // not double-sent
    expect(transport.sentMethods("exit")).toHaveLength(1);
    expect(transport.stopCalls).toBe(1);
    expect(client.isAlive).toBe(false);
  });
});

describe("LspClient.stop() — normal single stop is unchanged", () => {
  it("runs the polite shutdown → exit → transport.stop → onExit in order", async () => {
    const transport = new FakeTransport();
    const client = await LspClient.withTransport(transport);
    const order: string[] = [];
    client.onServerExit(() => order.push("onExit"));
    const realStop = transport.stop.bind(transport);
    vi.spyOn(transport, "stop").mockImplementation(async () => {
      order.push("transport.stop");
      await realStop();
    });

    await client.stop();

    // The polite handshake: a `shutdown` request (carries an id) precedes the
    // `exit` notification (no id), then the transport is reaped, then onExit.
    const shutdown = transport.sent[0];
    const exit = transport.sent[1];
    expect(shutdown.method).toBe("shutdown");
    expect(shutdown.id).toBeTypeOf("number");
    expect(exit.method).toBe("exit");
    expect(exit.id).toBeUndefined();
    expect(order).toEqual(["transport.stop", "onExit"]);
  });
});
