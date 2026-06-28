<script lang="ts">
  // Browser test surface for the find-in-files overlay (issue #68): the real
  // FindInFiles store with an injected in-memory backend, the real
  // SearchOverlay, and the real Editor — so the e2e-lang suite asserts the
  // grouping, the match options, the invalid-regex hint, the truncated notice,
  // keyboard navigation, and click-to-jump (a real caret reveal) against the
  // production code, with no Tauri (model/studio/search.pds FindInFiles).
  import { onMount } from "svelte";
  import { app } from "$lib/state.svelte";
  import Editor from "$lib/components/Editor.svelte";
  import EditorTabs from "$lib/components/EditorTabs.svelte";
  import SearchOverlay from "$lib/components/SearchOverlay.svelte";
  import {
    FindInFiles,
    type SearchBackend,
    type SearchMatch,
    type SearchOutcome,
    type SearchQuery,
  } from "$lib/search.svelte";
  import { lang } from "$lib/lang/intel.svelte";
  import { providerFor } from "$lib/lang/registry";

  // A small cap so the e2e can exercise the truncated notice without thousands
  // of rows (the real backend caps at SEARCH_MATCH_CAP = 2000).
  const LAB_CAP = 5;

  // The multibyte prefix on alpha's second line makes byte and UTF-16 columns
  // diverge — navigation only lands on the match if columns count UTF-16 code
  // units end to end. beta's "Gauge" exercises the case-sensitive option;
  // many.lua overflows LAB_CAP for the truncated notice.
  const FILES = new Map<string, string>([
    ["lab/alpha.lua", "local gauge = 1\n-- наводка gauge sensor\n"],
    ["lab/beta.lua", "local Gauge = 2\nprint(gauge)\n"],
    ["lab/many.lua", "needle\n".repeat(LAB_CAP + 3)],
  ]);

  function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // The same matching rule as dcs-studio-project::find, over the in-memory map:
  // literal or regex with case/whole-word options, 1-based UTF-16 column/length
  // (JS string indices are UTF-16 natively), path-then-line order, capped.
  function labSearch(query: SearchQuery): SearchOutcome {
    const core = query.regex ? query.query : escapeRegExp(query.query);
    const pattern = query.wholeWord ? `\\b(?:${core})\\b` : core;
    let re: RegExp;
    try {
      re = new RegExp(pattern, query.caseSensitive ? "g" : "gi");
    } catch (error) {
      // Mirror the Tauri command's Err(SearchError) shape so the store's catch
      // surfaces an inline invalid-pattern hint.
      throw { message: error instanceof Error ? error.message : String(error) };
    }
    const matches: SearchMatch[] = [];
    let truncated = false;
    const sorted = [...FILES].sort(([a], [b]) => a.localeCompare(b));
    outer: for (const [path, text] of sorted) {
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(line)) !== null) {
          if (m[0].length === 0) {
            re.lastIndex += 1; // empty match: advance, never loop
            continue;
          }
          if (matches.length >= LAB_CAP) {
            truncated = true;
            break outer;
          }
          matches.push({
            path,
            line: i + 1,
            column: m.index + 1,
            length: m[0].length,
            text: line,
          });
        }
      }
    }
    matches.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column);
    return { matches, truncated };
  }

  const backend: SearchBackend = {
    search: async (_root, query) => labSearch(query),
  };
  const store = new FindInFiles(backend, true);

  async function readFile(path: string) {
    const text = FILES.get(path);
    if (text === undefined) throw new Error(`no lab file: ${path}`);
    return { kind: "text" as const, text };
  }

  let ready = $state(false);

  onMount(() => {
    void (async () => {
      // Mount the lab files into the hosted lua-analyzer so the editor's
      // lang-intel pump (and its caret readout) has a live session.
      lang.engineStatus = "loading";
      try {
        const provider = providerFor("lab/alpha.lua");
        if (!provider) throw new Error("no provider for lab/alpha.lua");
        await provider.mount(
          [...FILES].map(([path, text]) => ({ path, text })),
          [],
          "lab",
        );
        lang.engineStatus = "ready";
      } catch (error) {
        console.error("language engine failed to mount:", error);
        lang.engineStatus = "failed";
      }
      store.openSearch("lab");
      ready = true;
    })();
  });
</script>

<div class="flex h-screen flex-col gap-2 p-3" data-testid="search-lab">
  <div class="text-xs text-muted-foreground" data-testid="lab-status">
    {ready ? "ready" : "loading"} · engine: {lang.engineStatus} · active:
    {app.fileName || "(none)"}
  </div>
  <div class="flex items-center gap-2 text-xs">
    <button class="rounded border px-2 py-0.5" data-testid="open-search" onclick={() => store.openSearch("lab")}>
      open search
    </button>
    <span data-testid="lab-cursor"
      >cursor: {lang.cursor ? `${lang.cursor.path}:${lang.cursor.offset}` : "-"}</span
    >
  </div>
  <div class="flex h-9 shrink-0 items-center gap-1 overflow-x-auto rounded border px-2">
    <EditorTabs />
  </div>
  <div
    class="min-h-0 flex-1 overflow-hidden rounded border [&_.cm-editor]:h-full"
    data-testid="lab-editor"
  >
    {#if app.filePath}
      <Editor {readFile} />
    {/if}
  </div>
</div>

<SearchOverlay {store} />
