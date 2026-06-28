<script lang="ts">
  // Floating project-wide search overlay (model/studio/search.pds FindInFiles,
  // issue #68): a top-anchored palette over the editor. Reuses the
  // backdrop + Esc-close + click-outside pattern from McpHelpModal. Results
  // group by file (same grouping as the Todos/Problems panels); Up/Down move a
  // selection, Enter opens it and closes, a click opens it and keeps the
  // overlay open. The match span is highlighted via the backend's UTF-16
  // column/length. The store is injectable so /lab/search drives the real flow
  // in a plain browser.
  import { Search, X, CaseSensitive, WholeWord, Regex, CornerDownLeft } from "@lucide/svelte";
  import { app } from "$lib/state.svelte";
  import { find, type FindInFiles, type SearchMatch } from "$lib/search.svelte";
  import { highlightSplit } from "$lib/search-highlight";
  import { cn, fileName } from "$lib/utils";

  let { store = find }: { store?: FindInFiles } = $props();

  // Navigation lives in the component (same convention as Todos.svelte), so the
  // store never depends on `app`. A click keeps the overlay open for continued
  // browsing (model OpenMatch); Enter opens and closes.
  function openHit(hit: SearchMatch, closeAfter: boolean) {
    app.openFile(hit.path, fileName(hit.path), { line: hit.line, col: hit.column });
    if (closeAfter) store.dismiss();
  }

  type Row =
    | { kind: "file"; path: string; count: number }
    | { kind: "match"; hit: SearchMatch; index: number };

  // Walk store.matches in the backend's path-then-line order and open a file
  // header whenever the path changes. The flat `index` IS the position in
  // store.matches, so keyboard selection, scroll-into-view, and Enter all agree
  // — no client re-sort (e.g. localeCompare) that could diverge from the
  // backend's byte ordering and desync the selection.
  const rows = $derived.by<Row[]>(() => {
    const counts = new Map<string, number>();
    for (const m of store.matches) counts.set(m.path, (counts.get(m.path) ?? 0) + 1);
    const out: Row[] = [];
    let lastPath: string | null = null;
    store.matches.forEach((hit, index) => {
      if (hit.path !== lastPath) {
        out.push({ kind: "file", path: hit.path, count: counts.get(hit.path) ?? 0 });
        lastPath = hit.path;
      }
      out.push({ kind: "match", hit, index });
    });
    return out;
  });

  const fileCount = $derived(new Set(store.matches.map((m) => m.path)).size);

  let inputEl = $state<HTMLInputElement | null>(null);
  let listEl = $state<HTMLElement | null>(null);

  // Focus (and select) the query field whenever the overlay opens, so the
  // overlay appears with the query field focused (AC) and re-opening replaces
  // the prior query.
  $effect(() => {
    if (store.open && inputEl) {
      inputEl.focus();
      inputEl.select();
    }
  });

  // Keep the keyboard-selected row in view as Up/Down moves it.
  $effect(() => {
    const i = store.selected;
    if (i < 0 || !listEl) return;
    listEl.querySelector(`[data-row-index="${i}"]`)?.scrollIntoView({ block: "nearest" });
  });

  function onInputKeydown(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      store.move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      store.move(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = store.current();
      if (hit) openHit(hit, true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      store.dismiss();
    }
  }

  // Backstop Esc when focus has left the input (e.g. after a click).
  function onWindowKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") store.dismiss();
  }
</script>

<svelte:window onkeydown={store.open ? onWindowKeydown : undefined} />

