<script lang="ts">
  // Shared Markdown reading-pane. One place that turns Markdown into a styled,
  // sanitized DOM: `renderMarkdown` (marked + DOMPurify) for the HTML, plus the
  // project's prose typography (there is no Tailwind typography plugin). Both
  // the Marketplace product README — which renders UNTRUSTED third-party GitHub
  // READMEs — and the Help → Guides viewer (issue #72, vendored guides) render
  // through here, so sanitization and styling come from a single source.
  import { renderMarkdown } from "$lib/lang/markdown";
  import { openContentLinksExternally } from "$lib/external";

  let { source, class: className = "" }: { source: string; class?: string } =
    $props();
</script>

<!-- This is rendered content, not navigation: a bare <a> click would navigate
     the Tauri webview off the editor, so openContentLinksExternally intercepts
     every link (event-delegated, so it survives content swaps) — http(s)/mailto
     opens in the OS browser, fragments/relative links are swallowed. -->
<!-- eslint-disable-next-line svelte/no-at-html-tags — sanitized by renderMarkdown (DOMPurify) -->
<div use:openContentLinksExternally class={`prose ${className}`}>{@html renderMarkdown(source)}</div>

<style>
  /* Minimal Markdown typography (no Tailwind typography plugin in the project). */
  .prose :global(h1),
  .prose :global(h2),
  .prose :global(h3) {
    font-weight: 600;
    margin: 1.2em 0 0.5em;
    line-height: 1.25;
  }
  .prose :global(h1) { font-size: 1.4em; }
  .prose :global(h2) { font-size: 1.2em; }
  .prose :global(h3) { font-size: 1.05em; }
  .prose :global(p) { margin: 0.6em 0; }
  .prose :global(ul),
  .prose :global(ol) { margin: 0.6em 0; padding-left: 1.4em; }
  .prose :global(ul) { list-style: disc; }
  .prose :global(ol) { list-style: decimal; }
  .prose :global(li) { margin: 0.2em 0; }
  .prose :global(a) { color: var(--foreground); text-decoration: underline; text-underline-offset: 2px; }
  .prose :global(code) {
    font-family: var(--font-mono);
    font-size: 0.9em;
    background: var(--muted);
    padding: 0.1em 0.35em;
    border-radius: 4px;
  }
  .prose :global(pre) {
    background: var(--muted);
    padding: 0.8em;
    border-radius: 8px;
    overflow-x: auto;
    margin: 0.8em 0;
  }
  .prose :global(pre code) { background: transparent; padding: 0; }
  .prose :global(img) { max-width: 100%; height: auto; }
  .prose :global(blockquote) {
    border-left: 3px solid var(--border);
    padding-left: 0.9em;
    color: var(--muted-foreground);
    margin: 0.8em 0;
  }
  .prose :global(table) { border-collapse: collapse; margin: 0.8em 0; }
  .prose :global(th),
  .prose :global(td) { border: 1px solid var(--border); padding: 0.3em 0.6em; }
  .prose :global(hr) { border: none; border-top: 1px solid var(--border); margin: 1.2em 0; }
</style>
