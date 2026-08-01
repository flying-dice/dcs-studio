import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// BridgeClient imports `vscode` only for Disposable; stub just that.
vi.mock("vscode", () => ({
  Disposable: class {
    constructor(private readonly fn: () => void) {}
    dispose(): void {
      this.fn();
    }
  },
}));

import { BridgeClient, type BridgeStatus } from "../../../src/bridge/client";
import type {
  BridgeConnection,
  BridgeEndpoint,
  BridgeHandlers,
  BridgeTransportPort,
} from "../../../src/core/ports/bridgeTransport";

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

/** A promise's outcome as a string, so a test can look at it without awaiting. */
function outcomeOf(p: Promise<unknown>): Promise<string> {
  return p.then(
    () => "resolved",
    (e: Error) => e.message,
  );
}

/** The outcome so far — "pending" while the promise has not settled. */
function peek(outcome: Promise<string>): Promise<string> {
  return Promise.race([outcome, Promise.resolve("pending")]);
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
    transport.last.handlers.onMessage?.(
      JSON.stringify({ id: ping.id, result: { dcs_time: 42.5 } }),
    );
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

  // The end of the taxonomy's wire: the code the server chose has to survive
  // all the way into what the caller catches, or the callers deciding whether
  // to offer a bug report have nothing to decide on.
  it("rejects with the server's error code attached, not a bare Error", async () => {
    open();
    const p = client.call("debug_state", {});
    const req = lastSent(transport);
    transport.last.handlers.onMessage?.(
      JSON.stringify({ id: req.id, error: { code: -32001, message: "bridge torn down" } }),
    );
    await expect(p).rejects.toMatchObject({
      name: "BridgeRpcError",
      message: "bridge torn down",
      code: -32001,
    });
  });

  it("rejects with no code when the server sent none", async () => {
    open();
    const p = client.call("eval", {});
    const req = lastSent(transport);
    transport.last.handlers.onMessage?.(
      JSON.stringify({ id: req.id, error: { message: "LuaError", data: "boom" } }),
    );
    await expect(p).rejects.toMatchObject({ message: "boom", code: undefined });
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

  it("survives a listener that throws, and still serves the ones after it", () => {
    // Status is emitted from the socket's own close/data handlers — a Node
    // emitter with no error handler on the path — so an unguarded throw here
    // is an uncaught exception in the extension host, not a broken panel.
    const seen: BridgeStatus[] = [];
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    // Subscribing is itself a delivery — onStatus replays the current status —
    // so this must not throw out of the constructor of whatever is subscribing.
    expect(() =>
      client.onStatus(() => {
        throw new Error("panel disposed mid-update");
      }),
    ).not.toThrow();
    client.onStatus((s) => seen.push(s));

    expect(() => open()).not.toThrow();
    // The second listener saw the connect it would otherwise have been starved
    // of by the first one throwing.
    expect(seen.at(-1)?.connected).toBe(true);
    expect(errors).toHaveBeenCalledWith(
      "bridge: bridge status listener threw",
      expect.objectContaining({ message: "panel disposed mid-update" }),
    );
    errors.mockRestore();
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
    expect(req).toMatchObject({
      method: "repl_eval",
      params: { env: "mission", code: "return 1" },
    });
    transport.last.handlers.onMessage?.(
      JSON.stringify({ id: req.id, result: { ok: true, result: 1 } }),
    );
    await expect(p).resolves.toEqual({ ok: true, result: 1 });
    expect(transport.last.sent.filter((s) => s.includes("repl_poll")).length).toBe(0);
  });

  it("replSignature calls repl_signature with the env+ref and resolves the params", async () => {
    open();
    const p = client.replSignature("gui", 7);
    const req = lastSent(transport);
    expect(req).toMatchObject({ method: "repl_signature", params: { env: "gui", ref: 7 } });
    transport.last.handlers.onMessage?.(
      JSON.stringify({ id: req.id, result: { ok: true, params: "text, displayTime, clearView" } }),
    );
    await expect(p).resolves.toEqual({ ok: true, params: "text, displayTime, clearView" });
  });

  it("replSignature answers synchronously for the mission env (no repl_poll machinery)", async () => {
    open();
    const p = client.replSignature("mission", 3);
    const req = lastSent(transport);
    expect(req).toMatchObject({ method: "repl_signature", params: { env: "mission", ref: 3 } });
    transport.last.handlers.onMessage?.(
      JSON.stringify({ id: req.id, result: { ok: true, params: "", native: true } }),
    );
    await expect(p).resolves.toEqual({ ok: true, params: "", native: true });
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

  it("starts disconnected and refuses calls until a socket is up", async () => {
    // Was "falls back to the real WebSocket transport when none is injected",
    // guarding a `transport ?? new WsBridgeTransport()` default on the strength
    // of a comment saying clients.ts constructed both bridges without one. It
    // did not — the extension passes a transport to both, and clients.ts takes
    // them injected — so the arm shipped nowhere and named a concrete adapter
    // from a feature (#61). The transport is required now; what is left worth
    // asserting is the pre-connection state itself.
    const fresh = new BridgeClient("127.0.0.1", 25569, new FakeTransport());
    expect(fresh.current).toEqual({ connected: false, dcsTime: null });
    await expect(fresh.call("ping")).rejects.toThrow("bridge not connected");
    expect(() => fresh.dispose()).not.toThrow();
  });

  it("reconnect() does nothing while the bridge is already connected", async () => {
    // The command is wired to "Launch DCS" and the console's retry button, both
    // of which a user can press while the bridge is up. Dropping a healthy
    // socket to open a second one would fail every call in flight.
    open();
    client.reconnect();
    expect(transport.connections.length).toBe(1);
    await vi.advanceTimersByTimeAsync(20000);
    expect(transport.connections.length).toBe(1);
    expect(client.current.connected).toBe(true);
  });

  it("does not stack reconnect timers when a socket reports error and close together", async () => {
    // A refused connection emits both: `ws` fires error then close for the same
    // socket. Scheduling twice would halve the backoff and, over a long DCS
    // startup, turn the retry loop into a connect storm.
    open();
    transport.last.handlers.onError?.(new Error("ECONNREFUSED"));
    transport.last.handlers.onClose?.(1006, "");
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.connections.length).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.connections.length).toBe(2); // one retry, not two
  });

  it("dispose cancels a reconnect already scheduled", async () => {
    // Deactivating the extension while DCS is down leaves a pending retry; if it
    // survived, it would open a socket nobody owns after the host tore down.
    open();
    transport.last.handlers.onClose?.(1006, "");
    client.dispose();
    await vi.advanceTimersByTimeAsync(60000);
    expect(transport.connections.length).toBe(1);
  });

  it("a close arriving after dispose does not schedule a reconnect", async () => {
    // Closing a socket is asynchronous: the transport's close callback lands
    // after dispose() returned, and must not resurrect the retry loop.
    open();
    const stale = transport.last.handlers;
    client.dispose();
    stale.onClose?.(1000, "normal");
    await vi.advanceTimersByTimeAsync(60000);
    expect(transport.connections.length).toBe(1);
  });

  it("reconnect() after dispose does not resurrect the client", async () => {
    open();
    client.dispose();
    client.reconnect();
    expect(transport.connections.length).toBe(1);
    await vi.advanceTimersByTimeAsync(60000);
    expect(transport.connections.length).toBe(1);
  });

  // ── the typed call surface ──
  //
  // Every panel reaches the bridge through these wrappers, and the method names
  // and param keys are a contract with the Rust router's serde structs: a
  // renamed key does not fail to compile, it fails at runtime against a running
  // DCS, which no headless test would otherwise catch. So each one is pinned to
  // the exact frame it puts on the wire.
  describe("typed wrappers", () => {
    const wrappers: {
      what: string;
      invoke: (c: BridgeClient) => Promise<unknown>;
      method: string;
      params: unknown;
      result: unknown;
    }[] = [
      {
        what: "eval sends the Lua chunk",
        invoke: (c) => c.eval("return 1 + 1"),
        method: "eval",
        params: { code: "return 1 + 1" },
        result: 2,
      },
      {
        what: "consoleRead asks for lines after a sequence number",
        invoke: (c) => c.consoleRead(12),
        method: "console_read",
        params: { after: 12 },
        result: { lines: [{ seq: 13, text: "hello" }], latest: 13 },
      },
      {
        what: "replInspect carries the env and the expression",
        invoke: (c) => c.replInspect("gui", "_G.db"),
        method: "repl_inspect",
        params: { env: "gui", expr: "_G.db" },
        result: { ok: true, value: { type: "table", ref: 4 } },
      },
      {
        what: "replExpand drills into a ref within its env",
        invoke: (c) => c.replExpand("mission", 4),
        method: "repl_expand",
        params: { env: "mission", ref: 4 },
        result: { variables: [{ name: "id", type: "number", value: "1" }] },
      },
      {
        what: "replClear releases every ref held in one env",
        invoke: (c) => c.replClear("server"),
        method: "repl_clear",
        params: { env: "server" },
        result: { ok: true },
      },
      {
        what: "dbCategories takes no parameters",
        invoke: (c) => c.dbCategories(),
        method: "db_categories",
        params: {},
        result: { categories: [{ name: "Planes", entry_key: "Planes", count: 120 }] },
      },
      {
        what: "dbUnitTypes forwards the category and filter",
        invoke: (c) => c.dbUnitTypes({ category: "Planes", filter: "f-16" }),
        method: "db_unit_types",
        params: { category: "Planes", filter: "f-16" },
        result: { units: [{ type: "F-16C_50", category: "Planes" }], truncated: false },
      },
      {
        what: "dbUnitTypes with no options asks for everything",
        invoke: (c) => c.dbUnitTypes(),
        method: "db_unit_types",
        params: {},
        result: { units: [], truncated: false },
      },
      {
        what: "dbUnit asks for the curated record by default",
        invoke: (c) => c.dbUnit("F-16C_50"),
        method: "db_unit",
        params: { type: "F-16C_50", raw: false },
        result: { unit: { type: "F-16C_50" }, category: "Planes" },
      },
      {
        what: "dbUnit can ask for the raw record instead",
        invoke: (c) => c.dbUnit("F-16C_50", true),
        method: "db_unit",
        params: { type: "F-16C_50", raw: true },
        result: { unit: {}, raw: true },
      },
      {
        what: "dbWeapons without a filter sends no filter key",
        invoke: (c) => c.dbWeapons(),
        method: "db_weapons",
        params: {},
        result: { weapons: [], truncated: false },
      },
      {
        what: "dbWeapons forwards a filter when there is one",
        invoke: (c) => c.dbWeapons("aim-120"),
        method: "db_weapons",
        params: { filter: "aim-120" },
        result: { weapons: [{ clsid: "{AIM-120C}" }], truncated: false },
      },
      {
        what: "dbExport dumps everything by default",
        invoke: (c) => c.dbExport(),
        method: "db_export",
        params: { what: "all" },
        result: { path: "D:\\Saved Games\\DCS\\db.json", bytes: 4096 },
      },
      {
        what: "dbExport can scope the dump to one category",
        invoke: (c) => c.dbExport("category:Planes"),
        method: "db_export",
        params: { what: "category:Planes" },
        result: { path: "D:\\Saved Games\\DCS\\db.json", bytes: 512 },
      },
      {
        what: "debugRun snake-cases pause_on_error for the Rust router",
        invoke: (c) => c.debugRun("mission", "=C:\\mod\\a.lua", "print(1)", true),
        method: "debug_run",
        params: {
          env: "mission",
          source: "=C:\\mod\\a.lua",
          code: "print(1)",
          pause_on_error: true,
        },
        result: { ran: true, error: null },
      },
      {
        what: "debugState polls with no parameters",
        invoke: (c) => c.debugState(),
        method: "debug_state",
        params: {},
        result: { state: "paused", frames: [] },
      },
      {
        what: "debugContinue carries the step mode",
        invoke: (c) => c.debugContinue("step_over"),
        method: "debug_continue",
        params: { mode: "step_over" },
        result: { ok: true },
      },
      {
        what: "debugPause is a break-all with no parameters",
        invoke: (c) => c.debugPause(),
        method: "debug_pause",
        params: {},
        result: { ok: true },
      },
      {
        what: "debugStop terminates the running chunk",
        invoke: (c) => c.debugStop(),
        method: "debug_stop",
        params: {},
        result: { ok: true },
      },
      {
        what: "debugExpand drills into a snapshot ref",
        invoke: (c) => c.debugExpand(9),
        method: "debug_expand",
        params: { ref: 9 },
        result: { variables: [{ name: "n", type: "number", value: "3" }] },
      },
      {
        what: "debugEval targets a 0-based frame",
        invoke: (c) => c.debugEval(0, "unit.name"),
        method: "debug_eval",
        params: { frame: 0, expr: "unit.name" },
        result: { type: "string", value: "Ford" },
      },
      {
        what: "debugClearBreakpoints takes no parameters",
        invoke: (c) => c.debugClearBreakpoints(),
        method: "debug_clear_breakpoints",
        params: {},
        result: { ok: true },
      },
    ];

    it.each(wrappers)("$what", async ({ invoke, method, params, result }) => {
      open();
      const p = invoke(client);
      const req = lastSent(transport);
      expect(req.method).toBe(method);
      expect(req.params).toEqual(params);
      transport.last.handlers.onMessage?.(JSON.stringify({ id: req.id, result }));
      await expect(p).resolves.toEqual(result);
    });

    it("replExport by ref sends no expr key, and by expr sends no ref key", async () => {
      // The bridge's serde treats the two as alternatives; sending both (or a
      // null for the unused one) is rejected before the export ever starts.
      open();
      const byRef = client.replExport("gui", { ref: 4 });
      const refReq = lastSent(transport);
      expect(refReq.method).toBe("repl_export");
      expect(refReq.params).toEqual({ env: "gui", ref: 4 });
      expect("expr" in (refReq.params as Record<string, unknown>)).toBe(false);
      transport.last.handlers.onMessage?.(
        JSON.stringify({ id: refReq.id, result: { path: "D:\\dump.json", bytes: 10 } }),
      );
      await expect(byRef).resolves.toEqual({ path: "D:\\dump.json", bytes: 10 });

      const byExpr = client.replExport("gui", { expr: "db.Units" });
      const exprReq = lastSent(transport);
      expect(exprReq.params).toEqual({ env: "gui", expr: "db.Units" });
      expect("ref" in (exprReq.params as Record<string, unknown>)).toBe(false);
      transport.last.handlers.onMessage?.(
        JSON.stringify({ id: exprReq.id, result: { path: "D:\\dump.json", bytes: 20 } }),
      );
      await expect(byExpr).resolves.toEqual({ path: "D:\\dump.json", bytes: 20 });
    });

    it("eval gives the sim 15s by default", async () => {
      open();
      const outcome = outcomeOf(client.eval("return 1"));
      await vi.advanceTimersByTimeAsync(14_999);
      expect(await peek(outcome)).toBe("pending");
      await vi.advanceTimersByTimeAsync(1);
      expect(await outcome).toBe("bridge call 'eval' timed out");
    });

    it("debugRun waits out a whole session, not the default call timeout", async () => {
      // debug_run blocks bridge-side for as long as the user keeps the session
      // paused. At the 15s default the client would abandon the call — and the
      // debug adapter would report a dead session — while DCS is still stopped
      // on a breakpoint the user is reading.
      open();
      const outcome = outcomeOf(client.debugRun("mission", "=a.lua", "print(1)", false));
      await vi.advanceTimersByTimeAsync(599_999);
      expect(await peek(outcome)).toBe("pending");
      await vi.advanceTimersByTimeAsync(1);
      expect(await outcome).toBe("bridge call 'debug_run' timed out");
    });
  });
});
