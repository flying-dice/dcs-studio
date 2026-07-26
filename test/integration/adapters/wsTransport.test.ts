import { EventEmitter } from "node:events";
import * as net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  MiniWebSocket,
  WsBridgeTransport,
  type WsSocket,
  type WsSocketFactory,
} from "../../../src/adapters/node/wsTransport";
import { readFrame } from "../../../src/core/domain/wsFraming";

// The transport is the only thing between the Lua console / debugger and the
// bridge running inside DCS. Its job is to survive a connection that is not
// cooperating: DCS is being started or stopped underneath it, a mission ends
// and the mission bridge disappears mid-frame, the port is answered by
// something that is not the bridge at all. Every one of those has to arrive at
// the caller as an onClose or an onError, because a throw escaping a socket
// callback here is an unhandled rejection in the extension host, not a
// disconnected console.
//
// The byte codec is pure and unit-tested (core/domain/wsFraming); what is
// tested here is the conversation: the handshake, control frames, fragment
// reassembly, and which failure becomes which callback. Most cases drive a
// scripted socket, because "the socket throws while we are already failing"
// cannot be asked of a real one — and the last case runs the whole thing over
// real TCP so the default wiring is proven too.

/** A socket whose every failure mode is on demand. Satisfies `WsSocket`. */
class FakeSocket {
  readonly written: Buffer[] = [];
  ends = 0;
  destroys = 0;
  writeFault: unknown = null;
  endFault: Error | null = null;
  destroyFault: Error | null = null;
  private readonly events = new EventEmitter();

  on(event: string, listener: (...args: any[]) => void): this {
    this.events.on(event, listener);
    return this;
  }

  write(data: string | Uint8Array): boolean {
    if (this.writeFault) throw this.writeFault;
    this.written.push(Buffer.from(data as Uint8Array));
    return true;
  }

  end(): void {
    if (this.endFault) throw this.endFault;
    this.ends++;
  }

  destroy(): void {
    if (this.destroyFault) throw this.destroyFault;
    this.destroys++;
  }

  /** Peer → client bytes. */
  deliver(chunk: Buffer | string): void {
    this.events.emit("data", Buffer.from(chunk as string));
  }

  raise(err: Error): void {
    this.events.emit("error", err);
  }

  hangUp(): void {
    this.events.emit("close");
  }
}

interface Recorded {
  opens: number;
  messages: string[];
  closes: { code: number; reason: string }[];
  errors: string[];
}

const HANDSHAKE_OK = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n";

/** An unmasked server→client frame; `fin` false makes it a fragment. */
function serverFrame(opcode: number, payload: Buffer | string = "", fin = true): Buffer {
  const body = Buffer.from(payload as string);
  return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode, body.length]), body]);
}

/** Decode a frame the client wrote (client frames are masked). */
function clientFrame(raw: Buffer) {
  const f = readFrame(raw);
  if (!f) throw new Error("incomplete client frame");
  return { opcode: f.opcode, payload: Buffer.from(f.payload) };
}

/** A MiniWebSocket on a scripted socket, plus everything it reported. */
function scripted(handlers: "all" | "none" = "all") {
  const socket = new FakeSocket();
  const seen: Recorded = { opens: 0, messages: [], closes: [], errors: [] };
  let onConnect = (): void => {};
  const factory: WsSocketFactory = (_endpoint, cb) => {
    onConnect = cb;
    return socket as WsSocket;
  };
  const ws = new MiniWebSocket(
    "127.0.0.1",
    25569,
    "/rpc",
    handlers === "none"
      ? {}
      : {
          onOpen: () => {
            seen.opens++;
          },
          onMessage: (t) => seen.messages.push(t),
          onClose: (code, reason) => seen.closes.push({ code, reason }),
          onError: (e) => seen.errors.push(e.message),
        },
    factory,
  );
  return {
    ws,
    socket,
    seen,
    /** Complete the TCP connect, which is when the handshake is sent. */
    tcpConnect: () => onConnect(),
    /** Connect and accept the upgrade, leaving the socket open and ready. */
    open() {
      onConnect();
      socket.deliver(HANDSHAKE_OK);
      socket.written.length = 0;
      return this;
    },
  };
}

