import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// BridgeClient imports `vscode` only for Disposable; stub just that.
vi.mock("vscode", () => ({
  Disposable: class {
    constructor(private readonly fn: () => void) {}
    dispose(): void {
      this.fn();
    }
  },
}));

import { BridgeClient, BridgeStatus } from "../../src/bridge/client";
import {
  BridgeConnection,
  BridgeEndpoint,
  BridgeHandlers,
  BridgeTransportPort,
} from "../../src/core/ports/bridgeTransport";

/** A scripted in-memory transport: exposes each connection's handlers so tests
 * can play the server side. */
class FakeTransport implements BridgeTransportPort {
  readonly connections: {
    endpoint: BridgeEndpoint;
    handlers: BridgeHandlers;
    sent: string[];
    closed: boolean;
  }[] = [];

  connect(endpoint: BridgeEndpoint, handlers: BridgeHandlers): BridgeConnection {
    const conn = { endpoint, handlers, sent: [] as string[], closed: false };
    this.connections.push(conn);
    return {
      send: (text: string) => conn.sent.push(text),
      close: () => {
        conn.closed = true;
      },
    };
  }

  get last() {
    return this.connections[this.connections.length - 1];
  }
}

function lastSent(t: FakeTransport): { method: string; id: string; params?: unknown } {
  return JSON.parse(t.last.sent[t.last.sent.length - 1]);
}

