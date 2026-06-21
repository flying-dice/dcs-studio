<script lang="ts">
  import { readDir, type DirEntry } from "$lib/api";
  import { app } from "$lib/state.svelte";
  import { createEntry } from "$lib/tree-actions";
  import { errorMessage } from "$lib/utils.js";
  import TreeNode from "./TreeNode.svelte";
  import TreeCreateInput from "./TreeCreateInput.svelte";
  import * as ContextMenu from "$lib/components/ui/context-menu/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { FolderOpen } from "@lucide/svelte";

  let roots = $state<DirEntry[]>([]);
  let error = $state<string | null>(null);

  // Root-level inline create (right-click on empty space / panel background).
  // Mirrors TreeNode's per-node create, but the target is the workspace root.
  let creating = $state<"file" | "folder" | null>(null);
  let createValue = $state("");
  let actionError = $state<string | null>(null);

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

  // SWR revalidation: external changes (OS Explorer, CLI, git, the integrated
  // terminal) leave no in-app mutation to bump `treeVersion`, so re-read on
  // window refocus and on a light poll while the panel is mounted. `refreshTree`
  // only re-reads the roots + expanded nodes, so the cost is small. Both are
  // gated on document visibility so a backgrounded window stays idle.
  $effect(() => {
    const revalidate = () => {
      // Hold off while an inline create/rename box is open (app.treeEditing):
      // reloading would shift the tree and blur the box out from under the user.
      if (document.visibilityState === "visible" && app.treeEditing === 0) {
        app.refreshTree();
      }
    };
    window.addEventListener("focus", revalidate);
    document.addEventListener("visibilitychange", revalidate);
    const poll = setInterval(revalidate, 5000);
    return () => {
      window.removeEventListener("focus", revalidate);
      document.removeEventListener("visibilitychange", revalidate);
      clearInterval(poll);
    };
  });

  // The create box can't mount while the context menu is still open: bits-ui's
  // focus scope traps focus, so an autofocused input is immediately blurred
  // (firing its commit-on-blur and tearing it back down). So a menu pick only
  // records the intent; `applyPending` runs from the menu's onCloseAutoFocus,
  // after the scope has released, to actually open the box.
  let pendingCreate: "file" | "folder" | null = null;

  function startRootCreate(kind: "file" | "folder") {
    actionError = null;
    createValue = "";
    pendingCreate = kind;
  }

  function applyPending() {
    if (pendingCreate) {
      creating = pendingCreate;
      pendingCreate = null;
    }
  }

  async function commitRootCreate() {
    const kind = creating;
    const value = createValue;
    creating = null;
    if (!kind || !app.rootPath) return;
    try {
      await createEntry(app.rootPath, kind, value);
    } catch (e) {
      actionError = errorMessage(e);
    }
  }
</script>

{#if !app.rootPath}
  <div class="flex flex-col items-start gap-2 p-4 text-[13px] text-muted-foreground">
    <p class="m-0">No folder opened.</p>
    <Button variant="outline" size="sm" onclick={() => app.openFolder()}>
      <FolderOpen />
      Open Folder…
    </Button>
  </div>
{:else}
  <ContextMenu.Root>
    <ContextMenu.Trigger class="block min-h-full py-1">
      {#if error}<div class="p-2 text-xs text-destructive">{error}</div>{/if}
      {#each roots as entry (entry.path)}
        <TreeNode {entry} depth={0} />
      {/each}
      {#if creating}
        <TreeCreateInput
          kind={creating}
          bind:value={createValue}
          paddingLeft={26}
          oncommit={() => void commitRootCreate()}
          oncancel={() => (creating = null)}
        />
      {/if}
      {#if actionError}
        <div class="px-2 text-[11px] whitespace-normal text-destructive" data-testid="tree-action-error">
          {actionError}
        </div>
      {/if}
    </ContextMenu.Trigger>
    <!-- Open the create box only once the menu has closed and released its
         focus scope (see `pendingCreate`); preventDefault keeps focus off the
         trigger so the box's autofocus wins. -->
    <ContextMenu.Content
      class="w-56"
      data-testid="tree-root-context-menu"
      onCloseAutoFocus={(e) => {
        e.preventDefault();
        applyPending();
      }}
    >
      <ContextMenu.Item onSelect={() => startRootCreate("file")} data-testid="ctx-root-new-file">
        New File…
      </ContextMenu.Item>
      <ContextMenu.Item onSelect={() => startRootCreate("folder")} data-testid="ctx-root-new-folder">
        New Folder…
      </ContextMenu.Item>
    </ContextMenu.Content>
  </ContextMenu.Root>
{/if}