{#if store.open}
  <div
    class="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[12vh] backdrop-blur-sm"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) store.dismiss();
    }}
  >
    <div
      class="flex max-h-[70vh] w-[min(44rem,92vw)] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
      role="dialog"
      aria-modal="true"
      aria-label="Find in files"
      data-testid="search-overlay"
    >
      {#if !store.available}
        <!-- Browser fallback: no desktop backend to walk the workspace. -->
        <div
          class="flex items-center gap-2 p-5 text-[13px] text-muted-foreground"
          data-testid="search-unavailable"
        >
          <Search class="size-4 shrink-0" />
          Search requires the desktop app.
        </div>
      {:else}
        <!-- Query row -->
        <div class="flex items-center gap-2 border-b border-border/60 px-3 py-2">
          <Search class="size-4 shrink-0 text-muted-foreground" />
          <input
            bind:this={inputEl}
            class="min-w-0 flex-1 bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none"
            placeholder="Search across files…"
            value={store.query}
            oninput={(e) => store.setQuery(e.currentTarget.value)}
            onkeydown={onInputKeydown}
            spellcheck="false"
            autocapitalize="off"
            autocomplete="off"
            data-testid="search-input"
          />
          <!-- Match options -->
          <div class="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              class={cn(
                "rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground",
                store.caseSensitive && "bg-accent text-foreground ring-1 ring-border",
              )}
              aria-label="Match case"
              aria-pressed={store.caseSensitive}
              title="Match case"
              onclick={() => store.toggleCaseSensitive()}
              data-testid="search-opt-case"
            >
              <CaseSensitive class="size-4" />
            </button>
            <button
              type="button"
              class={cn(
                "rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground",
                store.wholeWord && "bg-accent text-foreground ring-1 ring-border",
              )}
              aria-label="Match whole word"
              aria-pressed={store.wholeWord}
              title="Match whole word"
              onclick={() => store.toggleWholeWord()}
              data-testid="search-opt-word"
            >
              <WholeWord class="size-4" />
            </button>
            <button
              type="button"
              class={cn(
                "rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground",
                store.regex && "bg-accent text-foreground ring-1 ring-border",
              )}
              aria-label="Use regular expression"
              aria-pressed={store.regex}
              title="Use regular expression"
              onclick={() => store.toggleRegex()}
              data-testid="search-opt-regex"
            >
              <Regex class="size-4" />
            </button>
          </div>
          <button
            type="button"
            class="shrink-0 text-muted-foreground hover:text-foreground"
            aria-label="Close search"
            onclick={() => store.dismiss()}
            data-testid="search-close"
          >
            <X class="size-4" />
          </button>
        </div>

        <!-- Status row: count, truncated notice, invalid hint -->
        <div class="flex items-center gap-2 border-b border-border/60 px-3 py-1 text-[11px]">
          {#if store.invalidPattern}
            <span class="text-red-500" title={store.invalidPattern} data-testid="search-invalid">
              Invalid pattern
            </span>
          {:else if store.query.trim() === ""}
            <span class="text-muted-foreground">Type to search the workspace.</span>
          {:else}
            <span class="font-mono text-muted-foreground" data-testid="search-count">
              {store.matches.length}
              {store.matches.length === 1 ? "result" : "results"}
              in {fileCount}
              {fileCount === 1 ? "file" : "files"}
            </span>
            {#if store.truncated}
              <span class="text-amber-500" data-testid="search-truncated">
                · results truncated — refine your search
              </span>
            {/if}
          {/if}
        </div>

        <!-- Results -->
        <div bind:this={listEl} class="min-h-0 flex-1 overflow-auto px-1.5 py-1.5 text-[12px]">
          {#if store.invalidPattern || store.query.trim() === ""}
            <!-- nothing to list -->
          {:else if store.matches.length === 0}
            <div
              class="flex h-16 items-center justify-center text-muted-foreground"
              data-testid="search-empty"
            >
              {store.searching ? "Searching…" : "No results"}
            </div>
          {:else}
            {#each rows as row (row.kind === "file" ? `f:${row.path}` : `m:${row.index}`)}
              {#if row.kind === "file"}
                <div class="mt-1.5 flex items-baseline gap-1.5 px-1 py-0.5 font-medium first:mt-0">
                  <span data-testid="search-group-name">{fileName(row.path)}</span>
                  <span class="truncate font-mono text-[10px] text-muted-foreground">{row.path}</span>
                  <span
                    class="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground"
                    data-testid="search-group-count">{row.count}</span
                  >
                </div>
              {:else}
                {@const split = highlightSplit(row.hit.text, row.hit.column, row.hit.length)}
                <button
                  type="button"
                  data-row-index={row.index}
                  data-selected={row.index === store.selected}
                  class={cn(
                    "flex w-full items-center gap-2 rounded px-1.5 py-0.5 text-left hover:bg-accent",
                    row.index === store.selected && "bg-accent",
                  )}
                  onmouseenter={() => (store.selected = row.index)}
                  onclick={() => openHit(row.hit, false)}
                  data-testid="search-result"
                >
                  <span class="min-w-0 flex-1 truncate font-mono" data-testid="search-result-text">
                    {split.before}<mark class="rounded-[2px] bg-amber-400/40 text-foreground"
                      >{split.match}</mark
                    >{split.after}
                  </span>
                  <span class="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
                    {row.hit.line}:{row.hit.column}
                  </span>
                </button>
              {/if}
            {/each}
          {/if}
        </div>

        <!-- Footer hint -->
        <div
          class="flex items-center gap-3 border-t border-border/60 px-3 py-1 text-[10px] text-muted-foreground"
        >
          <span class="flex items-center gap-1"><CornerDownLeft class="size-3" /> open</span>
          <span>↑↓ navigate</span>
          <span>Esc dismiss</span>
        </div>
      {/if}
    </div>
  </div>
{/if}
