<script lang="ts">
  // Manage every breakpoint across the workspace: jump to it, edit its
  // condition (a conditional breakpoint pauses only when the expression is
  // truthy), or remove it.
  import { debug, baseName } from "$lib/debug-session.svelte";
  import { app } from "$lib/state.svelte";
  import { X, Circle } from "@lucide/svelte";

  interface Row {
    path: string;
    line: number;
    cond: string;
  }

  const rows = $derived.by<Row[]>(() => {
    const out: Row[] = [];
    for (const [path, lines] of Object.entries(debug.breakpoints)) {
      for (const line of lines) out.push({ path, line, cond: debug.conditionFor(path, line) });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  });

  let editing = $state<string | null>(null);
  let editValue = $state("");

  function startEdit(r: Row) {
    editing = `${r.path}:${r.line}`;
    editValue = r.cond;
  }
  async function commitEdit(r: Row) {
    editing = null;
    await debug.setCondition(r.path, r.line, editValue);
  }
  function reveal(r: Row) {
    app.openFile(r.path, baseName(r.path), { line: r.line, col: 1 });
  }
</script>

<div class="flex h-full flex-col">
  <div class="shrink-0 border-b border-border/60 px-2 py-1 text-[11px] text-muted-foreground">
    Breakpoints
  </div>
  <div class="min-h-0 flex-1 overflow-auto">
    {#if rows.length === 0}
      <p class="px-2 py-1 text-[11px] text-muted-foreground/60">
        No breakpoints. Click the editor gutter to add one.
      </p>
    {:else}
      {#each rows as r (r.path + ":" + r.line)}
        <div class="group flex items-center gap-2 px-2 py-1 hover:bg-accent/30">
          <Circle class="size-2.5 shrink-0 fill-destructive text-destructive" />
          <button
            class="shrink-0 font-mono text-[12px] hover:underline"
            onclick={() => reveal(r)}
          >
            {baseName(r.path)}:{r.line}
          </button>
          <div class="min-w-0 flex-1">
            {#if editing === `${r.path}:${r.line}`}
              <!-- svelte-ignore a11y_autofocus -->
              <input
                autofocus
                bind:value={editValue}
                placeholder="condition (e.g. i == 3)"
                class="h-5 w-full rounded border border-primary/40 bg-input/40 px-1.5 font-mono text-[11px] outline-none"
                onkeydown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void commitEdit(r);
                  } else if (e.key === "Escape") {
                    editing = null;
                  }
                }}
                onblur={() => void commitEdit(r)}
              />
            {:else}
              <button
                class="w-full truncate text-left font-mono text-[11px] {r.cond
                  ? 'text-amber-400'
                  : 'text-muted-foreground/40'}"
                onclick={() => startEdit(r)}
                title="Edit condition"
              >
                {r.cond ? `when ${r.cond}` : "add condition…"}
              </button>
            {/if}
          </div>
          <button
            class="shrink-0 text-muted-foreground/0 hover:text-destructive group-hover:text-muted-foreground"
            onclick={() => void debug.toggleBreakpoint(r.path, r.line)}
            aria-label="Remove breakpoint"
          >
            <X class="size-3.5" />
          </button>
        </div>
      {/each}
    {/if}
  </div>
</div>
