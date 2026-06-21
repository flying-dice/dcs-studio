<script lang="ts">
  // One node in the debugger's variable tree. Expandable nodes (a scope, or a
  // table value with ref > 0) fetch their children lazily via debug.expand the
  // first time they open. Recursive: a child renders another VariableNode.
  import Self from "./VariableNode.svelte";
  import { ChevronRight, LoaderCircle } from "@lucide/svelte";
  import { debug, type DebugVariable } from "$lib/debug-session.svelte";

  let {
    name,
    type = undefined,
    value = undefined,
    vref,
    depth = 0,
  }: {
    name: string;
    type?: string;
    value?: string;
    vref: number;
    depth?: number;
  } = $props();

  let expanded = $state(false);
  let loaded = $state(false);
  let loading = $state(false);
  let children = $state<DebugVariable[]>([]);

  const expandable = $derived(vref > 0);

  async function toggle() {
    if (!expandable) return;
    expanded = !expanded;
    if (expanded && !loaded && !loading) {
      loading = true;
      children = await debug.expand(vref);
      loaded = true;
      loading = false;
    }
  }
</script>

<div
  class="flex cursor-default items-center gap-1 py-0.5 font-mono text-[12px] hover:bg-accent/40"
  style="padding-left: {depth * 12 + 6}px"
  onclick={toggle}
  role="button"
  tabindex="0"
  onkeydown={(e) => (e.key === "Enter" || e.key === " ") && toggle()}
>
  <span class="flex w-3 shrink-0 justify-center">
    {#if loading}
      <LoaderCircle class="size-3 animate-spin text-muted-foreground" />
    {:else if expandable}
      <ChevronRight
        class={"size-3 text-muted-foreground transition-transform " + (expanded ? "rotate-90" : "")}
      />
    {/if}
  </span>
  <span class="shrink-0 text-sky-400">{name}</span>
  {#if value !== undefined}
    <span class="text-muted-foreground">=</span>
    <span class="truncate text-foreground">{value}</span>
  {/if}
  {#if type}
    <span class="shrink-0 text-[10px] text-muted-foreground/60">{type}</span>
  {/if}
</div>

{#if expanded && loaded}
  {#if children.length === 0}
    <div
      class="py-0.5 text-[11px] text-muted-foreground/60"
      style="padding-left: {(depth + 1) * 12 + 22}px"
    >
      (empty)
    </div>
  {:else}
    {#each children as c, i (c.name + ":" + i)}
      <Self name={c.name} type={c.type} value={c.value} vref={c.ref} depth={depth + 1} />
    {/each}
  {/if}
{/if}
