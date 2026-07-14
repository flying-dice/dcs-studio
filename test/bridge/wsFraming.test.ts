import { describe, expect, it } from "vitest";
import {
  applyMask,
  encodeFrame,
  parseCloseFrame,
  readFrame,
} from "../../src/core/domain/wsFraming";

const enc = new TextEncoder();

/** An unmasked server-style frame (how the bridge actually sends). */
function serverFrame(opcode: number, payload: Uint8Array, fin = true): Uint8Array {
  const len = payload.length;
  let header: Uint8Array;
  if (len < 126) {
    header = new Uint8Array(2);
    header[1] = len;
  } else if (len < 65536) {
    header = new Uint8Array(4);
    header[1] = 126;
    new DataView(header.buffer).setUint16(2, len);
  } else {
    header = new Uint8Array(10);
    header[1] = 127;
    const dv = new DataView(header.buffer);
    dv.setUint32(2, Math.floor(len / 2 ** 32));
    dv.setUint32(6, len >>> 0);
  }
  header[0] = (fin ? 0x80 : 0x00) | opcode;
  const out = new Uint8Array(header.length + len);
  out.set(header, 0);
  out.set(payload, header.length);
  return out;
}

describe("applyMask", () => {
  it("XORs with the 4-byte key, cycling", () => {
    const mask = new Uint8Array([1, 2, 3, 4]);
    const data = new Uint8Array([0, 0, 0, 0, 0xff]);
    expect(Array.from(applyMask(data, mask))).toEqual([1, 2, 3, 4, 0xff ^ 1]);
  });

  it("is its own inverse", () => {
    const mask = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const data = enc.encode("round trip payload");
    expect(applyMask(applyMask(data, mask), mask)).toEqual(data);
  });

  it("returns a fresh array (input untouched)", () => {
    const data = new Uint8Array([7]);
    const out = applyMask(data, new Uint8Array([1, 0, 0, 0]));
    expect(data[0]).toBe(7);
    expect(out[0]).toBe(6);
  });
});

describe("readFrame", () => {
  it("returns null on fewer than 2 bytes", () => {
    expect(readFrame(new Uint8Array(0))).toBeNull();
    expect(readFrame(new Uint8Array([0x81]))).toBeNull();
  });

  it("decodes a short unmasked text frame", () => {
    const buf = serverFrame(0x1, enc.encode("hello"));
    const f = readFrame(buf)!;
    expect(f.fin).toBe(true);
    expect(f.opcode).toBe(0x1);
    expect(new TextDecoder().decode(f.payload)).toBe("hello");
    expect(f.consumed).toBe(buf.length);
  });

  it("decodes a non-FIN fragment", () => {
    const f = readFrame(serverFrame(0x1, enc.encode("frag"), false))!;
    expect(f.fin).toBe(false);
    expect(f.opcode).toBe(0x1);
  });

  it("waits for the full payload (null when incomplete)", () => {
    const buf = serverFrame(0x1, enc.encode("hello"));
    expect(readFrame(buf.subarray(0, buf.length - 1))).toBeNull();
  });

  it("decodes a 16-bit extended length frame and waits for its header", () => {
    const payload = new Uint8Array(300).fill(0x42);
    const buf = serverFrame(0x2, payload);
    const f = readFrame(buf)!;
    expect(f.opcode).toBe(0x2);
    expect(f.payload.length).toBe(300);
    expect(f.payload[299]).toBe(0x42);
    expect(f.consumed).toBe(4 + 300);
    // header truncated after the 126 marker
    expect(readFrame(buf.subarray(0, 3))).toBeNull();
  });

  it("decodes a 64-bit extended length frame and waits for its header", () => {
    const payload = new Uint8Array(65536).fill(7);
    const buf = serverFrame(0x2, payload);
    const f = readFrame(buf)!;
    expect(f.payload.length).toBe(65536);
    expect(f.consumed).toBe(10 + 65536);
    expect(readFrame(buf.subarray(0, 9))).toBeNull();
  });

  it("unmasks a masked frame and waits for the mask key", () => {
    const mask = new Uint8Array([9, 8, 7, 6]);
    const buf = encodeFrame(0x1, enc.encode("masked!"), mask);
    const f = readFrame(buf)!;
    expect(new TextDecoder().decode(f.payload)).toBe("masked!");
    // truncated inside the mask key
    expect(readFrame(buf.subarray(0, 4))).toBeNull();
  });

  it("decodes at a non-zero byte offset into a larger buffer", () => {
    const frame = serverFrame(0x1, enc.encode("off"));
    const outer = new Uint8Array(frame.length + 4);
    outer.set(frame, 4);
    const view = outer.subarray(4);
    const f = readFrame(view)!;
    expect(new TextDecoder().decode(f.payload)).toBe("off");
  });

  it("returns a detached payload copy for unmasked frames", () => {
    const buf = serverFrame(0x1, enc.encode("abc"));
    const f = readFrame(buf)!;
    buf.fill(0);
    expect(new TextDecoder().decode(f.payload)).toBe("abc");
  });
});