describe("BridgeClient over a scripted transport", () => {
  let transport: FakeTransport;
  let client: BridgeClient;

  beforeEach(() => {
    vi.useFakeTimers();
    transport = new FakeTransport();
    client = new BridgeClient("127.0.0.1", 25569, transport);
  });

  afterEach(() => {
    client.dispose();
    vi.useRealTimers();
  });

  function open(): void {
    client.start();
    transport.last.handlers.onOpen?.();
  }

  it("connects to /ws on the configured endpoint", () => {
    client.start();
    expect(transport.last.endpoint).toEqual({ host: "127.0.0.1", port: 25569, path: "/ws" });
    // start() is idempotent while a connection exists
    client.start();
    expect(transport.connections.length).toBe(1);
  });

  it("emits connected on open and pings immediately", () => {
    const seen: BridgeStatus[] = [];
    client.onStatus((s) => seen.push(s));
    expect(seen[0]).toEqual({ connected: false, dcsTime: null }); // immediate replay
    open();
    expect(seen.some((s) => s.connected)).toBe(true);
    const ping = lastSent(transport);
    expect(ping.method).toBe("ping");
    expect(typeof ping.id).toBe("string");
    expect("params" in ping).toBe(false);
  });

  it("derives dcsTime from the ping result", async () => {
    open();
    const ping = lastSent(transport);
    transport.last.handlers.onMessage?.(JSON.stringify({ id: ping.id, result: { dcs_time: 42.5 } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(client.current).toEqual({ connected: true, dcsTime: 42.5 });
  });

  it("keeps pinging on the 2s cadence", async () => {
    open();
    const before = transport.last.sent.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(transport.last.sent.length).toBe(before + 1);
    expect(lastSent(transport).method).toBe("ping");
  });

  it("rejects calls while not connected", async () => {
    await expect(client.call("eval", { code: "1" })).rejects.toThrow("bridge not connected");
  });

  it("correlates responses by string id", async () => {
    open();
    const p = client.call("eval", { code: "return 1" });
    const req = lastSent(transport);
    expect(req).toMatchObject({ method: "eval", params: { code: "return 1" } });
    transport.last.handlers.onMessage?.(JSON.stringify({ id: req.id, result: 1 }));
    await expect(p).resolves.toBe(1);
  });

  it("correlates a numeric server id against the string request id", async () => {
    open();
    const p = client.call("eval", {});
    const req = lastSent(transport);
    transport.last.handlers.onMessage?.(JSON.stringify({ id: Number(req.id), result: "ok" }));
    await expect(p).resolves.toBe("ok");
  });

  it("ignores unknown ids and garbage without disturbing pending calls", async () => {
    open();
    const p = client.call("eval", {});
    const req = lastSent(transport);
    transport.last.handlers.onMessage?.("not json");
    transport.last.handlers.onMessage?.(JSON.stringify({ id: "999", result: "stray" }));
    transport.last.handlers.onMessage?.(JSON.stringify({ result: "no id" }));
    transport.last.handlers.onMessage?.(JSON.stringify({ id: req.id, result: "real" }));
    await expect(p).resolves.toBe("real");
  });

  it("surfaces the Lua error carried in error.data", async () => {
    open();
    const p = client.call("eval", {});
    const req = lastSent(transport);
    transport.last.handlers.onMessage?.(
      JSON.stringify({ id: req.id, error: { message: "LuaError", data: "boom at line 3" } }),
    );
    await expect(p).rejects.toThrow("boom at line 3");
  });

  it("times out calls with the method name", async () => {
    open();
    const p = client.call("slow_thing", {}, 5000);
    p.catch(() => undefined); // avoid unhandled rejection between ticks
    await vi.advanceTimersByTimeAsync(5000);
    await expect(p).rejects.toThrow("bridge call 'slow_thing' timed out");
  });

  it("on close: fails pending calls, goes offline, reconnects after 1000ms then 1600ms", async () => {
    open();
    const p = client.call("eval", {});
    transport.last.handlers.onClose?.(1006, "socket closed");
    await expect(p).rejects.toThrow("bridge disconnected");
    expect(client.current).toEqual({ connected: false, dcsTime: null });

    expect(transport.connections.length).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(transport.connections.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.connections.length).toBe(2); // first retry at 1000ms

    transport.last.handlers.onError?.(new Error("refused"));
    await vi.advanceTimersByTimeAsync(1599);
    expect(transport.connections.length).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.connections.length).toBe(3); // second retry at 1600ms

    transport.last.handlers.onError?.(new Error("refused"));
    await vi.advanceTimersByTimeAsync(2560);
    expect(transport.connections.length).toBe(4); // third retry at 2560ms
  });

  it("a successful open resets the backoff", async () => {
    open();
    transport.last.handlers.onClose?.(1006, "");
    await vi.advanceTimersByTimeAsync(1000);
    transport.last.handlers.onOpen?.(); // reconnected
    transport.last.handlers.onClose?.(1006, "");
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.connections.length).toBe(3); // back to the initial 1000ms delay
  });

  it("reconnect() cancels the pending timer and retries immediately", async () => {
    open();
    transport.last.handlers.onClose?.(1006, "");
    client.reconnect();
    expect(transport.connections.length).toBe(2);
    // the cancelled timer must not fire a third connection
    await vi.advanceTimersByTimeAsync(20000);
    expect(transport.connections.length).toBe(2);
  });

  it("onStatus disposables unsubscribe", () => {
    const seen: BridgeStatus[] = [];
    const d = client.onStatus((s) => seen.push(s));
    d.dispose();
    open();
    expect(seen.length).toBe(1); // only the immediate replay
  });

  it("dispose closes the connection, fails pending calls and stops reconnecting", async () => {
    open();
    const p = client.call("eval", {});
    client.dispose();
    await expect(p).rejects.toThrow("disposed");
    expect(transport.last.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(60000);
    expect(transport.connections.length).toBe(1);
    client.start(); // no-op after dispose
    expect(transport.connections.length).toBe(1);
  });

  it("typed wrappers ride call(): debugSetBreakpoints omits absent conditions", async () => {
    open();
    const p = client.debugSetBreakpoints("=C:\\x.lua", [{ line: 3 }]);
    const req = lastSent(transport);
    expect(req).toMatchObject({
      method: "debug_set_breakpoints",
      params: { source: "=C:\\x.lua", breakpoints: [{ line: 3 }] },
    });
    transport.last.handlers.onMessage?.(JSON.stringify({ id: req.id, result: { count: 1 } }));
    await expect(p).resolves.toEqual({ count: 1 });
  });

  it("a lone ping timeout is swallowed (no status change, no crash)", async () => {
    open();
    // never answer the initial ping; let its 4s timeout fire
    await vi.advanceTimersByTimeAsync(4000);
    expect(client.current.connected).toBe(true);
  });

  it("replEval answers synchronously for every env (no repl_poll machinery)", async () => {
    open();
    const p = client.replEval("mission", "return 1");
    const req = lastSent(transport);
    expect(req).toMatchObject({ method: "repl_eval", params: { env: "mission", code: "return 1" } });
    transport.last.handlers.onMessage?.(
      JSON.stringify({ id: req.id, result: { ok: true, result: 1 } }),
    );
    await expect(p).resolves.toEqual({ ok: true, result: 1 });
    expect(transport.last.sent.filter((s) => s.includes("repl_poll")).length).toBe(0);
  });

  it("names the bridge via its label in error messages", async () => {
    const t2 = new FakeTransport();
    const mission = new BridgeClient("127.0.0.1", 25570, t2, "Mission bridge");
    await expect(mission.call("ping")).rejects.toThrow("Mission bridge not connected");
    mission.start();
    t2.last.handlers.onOpen?.();
    const p = mission.call("slow", {}, 5000);
    p.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(p).rejects.toThrow("Mission bridge call 'slow' timed out");
    mission.dispose();
  });
});
