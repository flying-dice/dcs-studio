// Editor bookmark gutter (model/studio/bookmarks.pds): a clickable gutter that
// dots each bookmarked line and toggles a mark through the `bookmarks` store —
// modelled on the breakpoint gutter (editor/debugger.ts). Unlike breakpoints,
// the marks RE-MAP through document edits: a line inserted above a bookmark
// shifts it down with its code (the edit-tolerant anchoring contract), and the
// re-mapped lines are written back to the store on save (readBookmarkMarks).

import { EditorView, gutter, GutterMarker } from "@codemirror/view";
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { bookmarks } from "$lib/bookmarks.svelte";
import {
  snippetOf,
  normalizeBookmarkLines,
  remapBookmarkLines,
} from "$lib/bookmark-util";

/** Replace the marked lines from the store — syncBookmarkView pushes this on a
 *  tab switch or an external store change (panel remove / clear / load). */
const setBookmarkLines = StateEffect.define<number[]>();

/** The set of bookmarked 1-based line numbers in this view, re-mapped through
 *  every edit so a mark rides its code instead of pointing at whatever slid
 *  under its old line. */
const bookmarkField = StateField.define<number[]>({
  create() {
    return [];
  },
  update(value, tr) {
    let lines = value;
    if (tr.docChanged && lines.length) {
      lines = remapBookmarkLines(
        lines,
        tr.changes,
        tr.startState.doc,
        tr.state.doc,
      );
    }
    for (const e of tr.effects) {
      if (e.is(setBookmarkLines))
        lines = normalizeBookmarkLines(e.value, tr.state.doc.lines);
    }
    return lines;
  },
});

class BookmarkMarker extends GutterMarker {
  toDOM(): HTMLElement {
    const tag = document.createElement("span");
    tag.className = "cm-bookmark";
    return tag;
  }
}
const bookmarkMarker = new BookmarkMarker();

/** The 1-based line for a gutter block's start position. */
function lineAt(view: EditorView, from: number): number {
  return view.state.doc.lineAt(from).number;
}

/** The bookmark gutter for `path`: a tag per marked line, and a mousedown that
 *  toggles a mark through the store (the $effect syncs the new set back in). */
function bookmarkGutter(path: string): Extension {
  return gutter({
    class: "cm-bookmark-gutter",
    lineMarker(view, block) {
      return view.state.field(bookmarkField).includes(lineAt(view, block.from))
        ? bookmarkMarker
        : null;
    },
    lineMarkerChange(update) {
      return (
        update.startState.field(bookmarkField) !==
        update.state.field(bookmarkField)
      );
    },
    initialSpacer() {
      return bookmarkMarker;
    },
    domEventHandlers: {
      mousedown(view, block) {
        const line = lineAt(view, block.from);
        const snippet = snippetOf(view.state.doc.line(line).text);
        bookmarks.toggle(path, line, snippet);
        return true;
      },
    },
  });
}

/** The bookmark editor extension for `path` (every file — not gated to Lua like
 *  the debugger; any line in any file can be bookmarked). */
export function bookmarkExtension(path: string): Extension {
  return [bookmarkField, bookmarkGutter(path)];
}

/** Push the store's marked lines for `path` into `view` (tab switch, external
 *  store change). A no-op on a state without the bookmark field. */
export function syncBookmarkView(view: EditorView, path: string): void {
  if (view.state.field(bookmarkField, false) === undefined) return;
  view.dispatch({ effects: setBookmarkLines.of(bookmarks.linesFor(path)) });
}

/** The view's current marks as {line, snippet}, re-deriving each snippet from
 *  the live buffer — the save-time write-back into the store (model
 *  RemapFileBookmarks). Empty on a state without the field. */
export function readBookmarkMarks(
  view: EditorView,
): { line: number; snippet: string }[] {
  const lines = view.state.field(bookmarkField, false);
  if (lines === undefined) return [];
  return lines.map((line) => ({
    line,
    snippet: snippetOf(view.state.doc.line(line).text),
  }));
}
