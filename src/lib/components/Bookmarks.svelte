<script lang="ts">
  // Bookmarks panel: per-project file:line marks, grouped by file with a
  // snippet (model/studio/bookmarks.pds — ToggleBookmark / RemoveBookmark /
  // ClearBookmarks / OpenBookmark). Click navigates to the mark's file and
  // line — the same open+jump mechanics as the Todos / Problems rows.
  import { Trash2, X } from "@lucide/svelte";
  import { app } from "$lib/state.svelte";
  import { bookmarks as appBookmarks, type Bookmark, type BookmarkStore } from "$lib/bookmarks.svelte";
  import { cn, fileName, groupByFile } from "$lib/utils.js";

  // Injectable store so /lab/bookmarks drives the real grouping + navigation
  // from a plain browser (same seam convention as the Todos panel).
  let { store = appBookmarks }: { store?: BookmarkStore } = $props();

  const groups = $derived.by(() => groupByFile(store.entries, (b) => b.path));

  function open(mark: Bookmark) {
    // Same open+navigate mechanics as the Todos panel (model OpenBookmark):
    // a bookmark lands the caret at the start of its line, scrolled into view.
    app.openFile(mark.path, fileName(mark.path), { line: mark.line, col: 1 });
  }
</script>

<div class="flex h-full flex-col text-[12px]" data-testid="bookmarks-panel">
  <div class="flex shrink-0 items-center gap-2 border-b border-border/60 px-2 py-1">
    <span class="font-mono text-[10px] text-muted-foreground" data-testid="bookmarks-count">
      {store.entries.length}
      {store.entries.length === 1 ? "mark" : "marks"}
    </span>
    <button
      type="button"
      class="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
      data-testid="bookmarks-clear"
      title="Clear all bookmarks"
      disabled={store.entries.length === 0}
      onclick={() => store.clear()}
    >
      <Trash2 class="size-3.5" />
      Clear
    </button>
  </div>
  <div class="min-h-0 flex-1 overflow-auto px-2 py-1.5">
    {#if groups.length === 0}
      <div
        class="flex h-full flex-col items-center justify-center gap-1 px-4 text-center text-muted-foreground"
      >
        <span>No bookmarks yet</span>
        <span class="text-[11px]">Click the editor gutter to mark a line.</span>
      </div>
    {:else}
      {#each groups as [path, marks] (path)}
        <div class="mb-1.5" data-testid="bookmark-group">
          <div class="flex items-baseline gap-1.5 px-1 py-0.5 font-medium">
            <span data-testid="bookmark-group-name">{fileName(path)}</span>
            <span class="truncate font-mono text-[10px] text-muted-foreground">{path}</span>
            <span
              class="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground"
              data-testid="bookmark-group-count">{marks.length}</span
            >
          </div>
          {#each marks as mark, index (`${mark.path}|${mark.line}|${index}`)}
            <div class="group flex items-center rounded hover:bg-accent" data-testid="bookmark-entry">
              <button
                type="button"
                class="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-0.5 text-left"
                data-testid="bookmark-open"
                onclick={() => open(mark)}
              >
                <span
                  class="shrink-0 rounded bg-muted px-1 font-mono text-[10px] font-semibold text-muted-foreground"
                  data-testid="bookmark-loc">{mark.line}</span
                >
                <span class="truncate font-mono text-muted-foreground" data-testid="bookmark-snippet">
                  {mark.snippet || "(blank line)"}
                </span>
              </button>
              <button
                type="button"
                class={cn(
                  "mr-1 shrink-0 rounded p-0.5 text-muted-foreground opacity-0",
                  "hover:bg-background hover:text-foreground group-hover:opacity-100",
                )}
                data-testid="bookmark-remove"
                title="Remove bookmark"
                aria-label="Remove bookmark"
                onclick={() => store.remove(mark.path, mark.line)}
              >
                <X class="size-3.5" />
              </button>
            </div>
          {/each}
        </div>
      {/each}
    {/if}
  </div>
</div>
