<script lang="ts">
  import { readDir, type DirEntry } from "$lib/api";
  import { app } from "$lib/state.svelte";
  import { cn } from "$lib/utils.js";
  import { fileIconFor, FOLDER_ICON } from "$lib/file-icons";
  import FileIcon from "./FileIcon.svelte";
  import { ChevronRight } from "@lucide/svelte";
  import Self from "./TreeNode.svelte";

  let { entry, depth = 0 }: { entry: DirEntry; depth?: number } = $props();

  let expanded = $state(false);
  let loaded = $state(false);
  let loading = $state(false);
  let children = $state<DirEntry[]>([]);
  let error = $state<string | null>(null);

  async function toggle() {
    if (entry.is_dir) {
      expanded = !expanded;
      if (expanded && !loaded && !loading) {
        loading = true;
        try {
          children = await readDir(entry.path);
          loaded = true;
        } catch (e) {
          error = String(e);
        } finally {
          loading = false;
        }
      }
    } else {
      app.openFile(entry.path, entry.name);
    }
  }

  const isActive = $derived(!entry.is_dir && app.filePath === entry.path);
  const iconName = $derived(entry.is_dir ? FOLDER_ICON : fileIconFor(entry.name));
</script>

<div
  class={cn(
    "flex h-[22px] cursor-default items-center gap-1 rounded-md whitespace-nowrap text-[13px] text-foreground select-none hover:bg-accent",
    isActive && "bg-primary/20 hover:bg-primary/20",
  )}
  style="padding-left: {depth * 14 + 6}px"
  onclick={toggle}
  role="button"
  tabindex="0"
  onkeydown={(e) => (e.key === "Enter" || e.key === " ") && toggle()}
>
  <span class="flex w-3 shrink-0 justify-center">
    {#if entry.is_dir}
      <ChevronRight
        class={cn("size-3 text-muted-foreground transition-transform", expanded && "rotate-90")}
      />
    {/if}
  </span>
  <FileIcon name={iconName} class="size-4" />
  <span class="truncate">{entry.name}</span>
</div>

{#if expanded}
  {#if loading}
    <div class="h-5 text-xs text-muted-foreground" style="padding-left: {(depth + 1) * 14 + 6}px">
      loading…
    </div>
  {:else if error}
    <div
      class="text-xs whitespace-normal text-destructive"
      style="padding-left: {(depth + 1) * 14 + 6}px"
    >
      {error}
    </div>
  {:else}
    {#each children as child (child.path)}
      <Self entry={child} depth={depth + 1} />
    {/each}
  {/if}
{/if}
