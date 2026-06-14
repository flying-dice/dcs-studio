<script lang="ts">
  import { readDir, type DirEntry } from "$lib/api";
  import { app } from "$lib/state.svelte";
  import TreeNode from "./TreeNode.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { FolderOpen } from "@lucide/svelte";

  let roots = $state<DirEntry[]>([]);
  let error = $state<string | null>(null);

  // Reload the top level when the workspace root changes, or when a tree
  // mutation bumps the refresh signal (model studio::files — create/rename/
  // duplicate/delete at the root).
  $effect(() => {
    const path = app.rootPath;
    app.treeVersion; // re-read on mutations
    error = null;
    if (!path) {
      roots = [];
      return;
    }
    readDir(path)
      .then((entries) => (roots = entries))
      .catch((e) => (error = String(e)));
  });
</script>

<div class="py-1">
  {#if !app.rootPath}
    <div class="flex flex-col items-start gap-2 p-4 text-[13px] text-muted-foreground">
      <p class="m-0">No folder opened.</p>
      <Button variant="outline" size="sm" onclick={() => app.openFolder()}>
        <FolderOpen />
        Open Folder…
      </Button>
    </div>
  {:else}
    {#if error}<div class="p-2 text-xs text-destructive">{error}</div>{/if}
    {#each roots as entry (entry.path)}
      <TreeNode {entry} depth={0} />
    {/each}
  {/if}
</div>
