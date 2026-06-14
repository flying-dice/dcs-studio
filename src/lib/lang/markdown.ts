// Render doc-comment markdown (hover bodies, and later completion docs) to
// sanitized HTML. The provider layer hands us markdown text — LSP hover
// MarkupContent is markdown by convention — which we inject via `innerHTML`
// into the CodeMirror tooltip DOM. Sanitize because the source is the user's
// own files and a doc-comment can carry raw HTML.

import { marked } from "marked";
import DOMPurify from "dompurify";

// GFM (tables, fenced code, autolinks); no hard line breaks so prose wraps
// naturally. `headerIds`/`mangle` were removed from marked years ago — nothing
// to disable.
marked.setOptions({ gfm: true, breaks: false });

/**
 * Markdown → sanitized HTML string, ready for `el.innerHTML`.
 *
 * DOMPurify needs a live DOM. This helper is only invoked from the
 * browser-only hover path, but the module can be import-evaluated during
 * SvelteKit SSR — so guard on `window`. The SSR return is never rendered
 * (hover tooltips exist client-side only); the guard just keeps import safe.
 */
export function renderMarkdown(md: string): string {
  const html = marked.parse(md, { async: false }) as string;
  if (typeof window === "undefined") return html;
  return DOMPurify.sanitize(html);
}
