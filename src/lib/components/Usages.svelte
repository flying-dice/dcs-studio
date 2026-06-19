<script lang="ts">
  // Usages panel: find-usages results from the language engine, grouped by
  // file (model studio::edit Refactoring — FindUsages / PublishUsages). Mirrors
  // the Problems panel's list mechanics; each row navigates to its occurrence.
  import { Search } from "@lucide/svelte";
  import { app } from "$lib/state.svelte";
  import { usages, type UsageItem } from "$lib/usages.svelte";
  import { fileName, groupByFile } from "$lib/utils.js";

  const groups = $derived.by(() =>
    groupByFile(usages.items, (item) => item.path),
  );

  function open(item: UsageItem) {
    app.openFileAt(item.path, item.offset);
  }
</script>

<div class="flex h-full flex-col text-[12px]" data-testid="usages-panel">
  <div
    class="flex shrink-0 items-center gap-1.5 border-b border-border/60 px-2 py-1 text-muted-foreground"
    data-testid="usages-header"
  >
    <Search class="size-3.5 shrink-0" />
    {#if usages.symbol === null}
      <span>No usages — invoke Find Usages on a symbol</span>
    {:else}
      <span>
        {usages.items.length} usage{usages.items.length === 1 ? "" : "s"} of
        <span class="font-mono text-foreground">{usages.symbol}</span>
      </span>
    {/if}
  </div>
  <div class="min-h-0 flex-1 overflow-auto px-2 py-1.5">
    {#if usages.symbol !== null && usages.items.length === 0}
      <div class="flex h-full items-center justify-center text-muted-foreground">
        No usages found
      </div>
    {:else}
      {#each groups as [path, items] (path)}
        <div class="mb-1.5">
          <div class="flex items-baseline gap-1.5 px-1 py-0.5 font-medium">
            <span>{fileName(path)}</span>
            <span class="truncate font-mono text-[10px] text-muted-foreground">{path}</span>
          </div>
          {#each items as item, index (`${item.path}|${item.offset}|${index}`)}
            <button
              type="button"
              class="flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left hover:bg-accent"
              data-testid="usage-entry"
              onclick={() => open(item)}
            >
              <span class="truncate font-mono">{item.preview || "(line)"}</span>
              <span class="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
                {item.line}:{item.col}
              </span>
            </button>
          {/each}
        </div>
      {/each}
    {/if}
  </div>
</div>
