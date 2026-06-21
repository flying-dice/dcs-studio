<script lang="ts">
  // The interactive object explorer (model/studio/debug.pds DebugController.
  // Inspect): evaluate a Lua expression against the LIVE sim — no breakpoint,
  // no debug session — and drill into the result as a lazy, expandable tree
  // (the same VariableNode the debugger uses), backed by the sim's persistent
  // inspection registry. Each entry stays explorable until you clear.
  import { debug, type EvalResult } from "$lib/debug-session.svelte";
  import VariableNode from "./VariableNode.svelte";
  import { Telescope, CornerDownLeft, Trash2, Search, X } from "@lucide/svelte";

  interface Entry {
    id: number;
    expr: string;
    result: EvalResult;
  }

  let input = $state("");
  let search = $state("");
  let log = $state<Entry[]>([]);
  let nextId = 0;
  let history: string[] = [];
  let histPos = $state(-1);
  let scroller = $state<HTMLDivElement | undefined>();

  async function run() {
    const expr = input.trim();
    if (!expr) return;
    history = [expr, ...history.filter((h) => h !== expr)];
    histPos = -1;
    input = "";
    const result = await debug.inspect(expr);
    log = [...log, { id: nextId++, expr, result }];
    queueMicrotask(() => scroller?.scrollTo({ top: scroller.scrollHeight }));
  }

  function clear() {
    log = [];
    debug.clearInspection();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (histPos + 1 < history.length) input = history[(histPos += 1)] ?? "";
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (histPos > 0) input = history[(histPos -= 1)] ?? "";
      else {
        histPos = -1;
        input = "";
      }
    }
  }
</script>

<div class="flex h-full flex-col">
  <div class="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1">
    <Telescope class="size-3 text-muted-foreground" />
    <span class="text-[11px] text-muted-foreground">Inspect</span>
    <!-- Search filters keys/values within the explored trees (sorted server-side). -->
    <div class="relative ml-auto flex items-center">
      <Search class="pointer-events-none absolute left-1.5 size-3 text-muted-foreground/60" />
      <input
        bind:value={search}
        placeholder="search keys/values…"
        class="h-5 w-40 rounded border border-border/60 bg-input/40 pl-6 pr-5 font-mono text-[11px] outline-none focus:ring-1 focus:ring-primary/40"
      />
      {#if search}
        <button
          class="absolute right-1 text-muted-foreground/60 hover:text-foreground"
          onclick={() => (search = "")}
          aria-label="Clear search"><X class="size-3" /></button
        >
      {/if}
    </div>
    {#if log.length > 0}
      <button
        class="flex items-center gap-1 text-[10px] text-muted-foreground/60 hover:text-foreground"
        onclick={clear}><Trash2 class="size-3" />clear</button
      >
    {/if}
  </div>
  <div bind:this={scroller} class="min-h-0 flex-1 overflow-auto px-1 py-1 font-mono text-[12px]">
    {#each log as e (e.id)}
      <div class="flex items-baseline gap-1.5 px-1">
        <span class="shrink-0 text-muted-foreground/60">›</span>
        <span class="truncate text-sky-400">{e.expr}</span>
      </div>
      <div class="pb-1 pl-2">
        {#if e.result.ok && (e.result.ref ?? 0) > 0}
          <VariableNode
            name="="
            type={e.result.type}
            value={e.result.value}
            vref={e.result.ref ?? 0}
            filter={search}
            autoExpandFilter={true}
          />
        {:else if e.result.ok}
          <div class="flex items-baseline gap-2 pl-2">
            <span class="text-foreground">{e.result.value}</span>
            {#if e.result.type}<span class="text-[10px] text-muted-foreground/60">{e.result.type}</span
              >{/if}
          </div>
        {:else}
          <div class="pl-2 text-destructive/80">{e.result.err}</div>
        {/if}
      </div>
    {/each}
    {#if log.length === 0}
      <p class="px-2 py-1 text-[11px] text-muted-foreground/60">
        Evaluate a Lua expression against the running sim and explore the result — e.g.
        <span class="text-sky-400/80">return Export.LoGetSelfData()</span> or
        <span class="text-sky-400/80">return _G</span>.
      </p>
    {/if}
  </div>
  <form
    class="flex shrink-0 items-center gap-1 border-t border-border/60 px-2 py-1"
    onsubmit={(e) => {
      e.preventDefault();
      void run();
    }}
  >
    <span class="text-muted-foreground/60">›</span>
    <input
      bind:value={input}
      onkeydown={onKey}
      placeholder="inspect an expression…"
      class="min-w-0 flex-1 bg-transparent font-mono text-[12px] outline-none"
    />
    <button
      type="submit"
      class="text-muted-foreground hover:text-foreground"
      aria-label="Inspect"
    >
      <CornerDownLeft class="size-3.5" />
    </button>
  </form>
</div>
