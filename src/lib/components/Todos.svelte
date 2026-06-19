<script lang="ts">
  // Todos panel: workspace comment tags (TODO/FIXME/HACK/XXX), grouped by
  // file with tag chips (model/studio/todos.pds — RefreshAll / RefreshFile /
  // OpenTodo). Click navigates to the tag's file, line, and column — the
  // same open+jump mechanics as the Problems panel.
  import { RefreshCw } from "@lucide/svelte";
  import { app } from "$lib/state.svelte";
  import { todos as appTodos, type TodoEntry, type TodoScanner } from "$lib/todos.svelte";
  import { cn, fileName, groupByFile } from "$lib/utils.js";

  // Injectable store so /lab/todos drives the real grouping, splice, and
  // navigation from a plain browser (same seam convention as Editor's
  // readFile).
  let { store = appTodos }: { store?: TodoScanner } = $props();

  const groups = $derived.by(() => groupByFile(store.entries, (e) => e.path));

  const TAG_STYLES: Record<string, string> = {
    TODO: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
    FIXME: "bg-red-500/15 text-red-600 dark:text-red-400",
    HACK: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    XXX: "bg-purple-500/15 text-purple-600 dark:text-purple-400",
  };

  function open(entry: TodoEntry) {
    // Same open+navigate mechanics as the Problems panel (model OpenTodo).
    app.openFile(entry.path, fileName(entry.path), {
      line: entry.line,
      col: entry.column,
    });
  }
</script>

<div class="flex h-full flex-col text-[12px]" data-testid="todos-panel">
  <div class="flex shrink-0 items-center gap-2 border-b border-border/60 px-2 py-1">
    <span class="font-mono text-[10px] text-muted-foreground" data-testid="todos-count">
      {store.entries.length}
      {store.entries.length === 1 ? "item" : "items"}
    </span>
    <button
      type="button"
      class="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
      data-testid="todos-refresh"
      title="Rescan workspace"
      onclick={() => void store.refreshManually()}
    >
      <RefreshCw class={cn("size-3.5", store.scanning && "animate-spin")} />
      Refresh
    </button>
  </div>
  <div class="min-h-0 flex-1 overflow-auto px-2 py-1.5">
    {#if groups.length === 0}
      <div class="flex h-full items-center justify-center text-muted-foreground">
        {store.scanning ? "Scanning…" : "No TODO comments found"}
      </div>
    {:else}
      {#each groups as [path, entries] (path)}
        <div class="mb-1.5" data-testid="todo-group">
          <div class="flex items-baseline gap-1.5 px-1 py-0.5 font-medium">
            <span data-testid="todo-group-name">{fileName(path)}</span>
            <span class="truncate font-mono text-[10px] text-muted-foreground">{path}</span>
            <span
              class="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground"
              data-testid="todo-group-count">{entries.length}</span
            >
          </div>
          {#each entries as entry, index (`${entry.path}|${entry.line}|${entry.tag}|${index}`)}
            <button
              type="button"
              class="flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left hover:bg-accent"
              data-testid="todo-entry"
              onclick={() => open(entry)}
            >
              <span
                class={cn(
                  "shrink-0 rounded px-1 font-mono text-[10px] font-semibold",
                  TAG_STYLES[entry.tag] ?? "bg-muted text-muted-foreground",
                )}
                data-testid="todo-tag">{entry.tag}</span
              >
              <span class="truncate" data-testid="todo-text">{entry.text}</span>
              <span class="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
                {entry.line}:{entry.column}
              </span>
            </button>
          {/each}
        </div>
      {/each}
    {/if}
  </div>
</div>
