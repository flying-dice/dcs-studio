// Editor debugger decorations: a clickable breakpoint gutter and a
// current-execution-line highlight (+ gutter arrow), IntelliJ-style. The marks
// are driven by the debug-session store: `syncDebugView` pushes the store's
// breakpoint lines + current line into the editor as effects, and a gutter
// mousedown toggles a breakpoint through the store.

import {
  Decoration,
  EditorView,
  gutter,
  GutterMarker,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { debug } from "$lib/debug-session.svelte";

const setBreakpointLines = StateEffect.define<number[]>();
const setCurrentLine = StateEffect.define<number | null>();
const setInlineValues = StateEffect.define<{ line: number; text: string } | null>();

interface DebugMarks {
  breakpoints: number[];
  current: number | null;
}

const debugMarks = StateField.define<DebugMarks>({
  create() {
    return { breakpoints: [], current: null };
  },
  update(value, tr) {
    let next = value;
    for (const effect of tr.effects) {
      if (effect.is(setBreakpointLines)) next = { ...next, breakpoints: effect.value };
      if (effect.is(setCurrentLine)) next = { ...next, current: effect.value };
    }
    return next;
  },
});

class BreakpointMarker extends GutterMarker {
  toDOM(): HTMLElement {
    const dot = document.createElement("span");
    dot.className = "cm-breakpoint";
    return dot;
  }
}
const breakpointMarker = new BreakpointMarker();

class CurrentLineMarker extends GutterMarker {
  toDOM(): HTMLElement {
    const arrow = document.createElement("span");
    arrow.className = "cm-debug-arrow";
    arrow.textContent = "▶";
    return arrow;
  }
}
const currentLineMarker = new CurrentLineMarker();

/** Background highlight on the paused execution line. */
const currentLineHighlight = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(_deco, tr) {
    const marks = tr.state.field(debugMarks);
    const line = marks.current;
    if (line == null || line < 1 || line > tr.state.doc.lines) return Decoration.none;
    const at = tr.state.doc.line(line);
    return Decoration.set([Decoration.line({ class: "cm-debug-current-line" }).range(at.from)]);
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** A dimmed end-of-line hint showing the paused frame's locals. */
class InlineValuesWidget extends WidgetType {
  constructor(private readonly text: string) {
    super();
  }
  eq(other: InlineValuesWidget): boolean {
    return other.text === this.text;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-inline-values";
    span.textContent = this.text;
    return span;
  }
}

/** Inline values at the execution line (IntelliJ-style), driven by effects. */
const inlineValuesField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setInlineValues)) {
        const v = effect.value;
        if (!v || v.line < 1 || v.line > tr.state.doc.lines || !v.text) {
          deco = Decoration.none;
        } else {
          const line = tr.state.doc.line(v.line);
          deco = Decoration.set([
            Decoration.widget({ widget: new InlineValuesWidget(v.text), side: 1 }).range(line.to),
          ]);
        }
      }
    }
    return deco;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** The breakpoint gutter for `path`: a dot per breakpoint line, the arrow on the
 * current line, and a mousedown that toggles a breakpoint through the store. */
function breakpointGutter(path: string): Extension {
  return gutter({
    class: "cm-breakpoint-gutter",
    lineMarker(view, block) {
      const line = view.state.doc.lineAt(block.from).number;
      const marks = view.state.field(debugMarks);
      if (marks.current === line) return currentLineMarker;
      if (marks.breakpoints.includes(line)) return breakpointMarker;
      return null;
    },
    lineMarkerChange(update) {
      return update.startState.field(debugMarks) !== update.state.field(debugMarks);
    },
    initialSpacer() {
      return breakpointMarker;
    },
    domEventHandlers: {
      mousedown(view, block) {
        const line = view.state.doc.lineAt(block.from).number;
        void debug.toggleBreakpoint(path, line);
        return true;
      },
      // Right-click the gutter → edit the line's breakpoint condition.
      contextmenu(_view, block, event) {
        const line = _view.state.doc.lineAt(block.from).number;
        const e = event as MouseEvent;
        e.preventDefault();
        conditionHandler?.(path, line, e.clientX, e.clientY);
        return true;
      },
    },
  });
}

/** Editor-registered callback to open a condition editor at a gutter line. */
let conditionHandler:
  | ((path: string, line: number, x: number, y: number) => void)
  | null = null;

/** Register (or clear) the gutter-right-click condition editor opener. */
export function setConditionHandler(
  fn: ((path: string, line: number, x: number, y: number) => void) | null,
): void {
  conditionHandler = fn;
}

/** The debugger editor extensions for `path`. */
export function debuggerExtension(path: string): Extension {
  return [debugMarks, currentLineHighlight, inlineValuesField, breakpointGutter(path)];
}

/** Push the store's breakpoint lines, current execution line, and inline values
 * for `path` into `view`. A no-op on a state without the debugger field. */
export function syncDebugView(view: EditorView, path: string): void {
  const field = view.state.field(debugMarks, false);
  if (field === undefined) return;
  const line = debug.currentLineFor(path);
  const text =
    line && debug.topLocals.length
      ? debug.topLocals.map((v) => `${v.name} = ${v.value}`).join("    ")
      : "";
  view.dispatch({
    effects: [
      setBreakpointLines.of(debug.linesFor(path)),
      setCurrentLine.of(line),
      setInlineValues.of(line && text ? { line, text } : null),
    ],
  });
}
