// Engine-driven editor refactorings (issue #18, model studio::edit
// Refactoring): go-to-definition, find-usages, and rename-symbol on top of
// the LanguageProvider seam. The provider answers the queries; this module
// owns the editor-side flow — navigation, the Usages panel, and applying a
// rename's multi-file edit through the save write path with the dirty-buffer
// guard.

import { keymap, EditorView } from "@codemirror/view";
import { Facet, Prec, type Extension } from "@codemirror/state";
import { readTextFile, writeTextFile } from "$lib/api";
import { app } from "$lib/state.svelte";
import { usages, type UsageItem } from "$lib/usages.svelte";
import { providerFor } from "$lib/lang/registry";
import { editorViewFor, revealInEditor } from "$lib/lang/codemirror";
import { lang } from "$lib/lang/intel.svelte";
import type { Location, TextEdit, WorkspaceEdit } from "$lib/lang/provider";

/** Whether the file at `path` has a provider that answers find-usages /
 * rename — drives enabling the editor context-menu entries. */
export function hasRefactorProvider(path: string | null): boolean {
  if (!path) return false;
  const provider = providerFor(path);
  return !!provider && provider.status === "ready";
}

/** A request to open the inline rename widget at `offset`, prefilled with the
 * symbol's current `name`. The editor component provides the handler. */
export interface RenameRequest {
  offset: number;
  name: string;
}

/** Editor → component seam for the rename widget (the keymap can't render UI). */
export const renameRequestFacet = Facet.define<
  (request: RenameRequest) => void,
  ((request: RenameRequest) => void) | null
>({ combine: (values) => values[0] ?? null });

/** The identifier under `pos`, or "" if none. */
function wordAt(view: EditorView, pos: number): string {
  const word = view.state.wordAt(pos);
  return word ? view.state.sliceDoc(word.from, word.to) : "";
}

/**
 * The refactor key bindings + ctrl/cmd-click for `path`: F12 go-to-definition,
 * Shift-F12 find-usages (opens the Usages panel), F2 rename (opens the inline
 * widget via {@link renameRequestFacet}). Bound at high precedence so they own
 * their keys above basicSetup.
 */
export function refactorExtensions(path: string): Extension {
  return [
    Prec.high(
      keymap.of([
        {
          key: "F12",
          run: (view) => {
            void goToDefinition(path, view.state.selection.main.head);
            return true;
          },
        },
        {
          key: "Shift-F12",
          run: (view) => {
            const head = view.state.selection.main.head;
            void findUsages(path, head, wordAt(view, head));
            app.bottomTool = "usages";
            return true;
          },
        },
        {
          key: "F2",
          run: (view) => {
            const head = view.state.selection.main.head;
            const name = wordAt(view, head);
            if (!name) return false;
            view.state.facet(renameRequestFacet)?.({ offset: head, name });
            return true;
          },
        },
      ]),
    ),
    // Ctrl/Cmd-click jumps to definition (the VS Code gesture).
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (!(event.ctrlKey || event.metaKey) || event.button !== 0) {
          return false;
        }
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos == null) return false;
        event.preventDefault();
        void goToDefinition(path, pos);
        return true;
      },
    }),
  ];
}

/**
 * Jump to the definition of the symbol at `offset` (model `GoToDefinition`):
 * reveal in place when the target is the shown file, else open it and land
 * the caret. Returns false when nothing resolves.
 */
export async function goToDefinition(
  path: string,
  offset: number,
): Promise<boolean> {
  const provider = providerFor(path);
  if (!provider) return false;
  const location = await provider.definition(path, offset);
  if (!location) return false;
  // A live editor for the target (the shown file) navigates in place;
  // otherwise open the file and land once it loads.
  if (!revealInEditor(location.path, location.start)) {
    app.openFileAt(location.path, location.start);
  }
  return true;
}

/**
 * List every use of the symbol at `offset` in the Usages panel (model
 * `FindUsages`). `symbol` labels the panel header. No-op when the provider
 * has no references query.
 */
export async function findUsages(
  path: string,
  offset: number,
  symbol: string,
): Promise<void> {
  const provider = providerFor(path);
  if (!provider?.references) return;
  const locations = await provider.references(path, offset);
  usages.set(symbol || "symbol", await enrichUsages(locations));
}

/** Attach a 1-based line/column and a line preview to each location, reading
 * each file once (open buffers preferred, else disk). */
async function enrichUsages(locations: Location[]): Promise<UsageItem[]> {
  const textCache = new Map<string, string>();
  const items: UsageItem[] = [];
  for (const loc of locations) {
    let text = textCache.get(loc.path);
    if (text === undefined) {
      const open = app.openFiles.find((f) => f.path === loc.path);
      text =
        open && open.docText
          ? open.docText
          : await readTextFile(loc.path).catch(() => "");
      textCache.set(loc.path, text);
    }
    items.push({ path: loc.path, offset: loc.start, ...lineColPreview(text, loc.start) });
  }
  return items;
}

/** 1-based line/column and the trimmed source line containing `offset`. */
function lineColPreview(
  text: string,
  offset: number,
): { line: number; col: number; preview: string } {
  const at = Math.min(Math.max(offset, 0), text.length);
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < at; i++) {
    if (text[i] === "\n") {
      line += 1;
      lineStart = i + 1;
    }
  }
  let lineEnd = text.indexOf("\n", lineStart);
  if (lineEnd < 0) lineEnd = text.length;
  return {
    line,
    col: at - lineStart + 1,
    preview: text.slice(lineStart, lineEnd).trim(),
  };
}

/**
 * Rename the symbol at `offset` to `newName` across the workspace (model
 * `RenameSymbol`). The engine refuses an invalid name or unresolved offset
 * (the provider rejects); this layer additionally refuses when any affected
 * file has unsaved edits, then applies the edit set. Returns the number of
 * occurrences rewritten.
 *
 * @throws Error with a human message when refused (engine or dirty-buffer).
 */
export async function renameSymbol(
  path: string,
  offset: number,
  newName: string,
): Promise<number> {
  const provider = providerFor(path);
  if (!provider?.rename) {
    throw new Error("Rename is not available for this file.");
  }
  // Rejects with the engine's message (invalid identifier, nothing to rename).
  const edit = await provider.rename(path, offset, newName);
  if (edit.edits.length === 0) {
    throw new Error("There is nothing to rename here.");
  }
  // Dirty-buffer guard (model `RenameRefusesWithUnsavedAffectedFiles`): a
  // rename must not clobber unsaved work — the developer saves first.
  const affected = [...new Set(edit.edits.map((e) => e.path))];
  const dirty = affected.filter((p) => app.isDirty(p));
  if (dirty.length > 0) {
    const names = dirty.map((p) => p.split(/[\\/]/).pop() || p).join(", ");
    throw new Error(`Save ${names} before renaming — ${dirty.length === 1 ? "it has" : "they have"} unsaved changes.`);
  }
  await applyWorkspaceEdit(edit);
  return edit.edits.length;
}

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
async function applyWorkspaceEdit(edit: WorkspaceEdit): Promise<void> {
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
    const names = dirty.map((p) => p.split(/[\\/]/).pop() || p).join(", ");
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
