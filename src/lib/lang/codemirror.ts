// CodeMirror wiring for the provider layer: lint (diagnostics + session
// sync), folding, and hover. Providers are async (LSP over IPC, or wasm
// in-page); CodeMirror's lint and hover sources accept promises, and the
// synchronous fold service reads ranges cached during each lint pass.

import { foldService } from "@codemirror/language";
import {
  linter,
  forceLinting,
  type Diagnostic as CmDiagnostic,
} from "@codemirror/lint";
import { StateEffect, StateField, type Extension, type Range } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  hoverTooltip,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import { lang } from "./intel.svelte";
import { providerFor } from "./registry";
import type { Diagnostic, FoldingRange, InlayHint } from "./provider";

// ---- inferred-type inlay hints (ghost text) --------------------------------

/** A dimmed `: <type>` label drawn inline after a binding, like VS Code. */
class InlayHintWidget extends WidgetType {
  constructor(private readonly label: string) {
    super();
  }
  eq(other: InlayHintWidget): boolean {
    return other.label === this.label;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-inlay-hint";
    span.textContent = this.label;
    return span;
  }
}

/** Replace the file's inlay hints with a fresh set (from the lint pass). */
const setInlayHints = StateEffect.define<InlayHint[]>();

/** Holds the inlay-hint decorations; remaps across edits, swaps on effect. */
const inlayHintField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setInlayHints)) {
        const docLength = tr.state.doc.length;
        const marks: Range<Decoration>[] = effect.value
          .filter((hint) => hint.offset >= 0 && hint.offset <= docLength)
          .map((hint) =>
            Decoration.widget({
              widget: new InlayHintWidget(hint.label),
              side: 1,
            }).range(hint.offset),
          );
        deco = Decoration.set(marks, true);
      }
    }
    return deco;
  },
  provide: (field) => EditorView.decorations.from(field),
});

// Live editor views by file path, registered while a langIntel extension
// is mounted — the Structure panel's symbol navigation dispatches here.
const editors = new Map<string, EditorView>();

/**
 * Force a re-lint of every live editor so diagnostics that arrived after the
 * last lint pass — rust-analyzer's lagging first index and cargo check
 * publish through the late push channel — paint as squiggles without another
 * keystroke (model/studio/lang.pds `LateDiagnosticsPaintWithoutEditing`). The
 * forced lint's `updateSource` is a no-op for the unchanged buffer (the LSP
 * providers skip an identical re-send), so this can't loop.
 */
function repaintDiagnostics(): void {
  for (const view of editors.values()) forceLinting(view);
}

// One subscription for the whole editor layer: intel pings on every late
// publish. Registered at module load (intel never imports this file — the
// dependency points one way), so it survives across tab mounts.
lang.onDiagnosticsRepaint(repaintDiagnostics);

/** How long a caret must rest before the Structure highlight follows. */
const CURSOR_DEBOUNCE_MS = 150;

/**
 * Land the caret of `path`'s open editor on `offset` and scroll it into
 * view (model/studio/lang.pds `OpenSymbol`). False when no live editor
 * shows the file.
 */
export function revealInEditor(path: string, offset: number): boolean {
  const view = editors.get(path);
  if (!view) return false;
  const anchor = Math.min(Math.max(offset, 0), view.state.doc.length);
  view.dispatch({
    selection: { anchor },
    effects: EditorView.scrollIntoView(anchor, { y: "center" }),
  });
  view.focus();
  return true;
}

/**
 * Language-intelligence extensions for `path`; `[]` when no provider
 * claims the file. The lint source doubles as the didChange pump: its
 * debounce feeds the session (`updateSource`), refreshes the fold cache,
 * then maps findings to squiggles.
 */
export function langIntelFor(path: string | null): Extension {
  if (!path) return [];
  const provider = providerFor(path);
  if (!provider) return [];

  // The fold service is queried synchronously per foldable line; the lint
  // pass refreshes this cache after every (debounced) change.
  let foldCache: FoldingRange[] = [];

  const lintSource = linter(async (view) => {
    const text = view.state.doc.toString();
    await lang.updateSource(path, text);
    foldCache = await provider.foldingRanges(path);
    // Refresh inferred-type ghost text on the same debounced cadence; a
    // provider without inferred-type support simply yields none.
    const hints = (await provider.inlayHints?.(path)) ?? [];
    view.dispatch({ effects: setInlayHints.of(hints) });
    return lang
      .fileDiagnostics(path)
      .map((d) => toCmDiagnostic(d, view.state.doc.length));
  });

  const folding = foldService.of((state, lineStart, lineEnd) => {
    for (const range of foldCache) {
      if (range.start >= lineStart && range.start <= lineEnd) {
        const end = Math.min(range.end, state.doc.length);
        // Folding hides everything after the line of the opener up to the
        // range's end; single-line ranges fold nothing.
        if (end > lineEnd) return { from: lineEnd, to: end };
      }
    }
    return null;
  });

  const hover = hoverTooltip(async (_view, pos) => {
    const card = await provider.hover(path, pos);
    if (!card) return null;
    return {
      pos,
      create: () => {
        const dom = document.createElement("div");
        dom.className = "cm-dcs-hover";
        const title = document.createElement("strong");
        title.textContent = card.title;
        dom.appendChild(title);
        if (card.body) {
          const body = document.createElement("div");
          body.textContent = card.body;
          dom.appendChild(body);
        }
        return { dom };
      },
    };
  });

  // Registers the live view for symbol navigation and publishes the caret
  // (debounced) so the Structure panel highlights the enclosing symbol.
  const cursorTracker = ViewPlugin.define((view) => {
    editors.set(path, view);
    let timer: ReturnType<typeof setTimeout> | undefined;
    return {
      update(update) {
        if (!update.selectionSet) return;
        const offset = update.state.selection.main.head;
        clearTimeout(timer);
        timer = setTimeout(() => {
          lang.cursor = { path, offset };
        }, CURSOR_DEBOUNCE_MS);
      },
      destroy() {
        clearTimeout(timer);
        if (editors.get(path) === view) editors.delete(path);
        if (lang.cursor?.path === path) lang.cursor = null;
      },
    };
  });

  return [lintSource, folding, hover, cursorTracker, inlayHintField];
}

function toCmDiagnostic(d: Diagnostic, docLength: number): CmDiagnostic {
  // Clamp into the current doc (the engine may lag a keystroke), then
  // widen zero-length spans by one char where possible so the squiggle is
  // visible. `from <= to` holds by construction.
  const from = Math.min(d.start, docLength);
  const to = Math.max(from, Math.min(Math.max(d.end, from + 1), docLength));
  return {
    from,
    to,
    severity: d.severity === "warning" ? "warning" : d.severity === "info" ? "info" : "error",
    message: `${d.message} [${d.code}]`,
  };
}
