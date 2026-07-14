import * as crypto from "crypto";
import * as net from "net";
import { encodeFrame, parseCloseFrame, readFrame } from "../../core/domain/wsFraming";
import type {
  BridgeConnection,
  BridgeEndpoint,
  BridgeHandlers,
  BridgeTransportPort,
} from "../../core/ports/bridgeTransport";

// Node adapter for `BridgeTransportPort`: a minimal client-side WebSocket
// (RFC 6455) over a raw TCP socket — enough to speak text frames to the in-DCS
// bridge without pulling in the `ws` package (which would force a bundler; the
// rest of the extension is dependency-free and the VS Code Node runtime has no
// stable global WebSocket). Client frames are masked, control frames
// (ping/close) are handled, and text messages are reassembled across
// fragments. The socket, handshake and randomness live here; the byte-level
// frame codec is core/domain/wsFraming.
export interface WsHandlers {
  onOpen?: () => void;
  onMessage?: (text: string) => void;
  onClose?: (code: number, reason: string) => void;
  onError?: (err: Error) => void;
}

export class MiniWebSocket {
  private readonly socket: net.Socket;
  private handshakeDone = false;
  private buffer = Buffer.alloc(0);
  private closed = false;
  private frags: Buffer[] = [];
  private fragOpcode = 0;
  private readonly key = crypto.randomBytes(16).toString("base64");

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly path: string,
    private readonly h: WsHandlers,
  ) {
    this.socket = net.createConnection({ host, port }, () => this.sendHandshake());
    this.socket.on("data", (d) => this.onData(d));
    this.socket.on("error", (e) => this.fail(e.message));
    this.socket.on("close", () => {
      if (!this.closed) {
        this.closed = true;
        this.h.onClose?.(1006, "socket closed");
      }
    });
  }

  send(text: string): void {
    if (!this.closed && this.handshakeDone) this.writeFrame(0x1, Buffer.from(text, "utf8"));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.writeFrame(0x8, Buffer.alloc(0));
      this.socket.end();
    } catch {
      /* already gone */
    }
  }

  private sendHandshake(): void {
    const req =
      `GET ${this.path} HTTP/1.1\r\n` +
      `Host: ${this.host}:${this.port}\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${this.key}\r\n` +
      `Sec-WebSocket-Version: 13\r\n\r\n`;
    this.socket.write(req);
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.handshakeDone) {
      const idx = this.buffer.indexOf("\r\n\r\n");
      if (idx === -1) return;
      const statusLine = this.buffer.slice(0, idx).toString("utf8").split("\r\n")[0];
      if (!/ 101 /.test(statusLine)) {
        this.fail(`WebSocket handshake failed: ${statusLine}`);
        return;
      }
      this.buffer = this.buffer.subarray(idx + 4);
      this.handshakeDone = true;
      this.h.onOpen?.();
    }
    this.parseFrames();
  }

  private parseFrames(): void {
    for (;;) {
      const frame = readFrame(this.buffer);
      if (!frame) return; // await more bytes
      this.buffer = this.buffer.subarray(frame.consumed);
      this.handleFrame(frame.fin, frame.opcode, Buffer.from(frame.payload));
    }
  }

  private handleFrame(fin: boolean, opcode: number, payload: Buffer): void {
    if (opcode === 0x8) {
      // close
      this.closed = true;
      const { code, reason } = parseCloseFrame(payload);
      try {
        this.socket.end();
      } catch {
        /* ignore */
      }
      this.h.onClose?.(code, reason);
      return;
    }
    if (opcode === 0x9) {
      this.writeFrame(0xa, payload); // ping -> pong
      return;
    }
    if (opcode === 0xa) return; // pong

    if (opcode === 0x0) {
      this.frags.push(payload); // continuation
    } else {
      this.frags = [payload];
      this.fragOpcode = opcode;
    }
    if (fin) {
      const full = Buffer.concat(this.frags);
      this.frags = [];
      if (this.fragOpcode === 0x1) this.h.onMessage?.(full.toString("utf8")); // ignore binary
    }
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    const frame = encodeFrame(opcode, payload, crypto.randomBytes(4));
    try {
      this.socket.write(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength));
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e));
    }
  }

  private fail(msg: string): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.destroy();
    } catch {
      /* ignore */
    }
    this.h.onError?.(new Error(msg));
  }
}

/** `BridgeTransportPort` over `MiniWebSocket`. */
export class WsBridgeTransport implements BridgeTransportPort {
  connect(endpoint: BridgeEndpoint, handlers: BridgeHandlers): BridgeConnection {
    const ws = new MiniWebSocket(endpoint.host, endpoint.port, endpoint.path, {
      onOpen: handlers.onOpen?.bind(handlers),
      onMessage: handlers.onMessage?.bind(handlers),
      onClose: handlers.onClose?.bind(handlers),
      onError: handlers.onError?.bind(handlers),
    });
    return {
      send: (text) => ws.send(text),
      close: () => ws.close(),
    };
  }
}