describe("handshake", () => {
  it("sends an RFC 6455 upgrade request naming the bridge path", () => {
    const t = scripted();
    t.tcpConnect();
    const req = t.socket.written[0].toString();

    expect(req.startsWith("GET /rpc HTTP/1.1\r\n")).toBe(true);
    expect(req).toContain("Host: 127.0.0.1:25569\r\n");
    expect(req).toContain("Upgrade: websocket\r\n");
    expect(req).toContain("Sec-WebSocket-Version: 13\r\n");
    // A fresh 16-byte random key per connection, as the RFC requires.
    const key = /Sec-WebSocket-Key: (.+)\r\n/.exec(req)?.[1] ?? "";
    expect(Buffer.from(key, "base64")).toHaveLength(16);
  });

  it("opens only once the upgrade is accepted", () => {
    const t = scripted();
    t.tcpConnect();
    expect(t.seen.opens).toBe(0);
    t.socket.deliver(HANDSHAKE_OK);
    expect(t.seen.opens).toBe(1);
  });

  it("waits for the full response headers before deciding", () => {
    // TCP splits wherever it likes; deciding on a partial status line would
    // reject a perfectly good bridge at random.
    const t = scripted();
    t.tcpConnect();
    t.socket.deliver("HTTP/1.1 101 Switching Prot");
    expect(t.seen.opens).toBe(0);
    expect(t.seen.errors).toEqual([]);
    t.socket.deliver("ocols\r\nUpgrade: websocket\r\n\r\n");
    expect(t.seen.opens).toBe(1);
  });

  it("fails with the status line when the port is not the bridge", () => {
    // Something else on 25569 — a web server, a stale process — answers with
    // an ordinary response; the user needs to see what actually replied.
    const t = scripted();
    t.tcpConnect();
    t.socket.deliver("HTTP/1.1 404 Not Found\r\n\r\n");

    expect(t.seen.errors).toEqual(["WebSocket handshake failed: HTTP/1.1 404 Not Found"]);
    expect(t.socket.destroys).toBe(1);
    expect(t.seen.opens).toBe(0);
  });

  it("accepts frames arriving in the same packet as the upgrade response", () => {
    // The bridge answers and pushes immediately; dropping the tail would lose
    // the first response of every session.
    const t = scripted();
    t.tcpConnect();
    t.socket.deliver(Buffer.concat([Buffer.from(HANDSHAKE_OK), serverFrame(0x1, "hello")]));
    expect(t.seen.messages).toEqual(["hello"]);
  });
});

describe("sending", () => {
  it("drops sends made before the connection is open", () => {
    // Callers queue a request the moment they construct the client; writing a
    // frame into a socket that is still mid-handshake corrupts the stream.
    const t = scripted();
    t.tcpConnect();
    t.ws.send("too early");
    expect(t.socket.written).toHaveLength(1); // the handshake only
  });

  it("sends text as a masked client frame", () => {
    const t = scripted().open();
    t.ws.send("ping the bridge");
    const frame = clientFrame(t.socket.written[0]);

    expect(frame.opcode).toBe(0x1);
    expect(frame.payload.toString()).toBe("ping the bridge");
    // Masked, per the RFC's client requirement — an unmasked client frame is
    // a protocol error the server must close on.
    expect(t.socket.written[0][1] & 0x80).toBe(0x80);
  });

  it("drops sends made after the connection has closed", () => {
    const t = scripted().open();
    t.ws.close();
    t.socket.written.length = 0;
    t.ws.send("too late");
    expect(t.socket.written).toEqual([]);
  });

  it("reports a socket that refuses the write", () => {
    // DCS exiting mid-request; the caller must see an error rather than a
    // request that never resolves.
    const t = scripted().open();
    t.socket.writeFault = new Error("EPIPE");
    t.ws.send("doomed");
    expect(t.seen.errors).toEqual(["EPIPE"]);
  });

  it("reports a write failure that was not an Error", () => {
    const t = scripted().open();
    t.socket.writeFault = "socket gone";
    t.ws.send("doomed");
    expect(t.seen.errors).toEqual(["socket gone"]);
  });
});

