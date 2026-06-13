// Format Document / Format Selection (issue #18, model studio::edit::Formatting).
//
// The formatter runs in Rust (crates/dcs-lua-fmt) behind the `format_source`
// Tauri command, the SAME engine the CLI `fmt` / `fmt --check` runs — so a
// buffer formatted here is byte-for-byte what CI checks. The engine is injected
// as a `Formatter` through `formatterFacet`, not imported directly: production
// wires the Tauri-backed one (`makeTauriFormatter`), and /lab/editor wires a
// deterministic stub so the browser e2e can drive the keybinding without a
// backend — the same seam convention as Editor.svelte's `readFile` prop.
//
// Keybinding (docs/keybindings.md): Shift-Alt-F formats the selection when one
// is non-empty, otherwise the whole document — the VS Code "Format Document /
// Selection" convention.

import { EditorView, keymap } from "@codemirror/view";
import { Facet, Prec, type Extension } from "@codemirror/state";
import { isTauri } from "@tauri-apps/api/core";
import { formatSource, type FormatResult } from "$lib/api";
import { ByteOffsets } from "$lib/lang/offsets";

/**
 * Formats `text` and returns the result, or `null` when no formatter is
 * available in this environment (e.g. a plain browser with no Tauri backend).
 * `range` (`[from, to)` byte offsets) formats only the statements enclosing a
 * selection; `null` formats the whole document. Rejects when the buffer does
 * not parse — the caller keeps the buffer unchanged.
 */
export type Formatter = (
  text: string,
  range: { from: number; to: number } | null,
) => Promise<FormatResult | null>;

/**
 * The active editor's formatter. One value, injected by the host (Editor.svelte
 * or a lab surface); absent → formatting is a no-op (`combine` yields `null`).
 */
export const formatterFacet = Facet.define<Formatter, Formatter | null>({
  combine: (values) => values[0] ?? null,
});

/** The Tauri-backed formatter for the file at `path`; `null` outside Tauri.
 * `range` already carries the engine's byte offsets (converted in `runFormat`),
 * so it crosses to `format_source` verbatim. */
export function makeTauriFormatter(path: string): Formatter {
  return (text, range) => {
    if (!isTauri()) return Promise.resolve(null);
    return formatSource(path, text, range ? [range.from, range.to] : null);
  };
}

/** Map an editor (UTF-16) range to the engine's `[start, end)` byte span. */
function toByteRange(
  text: string,
  range: { from: number; to: number },
): { from: number; to: number } {
  const map = new ByteOffsets(text);
  return { from: map.bytes(range.from), to: map.bytes(range.to) };
}

/**
 * Format the buffer (whole document, or just `range` when given) and apply the
 * result. A no-op when no formatter is wired, when the buffer already parses to
 * the same text, or when the semantic guard tripped (the buffer is left
 * unchanged and the trip is surfaced). A buffer that does not parse is left
 * untouched — its parse findings already show in the Problems panel.
 *
 * `range` is in the editor's UTF-16 offsets (a CodeMirror selection); it is
 * converted to the engine's byte offsets at the boundary, like every other
 * engine-bound offset (offsets.ts, dcs-lua.ts). `null` formats the whole
 * document.
 *
 * Async: a result computed against a buffer the user has since edited is
 * dropped, never spliced over the newer text.
 */
export async function runFormat(
  view: EditorView,
  range: { from: number; to: number } | null,
): Promise<void> {
  const formatter = view.state.facet(formatterFacet);
  if (!formatter) return;
  const before = view.state.doc.toString();
  // CodeMirror counts UTF-16 code units; the engine's Span is UTF-8 bytes
  // (span.rs). Without this conversion a Format Selection past any non-ASCII
  // byte reformats the wrong run. The result is whole-document text, so no
  // reverse map is needed on the way back.
  const byteRange = range ? toByteRange(before, range) : null;
  let result: FormatResult | null;
  try {
    result = await formatter(before, byteRange);
  } catch (error) {
    // Unparseable buffer, or a backend error: leave the buffer untouched. No
    // toast surface exists yet — log like the other fs/engine failures.
    console.error("format failed:", error);
    return;
  }
  if (!result) return;
  if (result.guard_tripped) {
    console.warn(
      "formatter guard tripped — buffer left unchanged; please report this file",
    );
    return;
  }
  // The buffer moved under us while the format was in flight: a stale result
  // must never clobber newer keystrokes.
  if (view.state.doc.toString() !== before) return;
  if (result.text === before) return;
  const head = view.state.selection.main.head;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: result.text },
    // Best-effort caret: hold the offset, clamped into the reformatted text.
    selection: { anchor: Math.min(head, result.text.length) },
    scrollIntoView: true,
  });
}

/** Format Selection when a selection is non-empty, else Format Document. */
function formatBuffer(view: EditorView): boolean {
  const main = view.state.selection.main;
  const range = main.empty ? null : { from: main.from, to: main.to };
  // Claim the key now; the format round-trips to the backend asynchronously
  // (the same fire-and-forget shape as the Mod-s save binding).
  void runFormat(view, range);
  return true;
}

/**
 * The Format keymap, at high precedence so it owns Shift-Alt-F above any base
 * setup — an explicit, documented IDE contract (docs/keybindings.md).
 */
export const formatKeymap: Extension = Prec.high(
  keymap.of([{ key: "Shift-Alt-f", run: formatBuffer, preventDefault: true }]),
);
