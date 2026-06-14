// Terminal output splicing (model/studio/term.pds, issue #13): merge a session's
// replay tail with the live chunks that arrive while the replay is being
// written, by byte offset, so a remounting view neither gaps nor repeats (model
// ReplayThenLiveOnRemount).
//
// Pure and DOM-free — the subtle splice math the Terminal component used to
// embed, lifted out so it can be reasoned about (and unit-tested) on its own.

/**
 * Decode a base64 string (the terminal's IPC wire encoding for raw output
 * bytes) into the bytes an xterm writes.
 */
export function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Splices a session's replay tail with the live output that arrives while the
 * replay is being written, tracking the highest byte offset already shown.
 *
 * `seq` is the backend's monotonic count of bytes produced through a chunk's
 * end. {@link OutputSplicer.next} returns only the bytes past what it has
 * already shown — dropping a wholly-stale chunk and slicing one that straddles
 * the boundary — so the replayed tail and the live stream meet with neither a
 * gap nor a repeat.
 */
export class OutputSplicer {
  /** Highest byte offset already written to the view. */
  private lastSeq = 0;

  /**
   * The unseen tail of `chunk` (whose end sits at byte offset `seq`), or `null`
   * when every byte is at or below what has already been shown. Advances the
   * cursor to `seq`.
   */
  next(chunk: Uint8Array, seq: number): Uint8Array | null {
    if (seq <= this.lastSeq) return null;
    const start = seq - chunk.length; // byte offset of chunk[0]
    const from = Math.max(0, this.lastSeq - start);
    this.lastSeq = seq;
    return from > 0 ? chunk.subarray(from) : chunk;
  }
}
