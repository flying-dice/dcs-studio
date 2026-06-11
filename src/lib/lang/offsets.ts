// Offset vocabulary at the engine boundary.
//
// The engine speaks BYTE offsets (UTF-8, by design — see the engine's
// span.rs); CodeMirror and JS strings index UTF-16 code units. Every
// engine offset crossing into the editor converts here, so squiggles,
// folds, and symbol ranges stay put on non-ASCII lines. The LSP transport
// avoids this entirely (line + UTF-16 character on the wire); only the
// wasm fallback needs the byte map.

/** UTF-16 code-unit start index of each line. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

/** Byte↔UTF-16 offset converter for one text snapshot. */
export class ByteOffsets {
  /** `byteBefore[i]` = UTF-8 bytes before UTF-16 index `i`. */
  private readonly byteBefore: Uint32Array;
  private readonly ascii: boolean;

  constructor(text: string) {
    const map = new Uint32Array(text.length + 1);
    let bytes = 0;
    let i = 0;
    while (i < text.length) {
      const codePoint = text.codePointAt(i) ?? 0;
      const units = codePoint > 0xffff ? 2 : 1;
      map[i] = bytes;
      // A low surrogate maps to its character's start.
      if (units === 2) map[i + 1] = bytes;
      bytes +=
        codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
      i += units;
    }
    map[text.length] = bytes;
    this.byteBefore = map;
    this.ascii = bytes === text.length;
  }

  /** The UTF-16 index whose byte position contains `byteOffset`. */
  utf16(byteOffset: number): number {
    if (this.ascii) {
      return Math.min(byteOffset, this.byteBefore.length - 1);
    }
    // Largest i with byteBefore[i] <= byteOffset.
    let low = 0;
    let high = this.byteBefore.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (this.byteBefore[mid] <= byteOffset) low = mid;
      else high = mid - 1;
    }
    return low;
  }

  /** The UTF-8 byte offset of the character at UTF-16 index `utf16Offset`. */
  bytes(utf16Offset: number): number {
    if (this.ascii) {
      return Math.min(utf16Offset, this.byteBefore.length - 1);
    }
    // byteBefore IS the UTF-16→byte mapping; clamp into [0, text.length].
    return this.byteBefore[Math.min(utf16Offset, this.byteBefore.length - 1)];
  }
}
