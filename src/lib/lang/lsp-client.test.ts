// Unit coverage for LspClient's lifecycle over the `withTransport` seam — no
// Tauri, no DOM. Two concerns share one in-memory transport:
//   - stop() is idempotent and race-safe (issue #63): reindex()'s restart() and
//     a concurrent switch-mount can both call stop() on the SAME shared dcs-lua
//     client; a non-idempotent stop re-sends shutdown/exit and double-reaps,
//     surfacing a transient `failed` status chip.
//   - the crash-vs-stop exit gate (issue #61): a spontaneous exit is a crash
//     (unexpected), a post-stop() exit is deliberate, and the recent stderr tail
//     rides the exit as failure context.

import { describe, it, expect, vi } from "vitest";

import {
  LspClient,
  STDERR_BUFFER_LINES,
  type LspTransport,
  type LspExitInfo,
} from "./lsp-client";

interface WireMessage {
  id?: number;
  method?: string;
  params?: unknown;
}

/** In-memory transport and the `withTransport` test seam the real
 *  `TauriTransport` exists to be swapped out at. Records every wire send,
 *  auto-answers any JSON-RPC request (so stop()'s shutdown handshake settles
 *  instead of waiting out the 1s timeout), counts reaps, and hands its exit /
 *  stderr callbacks back to the test to drive a server exit or stderr by hand. */
class FakeTransport implements LspTransport {
  readonly sent: WireMessage[] = [];
  stopCalls = 0;
  onMessage!: (raw: string) => void;
  onExit!: () => void;
  onStderr?: (line: string) => void;

  async start(
    onMessage: (raw: string) => void,
    onExit: () => void,
    onStderr?: (line: string) => void,
  ): Promise<boolean> {
    this.onMessage = onMessage;
    this.onExit = onExit;
    this.onStderr = onStderr;
    return true; // a fresh spawn; these lifecycle tests don't exercise re-attach
  }

  async send(message: string): Promise<void> {
    const parsed = JSON.parse(message) as WireMessage;
    this.sent.push(parsed);
    // Answer any JSON-RPC request (id + method) the way a polite server would,
    // on a microtask, so request("shutdown") settles instead of timing out.
    if (parsed.id !== undefined && parsed.method !== undefined) {
      const id = parsed.id;
      queueMicrotask(() =>
        this.onMessage(JSON.stringify({ jsonrpc: "2.0", id, result: null })),
      );
    }
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }

  /** Simulate the server going away on its own (crash / host kill). */
  crash(): void {
    this.onExit();
  }

  sentMethods(method: string): WireMessage[] {
    return this.sent.filter((m) => m.method === method);
  }
}

async function attach(): Promise<{
  client: LspClient;
  transport: FakeTransport;
  exits: LspExitInfo[];
}> {
  const transport = new FakeTransport();
  const { client } = await LspClient.withTransport(transport);
  const exits: LspExitInfo[] = [];
  client.onServerExit((info) => exits.push(info));
  return { client, transport, exits };
}

describe("LspClient crash-vs-stop exit gate", () => {
  it("flags an exit with no preceding stop() as unexpected (a crash)", async () => {
    const { client, transport, exits } = await attach();

    transport.onExit(); // backend lsp://exit, no deliberate stop first

    expect(exits).toHaveLength(1);
    expect(exits[0].unexpected).toBe(true);
    expect(client.isAlive).toBe(false);
  });

  it("flags an exit after stop() as expected, exactly once under the post-stop event race", async () => {
    const { client, transport, exits } = await attach();

    await client.stop(); // deliberate teardown → stopping=true → onExit()
    transport.onExit(); // backend exit event races in afterwards

    expect(exits).toHaveLength(1); // the !alive guard swallows the second
    expect(exits[0].unexpected).toBe(false);
  });

  it("attaches a bounded tail of the most recent stderr to the exit info", async () => {
    const { transport, exits } = await attach();

    const total = STDERR_BUFFER_LINES + 20; // overflow the ring
    for (let i = 0; i < total; i++) transport.onStderr!(`line ${i}`);
    transport.onExit();

    const { stderr } = exits[0];
    expect(stderr).toHaveLength(STDERR_BUFFER_LINES); // older lines dropped
    expect(stderr.at(0)).toBe(`line ${total - STDERR_BUFFER_LINES}`);
    expect(stderr.at(-1)).toBe(`line ${total - 1}`); // newest kept
  });
});

describe("LspClient.stop() — second stop on an already-stopped client is a no-op", () => {
  it("returns immediately: onExit fires once, no shutdown/exit re-sent, no second transport stop", async () => {
    const transport = new FakeTransport();
    const { client } = await LspClient.withTransport(transport);
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
    const { client } = await LspClient.withTransport(transport);
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
    const { client } = await LspClient.withTransport(transport);
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
    const { client } = await LspClient.withTransport(transport);
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
