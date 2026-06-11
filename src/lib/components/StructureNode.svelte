<script lang="ts">
  // One Structure row (+ its nested declarations) — the outline sibling of
  // TreeNode.svelte, sharing its row geometry and selection treatment.
  import { cn } from "$lib/utils.js";
  import { SquareFunction, Variable } from "@lucide/svelte";
  import type { DocumentSymbol } from "$lib/lang/provider";
  import Self from "./StructureNode.svelte";

  let {
    symbol,
    depth = 0,
    current = null,
    onopen,
  }: {
    symbol: DocumentSymbol;
    depth?: number;
    /** The innermost symbol enclosing the editor caret, if any. */
    current?: DocumentSymbol | null;
    onopen: (symbol: DocumentSymbol) => void;
  } = $props();

  const isActive = $derived(current === symbol);
</script>

<div
  class={cn(
    "flex h-[22px] cursor-default items-center gap-1 rounded-md whitespace-nowrap text-[13px] text-foreground select-none hover:bg-accent",
    isActive && "bg-primary/20 hover:bg-primary/20",
  )}
  style="padding-left: {depth * 14 + 6}px"
  data-testid="structure-entry"
  data-active={isActive}
  onclick={() => onopen(symbol)}
  role="button"
  tabindex="0"
  onkeydown={(e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    // Navigation focuses the editor mid-keypress: without preventDefault
    // the same Enter/Space would then type into the freshly focused editor.
    e.preventDefault();
    onopen(symbol);
  }}
>
  {#if symbol.kind === "function"}
    <SquareFunction class="size-4 shrink-0 text-purple-500" />
  {:else}
    <Variable class="size-4 shrink-0 text-sky-500" />
  {/if}
  <span class="truncate">{symbol.name}</span>
</div>

{#each symbol.children as child, index (index)}
  <Self symbol={child} depth={depth + 1} {current} {onopen} />
{/each}
