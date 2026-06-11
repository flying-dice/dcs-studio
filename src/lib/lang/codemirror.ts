// CodeMirror wiring for the provider layer: lint (diagnostics + session
// sync), folding, and hover. Hand-wired — there is no transport, so the
// provider's synchronous queries plug straight into CodeMirror's sources.

import { foldService } from "@codemirror/language";
import { linter, type Diagnostic as CmDiagnostic } from "@codemirror/lint";
import type { Extension, Text } from "@codemirror/state";
import { hoverTooltip } from "@codemirror/view";
import { lang } from "./intel.svelte";
import { providerFor } from "./registry";
import type { Diagnostic, FoldingRange } from "./provider";

/**
 * Language-intelligence extensions for `path`; `[]` when no provider
 * claims the file. The lint source doubles as the didChange pump: its
 * debounce feeds the session (`updateSource`) before pulling findings.
 */
export function langIntelFor(path: string | null): Extension {
  if (!path) return [];
  const provider = providerFor(path);
  if (!provider) return [];

  const lintSource = linter((view) => {
    const text = view.state.doc.toString();
    lang.updateSource(path, text);
    return lang
      .fileDiagnostics(path)
      .map((d) => toCmDiagnostic(d, view.state.doc.length));
  });

  // The fold service is queried per foldable line; cache the engine's
  // ranges per document snapshot (Text values are immutable, so a WeakMap
  // key is exactly "this doc version").
  const foldCache = new WeakMap<Text, FoldingRange[]>();
  const folding = foldService.of((state, lineStart, lineEnd) => {
    let ranges = foldCache.get(state.doc);
    if (!ranges) {
      ranges = provider.foldingRanges(path);
      foldCache.set(state.doc, ranges);
    }
    for (const range of ranges) {
      if (range.start >= lineStart && range.start <= lineEnd) {
        const end = Math.min(range.end, state.doc.length);
        // Folding hides everything after the line of the opener up to the
        // range's end; single-line ranges fold nothing.
        if (end > lineEnd) return { from: lineEnd, to: end };
      }
    }
    return null;
  });

  const hover = hoverTooltip((view, pos) => {
    const card = provider.hover(path, pos);
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

  return [lintSource, folding, hover];
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
