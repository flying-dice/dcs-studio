<script lang="ts">
  // Browser test surface for the find-in-files overlay (issue #68): the real
  // SearchSession store with an injected in-memory backend, the real
  // SearchOverlay, and the real Editor — so the e2e-lang suite asserts the
  // grouped results, the case/word/regex toggles, the invalid-regex hint, the
  // truncation notice, keyboard nav, and click-to-jump (a real caret reveal) —
  // no Tauri, no DCS (model/studio/core.pds SearchAcrossWorkspace,
  // SearchResultNavigatesEditor, InvalidSearchPatternShowsHint,
  // SearchCapTruncatesWithNotice).
  import { onMount } from "svelte";
  import { app } from "$lib/state.svelte";
  import Editor from "$lib/components/Editor.svelte";
  import EditorTabs from "$lib/components/EditorTabs.svelte";
  import SearchOverlay from "$lib/components/SearchOverlay.svelte";
  import {
    SearchSession,
    type FindMatch,
    type FindResult,
    type SearchBackend,
    type SearchOptions,
  } from "$lib/search.svelte";
  import { lang } from "$lib/lang/intel.svelte";
  import { providerFor } from "$lib/lang/registry";

  // A small cap so the truncation UI is exercised cheaply (the production cap is
  // SEARCH_MATCH_CAP = 2000, tested in dcs-studio-project::find).
  const LAB_CAP = 25;

  function dupBody() {
    let s = "";
    for (let i = 1; i <= 30; i++) s += `-- dup line ${i}\n`;
    return s;
  }

  // alpha's line 4 has a multibyte (Cyrillic) prefix so byte and UTF-16 offsets
  // diverge — a click only lands on the match if columns count UTF-16.
  const FILES = new Map<string, string>([
    [
      "lab/alpha.lua",
      '-- alpha module\nlocal needle = 1\nprint("needle")\n-- наводка needle here\n',
    ],
    ["lab/beta.lua", "local Needle = 2\nfunction needleHelper() end\n"],
    ["lab/dup.lua", dupBody()],
  ]);

  // The same matcher as dcs-studio-project::find, over the in-memory map:
  // literal vs regex, whole-word via \b(?:…)\b, case-insensitive by default,
  // zero-width matches skipped, 1-based UTF-16 column/length (JS strings are
  // UTF-16 natively), capped with a truncated flag.
  function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  function buildRegex(query: string, o: SearchOptions): RegExp {
    const core = o.regex ? query : escapeRegex(query);
    const pattern = o.wholeWord ? `\\b(?:${core})\\b` : core;
    return new RegExp(pattern, `g${o.caseSensitive ? "" : "i"}`); // throws → invalid
  }
  function findInMemory(query: string, options: SearchOptions): FindResult {
    if (query === "") return { matches: [], truncated: false };
    const re = buildRegex(query, options);
    const matches: FindMatch[] = [];
    let truncated = false;
    outer: for (const [path, text] of FILES) {
      const lines = text.split("\n");
      for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(line)) !== null) {
          if (m[0].length === 0) {
            re.lastIndex++;
            continue;
          }
          if (matches.length >= LAB_CAP) {
            truncated = true;
            break outer;
          }
          matches.push({
            path,
            line: li + 1,
            column: m.index + 1,
            length: m[0].length,
            text: line,
          });
        }
      }
    }
    matches.sort(
      (a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column,
    );
    return { matches, truncated };
  }

  const backend: SearchBackend = {
    // Async like the Tauri command; buildRegex throws on an invalid pattern, so
    // the returned promise rejects and the store surfaces the inline hint.
    find: async (_root, query, options) => findInMemory(query, options),
  };
  const store = new SearchSession(backend);

  async function readFile(path: string) {
    const text = FILES.get(path);
    if (text === undefined) throw new Error(`no lab file: ${path}`);
    return { kind: "text" as const, text };
  }

  let ready = $state(false);

  onMount(() => {
    void (async () => {
      // Mount the lab files into the hosted lua-analyzer so the editor's caret
      // readout has a live session (mirrors /lab/todos).
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
    <button
      class="rounded border px-2 py-0.5"
      data-testid="open-search"
      onclick={() => store.openOverlay("lab")}
    >
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
