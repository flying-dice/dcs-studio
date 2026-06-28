<script lang="ts">
  // Project-wide find-in-files overlay (model/studio/core.pds Workbench:
  // OpenSearch / FindInFiles / OpenSearchHit, issue #68). A floating palette
  // over the editor: a query field with case / whole-word / regex toggles, and
  // matches grouped by file with the hit highlighted. Click opens the file and
  // keeps browsing; Up/Down + Enter navigate and dismiss. Esc / click-outside
  // close. The backdrop/Esc/focus pattern follows McpHelpModal; the grouping
  // and open-at-line jump follow Todos.svelte.
  import { tick } from "svelte";
  import { search as appSearch, SearchSession, type FindMatch } from "$lib/search.svelte";
  import { app } from "$lib/state.svelte";
  import { cn, fileName, groupByFile } from "$lib/utils.js";
  import { CaseSensitive, Regex, Search, WholeWord, X } from "@lucide/svelte";

  // Injectable store so /lab/search drives the real grouping, options, nav, and
  // jump from a plain browser (same seam convention as Todos).
  let { store = appSearch }: { store?: SearchSession } = $props();

  let inputEl = $state<HTMLInputElement | null>(null);
  let listEl = $state<HTMLElement | null>(null);

  // store.matches is sorted to match groupByFile's order, so a running flat
  // index lines up with store.selectedIndex for keyboard navigation.
  const flatGroups = $derived.by(() => {
    let i = 0;
    return groupByFile(store.matches, (m) => m.path).map(([path, items]) => ({
      path,
      items: items.map((match) => ({ match, index: i++ })),
    }));
  });
  const fileCount = $derived(flatGroups.length);

  // Focus the query field whenever the overlay opens.
  $effect(() => {
    if (store.open) void tick().then(() => inputEl?.focus());
  });

  // Keep the keyboard-selected row in view.
  $effect(() => {
    store.selectedIndex; // track
    if (!store.open || !listEl) return;
    void tick().then(() => {
      listEl?.querySelector<HTMLElement>('[data-selected="true"]')?.scrollIntoView({
        block: "nearest",
      });
    });
  });

  function returnFocusToEditor() {
    void tick().then(() => {
      document.querySelector<HTMLElement>(".cm-content")?.focus();
    });
  }

  function dismiss() {
    store.close();
    returnFocusToEditor();
  }

  // model OpenSearchHit: open the file at the hit's line/column. A click keeps
  // the overlay open for continued browsing; Enter dismisses it.
  function activate(match: FindMatch, keepOpen: boolean) {
    app.openFile(match.path, fileName(match.path), {
      line: match.line,
      col: match.column,
    });
    if (!keepOpen) dismiss();
  }

  // Arrows/Enter act only while the query field has focus, so they never hijack
  // the editor caret when the overlay is open but the editor is focused (e.g.
  // after a click-to-open). Escape is global (below) so it closes from anywhere.
  function onInputKeydown(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      store.move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      store.move(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const m = store.selected();
      if (m) activate(m, false);
    }
  }

  function onWindowKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      dismiss();
    }
  }

  // Split a hit's line into before / match / after for highlighting, stripping
  // leading indentation (and shifting the match) so it doesn't eat the row.
  function parts(m: FindMatch) {
    const leading = m.text.length - m.text.trimStart().length;
    const text = m.text.slice(leading);
    const start = Math.max(0, m.column - 1 - leading);
    const end = start + m.length;
    return {
      before: text.slice(0, start),
      hit: text.slice(start, end),
      after: text.slice(end),
    };
  }

  const toggle =
    "flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground";
  const toggleOn = "bg-accent text-foreground ring-1 ring-border";
</script>

<svelte:window onkeydown={store.open ? onWindowKeydown : undefined} />

