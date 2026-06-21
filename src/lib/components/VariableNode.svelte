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
    filter = "",
    autoExpandFilter = false,
  }: {
    name: string;
    type?: string;
    value?: string;
    vref: number;
    depth?: number;
    // A search term: children are filtered to those whose name or value match.
    filter?: string;
    // When a filter is active, auto-open this node (used for tree roots) so
    // results show without a manual expand. Not passed to children (no cascade).
    autoExpandFilter?: boolean;
  } = $props();

  let expanded = $state(false);
  let loaded = $state(false);
  let loading = $state(false);
  let children = $state<DebugVariable[]>([]);

  const expandable = $derived(vref > 0);
  const term = $derived(filter.trim().toLowerCase());
  // Filter this node's loaded children by name or value (a shallow, per-level
  // match over what's loaded — drilling deeper applies the filter there too).
  const shown = $derived(
    term
      ? children.filter(
          (c) => c.name.toLowerCase().includes(term) || (c.value ?? "").toLowerCase().includes(term),
        )
      : children,
  );

  async function fetchChildren() {
    if (loaded || loading) return;
    loading = true;
    children = await debug.expand(vref);
    loaded = true;
    loading = false;
  }

  // Open a tree root when a search becomes active, so matches appear at once.
  $effect(() => {
    if (term && autoExpandFilter && expandable && !loaded && !loading) {
      expanded = true;
      void fetchChildren();
    }
  });

  async function toggle() {
    if (!expandable) return;
    expanded = !expanded;
    if (expanded) await fetchChildren();
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
  {#if shown.length === 0}
    <div
      class="py-0.5 text-[11px] text-muted-foreground/60"
      style="padding-left: {(depth + 1) * 12 + 22}px"
    >
      {term ? "(no matches)" : "(empty)"}
    </div>
  {:else}
    {#each shown as c, i (c.name + ":" + i)}
      <Self name={c.name} type={c.type} value={c.value} vref={c.ref} depth={depth + 1} {filter} />
    {/each}
  {/if}
{/if}
