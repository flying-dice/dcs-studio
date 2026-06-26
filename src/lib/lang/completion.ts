// CodeMirror autocomplete wiring for the LanguageProvider seam: it turns the
// engine's `CompletionItem` DTOs into CodeMirror completions and drives them
// from a `LanguageProvider.complete` query. Kept free of the editor's stateful
// glue (codemirror.ts) and the runes store, so the mapping is unit tested in a
// plain node env (completion.test.ts) — the load-bearing logic of this slice.

import {
  snippetCompletion,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import type { CompletionItem, LanguageProvider } from "./provider";

/** Our completion `kind` → a CodeMirror completion `type` (drives the icon):
 * a `field` shows as a property; everything else keeps its like-named type. */
function cmCompletionType(kind: string): string {
  if (kind === "function") return "function";
  if (kind === "field") return "property";
  return "variable";
}

/**
 * One engine completion → a CodeMirror `Completion`. A function carries a
 * `${1:param}` snippet body, so it applies through `snippetCompletion` —
 * CodeMirror's field syntax is the same `${n:name}` the engine emits, so the
 * `insertText` passes through verbatim. A plain item inserts its `insertText`.
 * `detail` is the signature line; `info` the `---` doc run.
 */
export function toCmCompletion(item: CompletionItem): Completion {
  const completion: Completion = {
    label: item.label,
    type: cmCompletionType(item.kind),
    detail: item.detail || undefined,
    info: item.documentation || undefined,
  };
  if (item.insertTextFormat === "snippet" && item.insertText) {
    return snippetCompletion(item.insertText, completion);
  }
  return { ...completion, apply: item.insertText || item.label };
}

/** An identifier: a leading letter/underscore then word characters. */
const IDENTIFIER = /[A-Za-z_]\w*/;
/** A member access: a `.` then the (possibly empty) member prefix. */
const MEMBER_ACCESS = /\.\s*\w*$/;

/**
 * A CodeMirror completion source backed by the provider's `complete` query.
 * Fires on an explicit invoke (Ctrl-Space), mid-identifier typing, or right
 * after a `.` member access; it declines elsewhere so the popup never opens on
 * an arbitrary keystroke. The server returns the context's candidate set
 * already prefix-filtered; `validFor` lets CodeMirror narrow it in place as
 * more identifier characters arrive, with no re-query (`isIncomplete = false`).
 */
export function luaCompletionSource(
  provider: LanguageProvider,
  path: string,
): (context: CompletionContext) => Promise<CompletionResult | null> {
  return async (context) => {
    const word = context.matchBefore(IDENTIFIER);
    const member = context.matchBefore(MEMBER_ACCESS);
    if (!context.explicit && !member && !word) return null;
    const items = await provider.complete(path, context.pos);
    if (items.length === 0) return null;
    return {
      from: word ? word.from : context.pos,
      options: items.map(toCmCompletion),
      validFor: /^\w*$/,
    };
  };
}

/**
 * Open completion the moment a `.` is typed — the member trigger character.
 * CodeMirror auto-opens on identifier characters but not punctuation, so the
 * dot needs an explicit nudge. Deferred to a microtask: dispatching
 * `startCompletion` synchronously from inside an update is a re-entrancy error.
 */
export const memberCompletionTrigger = EditorView.updateListener.of((update) => {
  if (!update.docChanged) return;
  let typedDot = false;
  for (const transaction of update.transactions) {
    if (!transaction.isUserEvent("input.type")) continue;
    transaction.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
      if (inserted.length > 0 && inserted.sliceString(inserted.length - 1) === ".") {
        typedDot = true;
      }
    });
  }
  if (typedDot) {
    const { view } = update;
    void Promise.resolve().then(() => startCompletion(view));
  }
});