{#if store.open}
  <!-- Click-catcher: an outside click closes the overlay. -->
  <div
    class="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) dismiss();
    }}
  >
    <div
      class="flex max-h-[70vh] w-[min(46rem,92vw)] flex-col overflow-hidden rounded-xl border border-border bg-card text-[12px] shadow-2xl"
      role="dialog"
      tabindex="-1"
      aria-label="Search across files"
      data-testid="search-overlay"
    >
      <!-- Query + options -->
      <div class="flex shrink-0 items-center gap-1.5 border-b border-border/60 px-3 py-2">
        <Search class="size-4 shrink-0 text-muted-foreground" />
        <input
          bind:this={inputEl}
          value={store.query}
          oninput={(e) => store.setQuery(e.currentTarget.value)}
          onkeydown={onInputKeydown}
          type="text"
          placeholder="Search across files…"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          spellcheck="false"
          data-testid="search-input"
          class="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
        />
        <button
          type="button"
          class={cn(toggle, store.options.caseSensitive && toggleOn)}
          title="Match case"
          aria-label="Match case"
          aria-pressed={store.options.caseSensitive}
          data-testid="search-toggle-case"
          onclick={() => store.toggleCaseSensitive()}
        >
          <CaseSensitive class="size-3.5" />
        </button>
        <button
          type="button"
          class={cn(toggle, store.options.wholeWord && toggleOn)}
          title="Match whole word"
          aria-label="Match whole word"
          aria-pressed={store.options.wholeWord}
          data-testid="search-toggle-word"
          onclick={() => store.toggleWholeWord()}
        >
          <WholeWord class="size-3.5" />
        </button>
        <button
          type="button"
          class={cn(toggle, store.options.regex && toggleOn)}
          title="Use regular expression"
          aria-label="Use regular expression"
          aria-pressed={store.options.regex}
          data-testid="search-toggle-regex"
          onclick={() => store.toggleRegex()}
        >
          <Regex class="size-3.5" />
        </button>
        <button
          type="button"
          class={cn(toggle, "ml-0.5")}
          title="Close"
          aria-label="Close search"
          onclick={dismiss}
        >
          <X class="size-3.5" />
        </button>
      </div>

      <!-- Results -->
      <div bind:this={listEl} class="min-h-0 flex-1 overflow-auto px-2 py-1.5">
        {#if store.status === "desktop-only"}
          <div
            class="flex h-24 items-center justify-center px-3 text-center text-muted-foreground"
            data-testid="search-desktop-only"
          >
            Search requires the desktop app.
          </div>
        {:else if store.status === "error"}
          <div
            class="flex h-24 items-center justify-center px-3 text-center text-red-500"
            title={store.errorMessage}
            data-testid="search-invalid"
          >
            Invalid pattern
          </div>
        {:else if store.query.trim() === ""}
          <div class="flex h-24 items-center justify-center text-muted-foreground">
            Type to search across files
          </div>
        {:else if store.status === "searching" && store.matches.length === 0}
          <div class="flex h-24 items-center justify-center text-muted-foreground">
            Searching…
          </div>
        {:else if store.matches.length === 0}
          <div
            class="flex h-24 items-center justify-center text-muted-foreground"
            data-testid="search-empty"
          >
            No results
          </div>
        {:else}
          <div
            class="flex items-center justify-between px-1 pb-1 font-mono text-[10px] text-muted-foreground"
            data-testid="search-summary"
          >
            <span>
              {store.matches.length}
              {store.matches.length === 1 ? "result" : "results"} in {fileCount}
              {fileCount === 1 ? "file" : "files"}
            </span>
          </div>
          {#if store.truncated}
            <div
              class="mb-1 rounded bg-amber-500/15 px-2 py-1 text-[11px] text-amber-600 dark:text-amber-400"
              data-testid="search-truncated"
            >
              Results truncated — refine your search
            </div>
          {/if}
          {#each flatGroups as group (group.path)}
            <div class="mb-1.5" data-testid="search-group">
              <div class="flex items-baseline gap-1.5 px-1 py-0.5 font-medium">
                <span data-testid="search-group-name">{fileName(group.path)}</span>
                <span class="truncate font-mono text-[10px] text-muted-foreground">{group.path}</span>
                <span
                  class="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground"
                  data-testid="search-group-count">{group.items.length}</span
                >
              </div>
              {#each group.items as { match, index } (index)}
                {@const p = parts(match)}
                <button
                  type="button"
                  class={cn(
                    "flex w-full items-center gap-2 rounded px-1.5 py-0.5 text-left hover:bg-accent",
                    index === store.selectedIndex && "bg-accent",
                  )}
                  data-testid="search-result"
                  data-selected={index === store.selectedIndex}
                  onmouseenter={() => store.select(index)}
                  onclick={() => {
                    store.select(index);
                    activate(match, true);
                  }}
                >
                  <span
                    class="w-8 shrink-0 text-right font-mono text-[10px] text-muted-foreground"
                  >
                    {match.line}
                  </span>
                  <span class="truncate font-mono text-[11px]">
                    {p.before}<mark class="rounded-sm bg-amber-400/40 text-foreground">{p.hit}</mark
                    >{p.after}
                  </span>
                </button>
              {/each}
            </div>
          {/each}
        {/if}
      </div>
    </div>
  </div>
{/if}
