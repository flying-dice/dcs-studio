<script lang="ts">
  // Watch expressions — re-evaluated in the selected frame on each pause/frame
  // change. A watch whose result is a table is expandable inline (VariableNode).
  import { debug, type EvalResult } from "$lib/debug-session.svelte";
  import VariableNode from "./VariableNode.svelte";
  import { Plus, X, Eye } from "@lucide/svelte";

  let input = $state("");
  let results = $state<Record<string, EvalResult>>({});

  // Re-evaluate all watches whenever the pause, the selected frame, or the
  // watch list changes (refs in a result are valid only for that pause).
  $effect(() => {
    const ws = debug.watches;
    const seq = debug.pauseSeq;
    const sel = debug.selectedFrame;
    void seq;
    void sel;
    if (debug.status !== "paused") {
      results = {};
      return;
    }
    let cancelled = false;
    void (async () => {
      const out: Record<string, EvalResult> = {};
      for (const w of ws) out[w] = await debug.evaluate(w);
      if (!cancelled) results = out;
    })();
    return () => {
      cancelled = true;
    };
  });

  function add() {
    debug.addWatch(input);
    input = "";
  }
</script>

<div class="flex h-full flex-col">
  <div class="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1">
    <Eye class="size-3 text-muted-foreground" />
    <span class="text-[11px] text-muted-foreground">Watches</span>
    <form
      class="ml-auto flex items-center gap-1"
      onsubmit={(e) => {
        e.preventDefault();
        add();
      }}
    >
      <input
        bind:value={input}
        placeholder="add expression…"
        class="h-5 w-36 rounded border border-border/60 bg-input/40 px-1.5 font-mono text-[11px] outline-none focus:ring-1 focus:ring-primary/40"
      />
      <button type="submit" class="text-muted-foreground hover:text-foreground" aria-label="Add watch">
        <Plus class="size-3.5" />
      </button>
    </form>
  </div>
  <div class="min-h-0 flex-1 overflow-auto">
    {#if debug.watches.length === 0}
      <p class="px-2 py-1 text-[11px] text-muted-foreground/60">No watches.</p>
    {:else}
      {#each debug.watches as expr (expr)}
        {@const r = results[expr]}
        <div class="group flex items-center gap-1 pr-1">
          <div class="min-w-0 flex-1">
            {#if debug.status === "paused" && r}
              {#if r.ok && (r.ref ?? 0) > 0}
                {#key `${debug.pauseSeq}:${debug.selectedFrame}:${expr}`}
                  <VariableNode name={expr} type={r.type} value={r.value} vref={r.ref ?? 0} />
                {/key}
              {:else}
                <div class="flex items-center gap-2 px-2 py-0.5 font-mono text-[12px]">
                  <span class="shrink-0 text-amber-400">{expr}</span>
                  <span class="text-muted-foreground">=</span>
                  {#if r.ok}
                    <span class="truncate text-foreground">{r.value}</span>
                  {:else}
                    <span class="truncate text-destructive/80" title={r.err}>{r.err}</span>
                  {/if}
                </div>
              {/if}
            {:else}
              <div class="flex items-center gap-2 px-2 py-0.5 font-mono text-[12px]">
                <span class="shrink-0 text-amber-400">{expr}</span>
                <span class="text-muted-foreground/50">— paused only</span>
              </div>
            {/if}
          </div>
          <button
            class="shrink-0 text-muted-foreground/0 hover:text-foreground group-hover:text-muted-foreground"
            onclick={() => debug.removeWatch(expr)}
            aria-label="Remove watch"
          >
            <X class="size-3" />
          </button>
        </div>
      {/each}
    {/if}
  </div>
</div>