describe("receiving", () => {
  it("reassembles a text message split across fragments", () => {
    // Large Lua console results arrive fragmented; delivering the pieces
    // separately would hand callers unparsable half-JSON.
    const t = scripted().open();
    t.socket.deliver(serverFrame(0x1, "part one ", false));
    expect(t.seen.messages).toEqual([]);
    t.socket.deliver(serverFrame(0x0, "part two", true));
    expect(t.seen.messages).toEqual(["part one part two"]);
  });

  it("waits for the rest of a frame that arrived incomplete", () => {
    const t = scripted().open();
    const frame = serverFrame(0x1, "abcdef");
    t.socket.deliver(frame.subarray(0, 4));
    expect(t.seen.messages).toEqual([]);
    t.socket.deliver(frame.subarray(4));
    expect(t.seen.messages).toEqual(["abcdef"]);
  });

  it("ignores binary frames rather than decoding them as text", () => {
    // The bridge protocol is JSON text; a binary frame is not ours and
    // surfacing it as a message would feed garbage into the JSON parser.
    const t = scripted().open();
    t.socket.deliver(serverFrame(0x2, Buffer.from([0xff, 0x00])));
    expect(t.seen.messages).toEqual([]);
  });

  it("answers a ping with a matching pong", () => {
    // Servers drop clients that fail to answer keepalives; a missed pong ends
    // a debug session mid-breakpoint.
    const t = scripted().open();
    t.socket.deliver(serverFrame(0x9, "keepalive"));
    const frame = clientFrame(t.socket.written[0]);
    expect(frame.opcode).toBe(0xa);
    expect(frame.payload.toString()).toBe("keepalive");
  });

  it("ignores an unsolicited pong", () => {
    const t = scripted().open();
    t.socket.deliver(serverFrame(0xa, "unsolicited"));
    expect(t.socket.written).toEqual([]);
    expect(t.seen.messages).toEqual([]);
  });
});

describe("closing", () => {
  it("reports the peer's close code and reason", () => {
    // "mission ended" versus "port refused" is the difference between a
    // reconnect and a configuration problem.
    const t = scripted().open();
    const payload = Buffer.concat([Buffer.from([0x03, 0xe8]), Buffer.from("mission ended")]);
    t.socket.deliver(serverFrame(0x8, payload));

    expect(t.seen.closes).toEqual([{ code: 1000, reason: "mission ended" }]);
    expect(t.socket.ends).toBe(1);
  });

  it("still reports the close when tearing down the socket throws", () => {
    const t = scripted().open();
    t.socket.endFault = new Error("already destroyed");
    t.socket.deliver(serverFrame(0x8, Buffer.from([0x03, 0xe8])));
    expect(t.seen.closes).toEqual([{ code: 1000, reason: "" }]);
  });

  it("sends a close frame and ends the socket on an explicit close", () => {
    const t = scripted().open();
    t.ws.close();
    expect(clientFrame(t.socket.written[0]).opcode).toBe(0x8);
    expect(t.socket.ends).toBe(1);
  });

  it("ignores a second close", () => {
    // Panels dispose more than once; a second close frame on a dead socket
    // would raise an error the caller has no way to act on.
    const t = scripted().open();
    t.ws.close();
    t.socket.written.length = 0;
    t.ws.close();
    expect(t.socket.written).toEqual([]);
    expect(t.socket.ends).toBe(1);
  });

  it("does not throw when the socket refuses to be closed", () => {
    const t = scripted().open();
    t.socket.endFault = new Error("ERR_SOCKET_CLOSED");
    expect(() => t.ws.close()).not.toThrow();
    expect(t.seen.errors).toEqual([]);
  });

  it("reports an abnormal close when the peer just disappears", () => {
    // DCS killed from Task Manager: no close frame, only a dead socket. 1006
    // is what tells the console to show "disconnected" rather than nothing.
    const t = scripted().open();
    t.socket.hangUp();
    expect(t.seen.closes).toEqual([{ code: 1006, reason: "socket closed" }]);
  });

  it("does not report a second close after we closed ourselves", () => {
    const t = scripted().open();
    t.ws.close();
    t.socket.hangUp();
    expect(t.seen.closes).toEqual([]);
  });
});

describe("errors", () => {
  it("reports a socket error and destroys the connection", () => {
    const t = scripted().open();
    t.socket.raise(new Error("ECONNRESET"));
    expect(t.seen.errors).toEqual(["ECONNRESET"]);
    expect(t.socket.destroys).toBe(1);
  });

  it("reports only the first error", () => {
    // A failing socket emits repeatedly; each one would otherwise pop another
    // notification for a connection that already died once.
    const t = scripted().open();
    t.socket.raise(new Error("ECONNRESET"));
    t.socket.raise(new Error("EPIPE"));
    expect(t.seen.errors).toEqual(["ECONNRESET"]);
  });

  it("still reports the error when destroying the socket also throws", () => {
    const t = scripted().open();
    t.socket.destroyFault = new Error("already destroyed");
    t.socket.raise(new Error("ECONNREFUSED"));
    expect(t.seen.errors).toEqual(["ECONNREFUSED"]);
  });
});

