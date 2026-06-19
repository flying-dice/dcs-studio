// The WorkspaceEdit apply engine (model studio::edit `ApplyWorkspaceEdit`,
// issue #18): applies a rename's multi-file edit set as a two-phase transaction
// so a failure is contained. Split out of refactor.ts so the transaction —
// group-by-path, dirty re-check, back-to-front splice, contained
// disk-write/buffer-evict — is unit-testable without the editor keybinding glue
// that drives it.

import { readTextFile, writeTextFile } from "$lib/api";
import { fileName } from "$lib/utils";
import { app } from "$lib/state.svelte";
import { editorViewFor } from "$lib/lang/codemirror";
import { lang } from "$lib/lang/intel.svelte";
import type { EditorView } from "@codemirror/view";
import type { TextEdit, WorkspaceEdit } from "$lib/lang/provider";

/**
 * Apply a multi-file edit set in two phases so a failure is contained. The
 * shown file's open editor takes its edits as one undoable transaction; every
 * other affected file is rewritten on disk (the engine kept in sync) and, when
 * open in a background tab, its parked buffer is evicted so reactivation
 * reloads the renamed text.
 *
 * Phase 1 reads and computes every new file content; a read failure (or the
 * re-checked dirty guard) aborts here, before a single byte is written or a
 * buffer touched, so a failed rename never half-applies. Phase 2 writes. A
 * mid-write I/O failure can still leave earlier files written — multi-file
 * disk writes aren't atomic without a journal — but every read already
 * succeeded, so the residual is a rare disk error, recoverable by re-running
 * the rename (model `ApplyWorkspaceEdit`).
 *
 * @throws Error when an affected file became dirty after the caller's guard
 * (a background tab edited during the engine round-trip), or when a source
 * read fails — refused before any write, so unsaved work is never clobbered.
 */
export async function applyWorkspaceEdit(edit: WorkspaceEdit): Promise<void> {
  const byPath = new Map<string, TextEdit[]>();
  for (const e of edit.edits) {
    const list = byPath.get(e.path) ?? [];
    list.push(e);
    byPath.set(e.path, list);
  }

  // Re-check the dirty guard here (not just in renameSymbol): the engine
  // round-trip is async, so a background tab could have been dirtied since.
  const dirty = [...byPath.keys()].filter(
    (path) => !editorViewFor(path) && app.isDirty(path),
  );
  if (dirty.length > 0) {
    const names = dirty.map(fileName).join(", ");
    throw new Error(`Save ${names} before renaming — ${dirty.length === 1 ? "it has" : "they have"} unsaved changes.`);
  }

  // ── Phase 1: compute everything (reads only) — a failure here writes nothing.
  type Change = { from: number; to: number; insert: string };
  const bufferEdits: { view: EditorView; changes: Change[] }[] = [];
  const diskWrites: { path: string; text: string }[] = [];
  for (const [path, edits] of byPath) {
    const view = editorViewFor(path);
    if (view) {
      // CodeMirror applies a sorted, non-overlapping change set as one
      // undoable transaction; rename spans never overlap.
      const changes = [...edits]
        .sort((a, b) => a.start - b.start)
        .map((e) => ({ from: e.start, to: e.end, insert: e.newText }));
      bufferEdits.push({ view, changes });
    } else {
      // Closed (or background) file: read then splice back-to-front so each
      // span stays valid.
      let text = await readTextFile(path);
      for (const e of [...edits].sort((a, b) => b.start - a.start)) {
        text = text.slice(0, e.start) + e.newText + text.slice(e.end);
      }
      diskWrites.push({ path, text });
    }
  }

  // ── Phase 2: apply. Disk writes first (the failure-prone step), then the
  // in-memory buffer transactions. Evict written-and-open background buffers
  // in `finally` so even a partial apply never leaves a stale buffer shadowing
  // the new disk text.
  const evicted: string[] = [];
  try {
    for (const w of diskWrites) {
      await writeTextFile(w.path, w.text);
      if (app.openFiles.some((f) => f.path === w.path)) evicted.push(w.path);
      await lang.updateSource(w.path, w.text);
    }
    for (const b of bufferEdits) b.view.dispatch({ changes: b.changes });
  } finally {
    if (evicted.length > 0) app.evictBuffers(evicted);
  }
}
