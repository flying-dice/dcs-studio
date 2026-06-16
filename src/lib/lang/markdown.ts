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
 * Markdown → sanitized HTML string, ready for `el.innerHTML` / `{@html}`.
 *
 * DOMPurify needs a live DOM. Callers now include the Marketplace product page,
 * which feeds UNTRUSTED third-party GitHub READMEs — so this must never emit
 * un-sanitized HTML. Under SSR (no `window`, so no DOMPurify) it FAILS CLOSED,
 * returning empty rather than the raw `marked` output. The app is an
 * `ssr=false` SPA so the live path always sanitizes; this guard ensures a stray
 * SSR/prerender of a consumer can't become a stored-XSS hole in the webview.
 */
export function renderMarkdown(md: string): string {
  if (typeof window === "undefined") return "";
  const html = marked.parse(md, { async: false }) as string;
  return DOMPurify.sanitize(html);
}