describe("callers that register no handlers", () => {
  it("survives the entire lifecycle without any callbacks", () => {
    // Handlers are all optional on the port; a fire-and-forget caller must not
    // take down the extension host on the first event.
    const t = scripted("none");
    expect(() => {
      t.tcpConnect();
      t.socket.deliver(HANDSHAKE_OK);
      t.socket.deliver(serverFrame(0x1, "hello"));
      t.socket.deliver(serverFrame(0x8, Buffer.from([0x03, 0xe9])));
      t.socket.hangUp();
    }).not.toThrow();
  });

  it("survives a handshake rejection with no error handler", () => {
    const t = scripted("none");
    t.tcpConnect();
    expect(() => t.socket.deliver("HTTP/1.1 500 Server Error\r\n\r\n")).not.toThrow();
  });
});

describe("WsBridgeTransport", () => {
  it("forwards every handler through to the socket", () => {
    const seen: Recorded = { opens: 0, messages: [], closes: [], errors: [] };
    let socket: FakeSocket | undefined;
    let onConnect = (): void => {};
    const conn = new WsBridgeTransport((_e, cb) => {
      onConnect = cb;
      socket = new FakeSocket();
      return socket as WsSocket;
    }).connect(
      { host: "127.0.0.1", port: 25570, path: "/rpc" },
      {
        onOpen() {
          seen.opens++;
        },
        onMessage(t) {
          seen.messages.push(t);
        },
        onClose(code, reason) {
          seen.closes.push({ code, reason });
        },
        onError(e) {
          seen.errors.push(e.message);
        },
      },
    );

    onConnect();
    socket?.deliver(HANDSHAKE_OK);
    socket?.deliver(serverFrame(0x1, '{"jsonrpc":"2.0"}'));
    conn.send("request");
    conn.close();

    expect(seen.opens).toBe(1);
    expect(seen.messages).toEqual(['{"jsonrpc":"2.0"}']);
    expect(seen.closes).toEqual([]);
    expect(socket?.ends).toBe(1);
  });

  it("connects with no handlers supplied at all", () => {
    let socket: FakeSocket | undefined;
    let onConnect = (): void => {};
    const conn = new WsBridgeTransport((_e, cb) => {
      onConnect = cb;
      socket = new FakeSocket();
      return socket as WsSocket;
    }).connect({ host: "127.0.0.1", port: 25570, path: "/rpc" }, {});

    expect(() => {
      onConnect();
      socket?.deliver(HANDSHAKE_OK);
      conn.send("request");
      conn.close();
    }).not.toThrow();
  });
});

describe("over a real TCP connection", () => {
  const servers: net.Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });

  /** A minimal WebSocket server: accept the upgrade, then push one message. */
  function listen(): Promise<number> {
    const server = net.createServer((sock) => {
      sock.once("data", () => {
        sock.write(HANDSHAKE_OK);
        sock.write(serverFrame(0x1, "from the bridge"));
      });
      sock.on("error", () => undefined);
    });
    servers.push(server);
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve((server.address() as net.AddressInfo).port);
      });
    });
  }

  it("completes a real handshake and delivers a real message", async () => {
    // The default wiring — an actual TCP socket, an actual upgrade, actual
    // framed bytes on the wire — end to end, exactly as it talks to DCS.
    const port = await listen();
    const messages: string[] = [];
    const opened = new Promise<void>((resolve) => {
      const conn = new WsBridgeTransport().connect(
        { host: "127.0.0.1", port, path: "/rpc" },
        {
          onMessage(text) {
            messages.push(text);
            conn.close();
            resolve();
          },
        },
      );
    });

    await opened;
    expect(messages).toEqual(["from the bridge"]);
  });

  it("reports a refused connection as an error rather than hanging", async () => {
    // Nothing is listening until the bridge is injected and DCS is running,
    // which is the state most users are in when they first click Connect.
    const port = await listen();
    await new Promise<void>((resolve) => {
      servers[0].close(() => resolve());
    });
    servers.length = 0;

    const err = await new Promise<Error>((resolve) => {
      new WsBridgeTransport().connect(
        { host: "127.0.0.1", port, path: "/rpc" },
        { onError: resolve },
      );
    });
    expect(err.message).toMatch(/ECONNREFUSED/);
  });
});
