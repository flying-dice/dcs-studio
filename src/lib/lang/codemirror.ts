// CodeMirror wiring for the provider layer: lint (diagnostics + session
// sync), folding, and hover. Providers are async (LSP over IPC, or wasm
// in-page); CodeMirror's lint and hover sources accept promises, and the
// synchronous fold service reads ranges cached during each lint pass.

import { foldService } from "@codemirror/language";
import { linter, type Diagnostic as CmDiagnostic } from "@codemirror/lint";
import type { Extension } from "@codemirror/state";
import { hoverTooltip } from "@codemirror/view";
import { lang } from "./intel.svelte";
import { providerFor } from "./registry";
import type { Diagnostic, FoldingRange } from "./provider";

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
