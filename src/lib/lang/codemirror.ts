// CodeMirror wiring for the provider layer: lint (diagnostics + session
// sync), folding, and hover. Providers are async (a hosted LSP over IPC);
// CodeMirror's lint and hover sources accept promises, and the synchronous
// fold service reads ranges cached during each lint pass.

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
import { renderMarkdown } from "./markdown";
import { openLinksExternally } from "../external";
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
/** The live editor view showing `path`, if any — lets the rename apply edits
 * to an open buffer as a transaction (undoable) instead of a disk rewrite. */
export function editorViewFor(path: string): EditorView | undefined {
  return editors.get(path);
}

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
    // Refresh inferred-type ghost text on the same debounced cadence —
    // best-effort: a provider that lacks inlay hints (the LSP server answers
    // textDocument/inlayHint with an error) must NEVER abort the lint pass,
    // or diagnostics would stop painting as squiggles.
    try {
      const hints = (await provider.inlayHints?.(path)) ?? [];
      view.dispatch({ effects: setInlayHints.of(hints) });
    } catch {
      view.dispatch({ effects: setInlayHints.of([]) });
    }
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

  const hover = hoverTooltip(async (view, pos) => {
    const card = await provider.hover(path, pos);
    if (!card) return null;
    // Anchor the tooltip to the whole symbol, not the single character under
    // the pointer. CodeMirror keeps a *ranged* tooltip (`pos != end`) open
    // while the pointer is anywhere over `pos..end` or the card; a point
    // tooltip (`pos == end`) vanishes the instant the pointer drifts one
    // column. So this both widens the hover hitbox to the full identifier and
    // stops the card disappearing as you move toward it. It is hit-testing
    // only — the text stays clickable.
    const word = view.state.wordAt(pos);
    return {
      pos: word?.from ?? pos,
      end: word?.to ?? pos,
      // The arrow (styled in layout.css) sits in the gap between the symbol and
      // the card; CodeMirror folds its rect into the card's hover area, so the
      // pointer never crosses dead space on the way to the card. It is above
      // the text, never over it, so clicking the symbol still works.
      arrow: true,
      create: () => {
        const dom = document.createElement("div");
        dom.className = "cm-dcs-hover";
        // A clean signature line (`local function f(a)`) renders verbatim as a
        // monospace tier. A fenced-markdown hover (rust-analyzer) has no such
        // line — its signature lives in the markdown body — so skip this tier.
        if (card.title) {
          const title = document.createElement("div");
          title.className = "cm-dcs-hover__title";
          title.textContent = card.title;
          dom.appendChild(title);
        }
        // The doc body is markdown — render and sanitize it so headings,
        // code, lists and links read well in the card's prose tier.
        if (card.body) {
          const body = document.createElement("div");
          body.className = "cm-dcs-hover__body";
          body.innerHTML = renderMarkdown(card.body);
          dom.appendChild(body);
        }
        // A markdown link must open in the OS browser, not navigate the Tauri
        // webview away from the editor.
        openLinksExternally(dom);
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
