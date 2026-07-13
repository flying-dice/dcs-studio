// Pure byte-level RFC-6455 frame codec, over `Uint8Array`, with no `net`/`crypto`
// dependency. The live transport (adapters/node/wsTransport.ts) owns the socket,
// the handshake and mask-key generation; everything here is deterministic byte
// math so the fragile framing rules can be characterization-tested exhaustively.

/** A fully decoded inbound frame: header flags plus the detached, unmasked payload. */
export interface DecodedFrame {
  fin: boolean;
  opcode: number;
  /** Unmasked payload, copied out of the source buffer (safe to retain). */
  payload: Uint8Array;
  /** Total bytes this frame occupied in the source buffer. */
  consumed: number;
}

/** XOR `payload` with the 4-byte `maskKey` (RFC-6455 masking), returning a fresh array. */
export function applyMask(payload: Uint8Array, maskKey: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length);
  for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ maskKey[i & 3];
  return out;
}

/**
 * Decode the frame at the front of `buffer`, or `null` if the buffer does not yet
 * hold a complete frame (caller should await more bytes). The returned payload is
 * a detached copy; the caller advances its buffer by `consumed`.
 */
export function readFrame(buffer: Uint8Array): DecodedFrame | null {
  if (buffer.length < 2) return null;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const b0 = buffer[0];
  const b1 = buffer[1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buffer.length < 4) return null;
    len = view.getUint16(2);
    offset = 4;
  } else if (len === 127) {
    if (buffer.length < 10) return null;
    len = view.getUint32(2) * 2 ** 32 + view.getUint32(6);
    offset = 10;
  }
  let maskKey: Uint8Array | null = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    maskKey = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + len) return null; // await full payload
  const raw = buffer.subarray(offset, offset + len);
  const payload = maskKey ? applyMask(raw, maskKey) : raw.slice();
  return { fin, opcode, payload, consumed: offset + len };
}

/**
 * Encode a masked client frame (`FIN` always set) carrying `payload` under `opcode`,
 * using the caller-supplied 4-byte `mask`. Layout: header + mask + masked payload.
 */
export function encodeFrame(opcode: number, payload: Uint8Array, mask: Uint8Array): Uint8Array {
  const len = payload.length;
  let header: Uint8Array;
  if (len < 126) {
    header = new Uint8Array(2);
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = new Uint8Array(4);
    header[1] = 0x80 | 126;
    new DataView(header.buffer).setUint16(2, len);
  } else {
    header = new Uint8Array(10);
    header[1] = 0x80 | 127;
    const dv = new DataView(header.buffer);
    dv.setUint32(2, Math.floor(len / 2 ** 32));
    dv.setUint32(6, len >>> 0);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  const masked = applyMask(payload, mask);
  const out = new Uint8Array(header.length + 4 + masked.length);
  out.set(header, 0);
  out.set(mask, header.length);
  out.set(masked, header.length + 4);
  return out;
}

/**
 * Parse a close-frame payload into its status code and reason. An empty payload
 * yields the RFC "no status" sentinel 1005 and an empty reason.
 */
export function parseCloseFrame(payload: Uint8Array): { code: number; reason: string } {
  let code = 1005;
  let reason = "";
  if (payload.length >= 2) {
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    code = view.getUint16(0);
    reason = new TextDecoder("utf-8").decode(payload.subarray(2));
  }
  return { code, reason };
}
