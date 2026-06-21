<script lang="ts">
  // The debug console: evaluate Lua expressions in the selected paused frame
  // and keep a transcript. Up/Down recalls history.
  import { debug, type EvalResult } from "$lib/debug-session.svelte";
  import { Terminal, CornerDownLeft } from "@lucide/svelte";

  interface Entry {
    expr: string;
    result: EvalResult;
  }

  let input = $state("");
  let log = $state<Entry[]>([]);
  let history: string[] = [];
  let histPos = $state(-1);
  let scroller = $state<HTMLDivElement | undefined>();

  async function run() {
    const expr = input.trim();
    if (!expr) return;
    history = [expr, ...history.filter((h) => h !== expr)];
    histPos = -1;
    input = "";
    const result = await debug.evaluate(expr);
    log = [...log, { expr, result }];
    queueMicrotask(() => scroller?.scrollTo({ top: scroller.scrollHeight }));
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (histPos + 1 < history.length) {
        histPos += 1;
        input = history[histPos] ?? "";
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (histPos > 0) {
        histPos -= 1;
        input = history[histPos] ?? "";
      } else {
        histPos = -1;
        input = "";
      }
    }
  }
</script>

<div class="flex h-full flex-col">
  <div class="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1">
    <Terminal class="size-3 text-muted-foreground" />
    <span class="text-[11px] text-muted-foreground">Console</span>
    {#if log.length > 0}
      <button
        class="ml-auto text-[10px] text-muted-foreground/60 hover:text-foreground"
        onclick={() => (log = [])}>clear</button
      >
    {/if}
  </div>
  <div bind:this={scroller} class="min-h-0 flex-1 overflow-auto px-2 py-1 font-mono text-[12px]">
    {#each log as e, i (i)}
      <div class="flex items-baseline gap-1.5">
        <span class="shrink-0 text-muted-foreground/60">›</span>
        <span class="truncate text-sky-400">{e.expr}</span>
      </div>
      <div class="pl-3 pb-1">
        {#if e.result.ok}
          <span class="text-foreground">{e.result.value}</span>
          {#if e.result.type}<span class="ml-2 text-[10px] text-muted-foreground/60"
              >{e.result.type}</span
            >{/if}
        {:else}
          <span class="text-destructive/80">{e.result.err}</span>
        {/if}
      </div>
    {/each}
    {#if log.length === 0}
      <p class="text-[11px] text-muted-foreground/60">
        Evaluate expressions in the selected frame while paused.
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
      disabled={debug.status !== "paused"}
      placeholder={debug.status === "paused" ? "evaluate…" : "paused only"}
      class="min-w-0 flex-1 bg-transparent font-mono text-[12px] outline-none disabled:opacity-50"
    />
    <button
      type="submit"
      disabled={debug.status !== "paused"}
      class="text-muted-foreground hover:text-foreground disabled:opacity-30"
      aria-label="Evaluate"
    >
      <CornerDownLeft class="size-3.5" />
    </button>
  </form>
</div>
