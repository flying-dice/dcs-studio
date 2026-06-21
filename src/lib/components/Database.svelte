<script lang="ts">
  // Database panel: a READ-ONLY browser over the SQLite files the in-DCS
  // dcs_studio.dll writes under lfs.writedir() (model/studio/database.pds —
  // RefreshDatabases / OpenDatabase / RunQuery). File list → tables → query box
  // → results grid. The reader guards every path read-only and inside the write
  // root; this component only drives it.
  import { Database, RefreshCw, ChevronLeft, Table2, Play, TriangleAlert } from "@lucide/svelte";
  import { database as appDatabase, type DatabaseBrowser } from "$lib/database.svelte";
  import { resultSummary } from "$lib/database-util";
  import { cn, fileName, formatBytes } from "$lib/utils.js";

  // Injectable store (same seam as Todos). `onOpenRecipes` deep-links the empty
  // state into the Recipes SQLite category — wired only once a `recipes` tool
  // exists (issue #49 Part B); until then the empty state is text-only.
  let {
    store = appDatabase,
    onOpenRecipes,
  }: { store?: DatabaseBrowser; onOpenRecipes?: () => void } = $props();
</script>

<div class="flex h-full flex-col text-[12px]" data-testid="database-panel">
  <div class="flex shrink-0 items-center gap-2 border-b border-border/60 px-2 py-1">
    <span class="truncate font-mono text-[10px] text-muted-foreground" title={store.writeDir ?? ""}>
      {store.writeDir ?? "no DCS write dir detected"}
    </span>
    <button
      type="button"
      class="ml-auto flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
      data-testid="database-refresh"
      title="Rediscover databases"
      onclick={() => void store.refresh()}
    >
      <RefreshCw class={cn("size-3.5", store.discovering && "animate-spin")} />
      Refresh
    </button>
  </div>

  <div class="min-h-0 flex-1 overflow-auto">
    {#if store.selected === null}
      <!-- DATABASE LIST -->
      {#if store.files.length === 0}
        <div
          class="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground"
          data-testid="database-empty"
        >
          <Database class="size-7 opacity-60" />
          {#if store.discovering}
            <p>Discovering databases…</p>
          {:else}
            <p>No databases found under the DCS write dir.</p>
            <p class="text-[11px]">
              They appear once <code class="font-mono">dcs_studio.dll</code> has written one.
            </p>
            {#if onOpenRecipes}
              <button
                type="button"
                class="mt-1 rounded border border-border px-2 py-1 text-[11px] text-foreground hover:bg-accent"
                data-testid="database-open-recipes"
                onclick={onOpenRecipes}
              >
                Browse SQLite recipes →
              </button>
            {/if}
          {/if}
        </div>
      {:else}
        <div class="px-2 py-1.5">
          {#each store.files as file (file.path)}
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-accent"
              data-testid="database-file"
              onclick={() => void store.select(file.path)}
            >
              <Database class="size-3.5 shrink-0 text-muted-foreground" />
              <span class="truncate">{file.name}</span>
              <span class="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
                {formatBytes(file.sizeBytes)}
              </span>
            </button>
          {/each}
        </div>
      {/if}
    {:else}
      <!-- OPENED DATABASE -->
      <div class="flex h-full flex-col">
        <div class="flex shrink-0 items-center gap-1.5 border-b border-border/60 px-2 py-1">
          <button
            type="button"
            class="flex items-center gap-0.5 rounded px-1 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            data-testid="database-back"
            onclick={() => store.clearSelection()}
          >
            <ChevronLeft class="size-3.5" />
            Databases
          </button>
          <span class="truncate font-medium">{fileName(store.selected)}</span>
        </div>

        {#if store.error}
          <div
            class="mx-2 mt-1.5 flex items-start gap-1.5 rounded bg-red-500/10 px-2 py-1 text-[11px] text-red-600 dark:text-red-400"
            data-testid="database-error"
          >
            <TriangleAlert class="mt-0.5 size-3.5 shrink-0" />
            <span class="break-words font-mono">{store.error}</span>
          </div>
        {/if}

        <!-- TABLES -->
        <div class="shrink-0 px-2 py-1.5">
          {#if store.loadingTables}
            <span class="text-muted-foreground">Loading tables…</span>
          {:else if store.tables.length === 0}
            <span class="text-muted-foreground">No tables in this database.</span>
          {:else}
            <div class="flex flex-wrap gap-1">
              {#each store.tables as table (table.name)}
                <button
                  type="button"
                  class="flex items-center gap-1 rounded border border-border/70 px-1.5 py-0.5 hover:bg-accent"
                  data-testid="database-table"
                  title={`${table.columnCount} columns · ${table.rowCount} rows`}
                  onclick={() => void store.openTable(table.name)}
                >
                  <Table2 class="size-3 shrink-0 text-muted-foreground" />
                  <span class="truncate">{table.name}</span>
                  <span class="font-mono text-[10px] text-muted-foreground">{table.rowCount}</span>
                </button>
              {/each}
            </div>
          {/if}
        </div>

        <!-- QUERY BOX -->
        <div class="flex shrink-0 items-end gap-1.5 px-2 pb-1.5">
          <textarea
            class="min-h-[3.5rem] flex-1 resize-y rounded border border-border bg-background px-1.5 py-1 font-mono text-[11px] focus:outline-none focus:ring-1 focus:ring-ring"
            placeholder={"SELECT * FROM …"}
            data-testid="database-sql"
            bind:value={store.sql}
          ></textarea>
          <button
            type="button"
            class="flex items-center gap-1 rounded bg-primary px-2 py-1 text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            data-testid="database-run"
            disabled={store.running}
            onclick={() => void store.run()}
          >
            <Play class={cn("size-3.5", store.running && "animate-pulse")} />
            Run
          </button>
        </div>

        <!-- RESULTS -->
        {#if store.result}
          <div class="flex min-h-0 flex-1 flex-col border-t border-border/60">
            <div
              class="shrink-0 px-2 py-0.5 font-mono text-[10px] text-muted-foreground"
              data-testid="database-result-summary"
            >
              {resultSummary(store.result)}
            </div>
            <div class="min-h-0 flex-1 overflow-auto" data-testid="database-result">
              <table class="w-full border-collapse text-[11px]">
                <thead class="sticky top-0 bg-card">
                  <tr>
                    {#each store.result.columns as col, i (i)}
                      <th
                        scope="col"
                        class="border-b border-border/60 px-1.5 py-0.5 text-left font-medium whitespace-nowrap"
                      >
                        {col}
                      </th>
                    {/each}
                  </tr>
                </thead>
                <tbody>
                  {#each store.result.rows as row, ri (ri)}
                    <tr class="hover:bg-accent/50">
                      {#each row.cells as cell, ci (ci)}
                        <td
                          class="max-w-[18rem] truncate border-b border-border/30 px-1.5 py-0.5 font-mono"
                          title={cell}
                        >
                          {cell}
                        </td>
                      {/each}
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>