describe("encodeFrame", () => {
  it("sets FIN + opcode and the mask bit", () => {
    const out = encodeFrame(0x9, enc.encode("ping"), new Uint8Array(4));
    expect(out[0]).toBe(0x80 | 0x9);
    expect(out[1] & 0x80).toBe(0x80);
    expect(out[1] & 0x7f).toBe(4);
  });

  it("round-trips an empty frame (close)", () => {
    const out = encodeFrame(0x8, new Uint8Array(0), new Uint8Array([1, 2, 3, 4]));
    const f = readFrame(out)!;
    expect(f.opcode).toBe(0x8);
    expect(f.payload.length).toBe(0);
  });

  it("round-trips a 16-bit length frame", () => {
    const payload = new Uint8Array(126).fill(0xaa);
    const out = encodeFrame(0x2, payload, new Uint8Array([5, 6, 7, 8]));
    expect(out[1] & 0x7f).toBe(126);
    const f = readFrame(out)!;
    expect(f.payload).toEqual(payload);
  });

  it("round-trips a 64-bit length frame", () => {
    const payload = new Uint8Array(65536);
    for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
    const out = encodeFrame(0x2, payload, new Uint8Array([1, 1, 1, 1]));
    expect(out[1] & 0x7f).toBe(127);
    const f = readFrame(out)!;
    expect(f.payload).toEqual(payload);
  });
});

describe("parseCloseFrame", () => {
  it("empty payload → 1005 with empty reason", () => {
    expect(parseCloseFrame(new Uint8Array(0))).toEqual({ code: 1005, reason: "" });
  });

  it("one stray byte → still the no-status sentinel", () => {
    expect(parseCloseFrame(new Uint8Array([3]))).toEqual({ code: 1005, reason: "" });
  });

  it("parses code and UTF-8 reason", () => {
    const reason = enc.encode("going away");
    const payload = new Uint8Array(2 + reason.length);
    new DataView(payload.buffer).setUint16(0, 1001);
    payload.set(reason, 2);
    expect(parseCloseFrame(payload)).toEqual({ code: 1001, reason: "going away" });
  });

  it("parses a code-only close", () => {
    const payload = new Uint8Array(2);
    new DataView(payload.buffer).setUint16(0, 1000);
    expect(parseCloseFrame(payload)).toEqual({ code: 1000, reason: "" });
  });

  it("reads correctly at a non-zero byte offset", () => {
    const outer = new Uint8Array(5);
    new DataView(outer.buffer).setUint16(2, 1002);
    outer.set(enc.encode("x"), 4);
    expect(parseCloseFrame(outer.subarray(2))).toEqual({ code: 1002, reason: "x" });
  });
});
