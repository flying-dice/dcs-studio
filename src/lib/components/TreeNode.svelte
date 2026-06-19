<script lang="ts">
  import { readDir, type DirEntry } from "$lib/api";
  import { app } from "$lib/state.svelte";
  import { runFile } from "$lib/lua-console.svelte";
  import { cn, errorMessage } from "$lib/utils.js";
  import { fileIconFor, FOLDER_ICON } from "$lib/file-icons";
  import FileIcon from "./FileIcon.svelte";
  import { ChevronRight } from "@lucide/svelte";
  import * as ContextMenu from "$lib/components/ui/context-menu/index.js";
  import {
    renameEntry,
    duplicateEntry,
    deleteEntry,
    createEntry,
    copyPath,
    copyRelativePath,
    reveal,
    targetDir,
  } from "$lib/tree-actions";
  import Self from "./TreeNode.svelte";

  let { entry, depth = 0 }: { entry: DirEntry; depth?: number } = $props();

  let expanded = $state(false);
  let loaded = $state(false);
  let loading = $state(false);
  let children = $state<DirEntry[]>([]);
  let error = $state<string | null>(null);
  // Transient inline-edit state for the context-menu actions.
  let renaming = $state(false);
  let renameValue = $state("");
  let creating = $state<"file" | "folder" | null>(null);
  let createValue = $state("");
  // Surfaced action failure (rename collision, create error) — cleared on the
  // next action.
  let actionError = $state<string | null>(null);

  async function loadChildren() {
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

  async function toggle() {
    if (renaming) return;
    if (entry.is_dir) {
      expanded = !expanded;
      if (expanded && !loaded && !loading) await loadChildren();
    } else {
      app.openFile(entry.path, entry.name);
    }
  }

  // Re-read this node's children when a tree mutation bumps the version
  // (model studio::files — create/rename/duplicate/delete). The guard makes
  // expand/collapse toggles (which also read the tracked state) no-ops.
  let lastVersion = 0;
  $effect(() => {
    const v = app.treeVersion;
    if (v !== lastVersion) {
      lastVersion = v;
      if (expanded && loaded) void loadChildren();
    }
  });

  /** Focus and select an input the moment it mounts (inline edit UX). */
  function autofocus(node: HTMLInputElement) {
    node.focus();
    node.select();
  }

  function startRename() {
    actionError = null;
    renameValue = entry.name;
    renaming = true;
  }

  async function commitRename() {
    if (!renaming) return;
    const value = renameValue;
    renaming = false;
    try {
      await renameEntry(entry, value);
    } catch (e) {
      actionError = errorMessage(e);
    }
  }

  async function startCreate(kind: "file" | "folder") {
    actionError = null;
    createValue = "";
    creating = kind;
    if (entry.is_dir && !expanded) {
      expanded = true;
      if (!loaded && !loading) await loadChildren();
    }
  }

  async function commitCreate() {
    const kind = creating;
    const value = createValue;
    creating = null;
    if (!kind) return;
    try {
      await createEntry(targetDir(entry), kind, value);
    } catch (e) {
      actionError = errorMessage(e);
    }
  }

  async function doDuplicate() {
    actionError = null;
    try {
      await duplicateEntry(entry);
    } catch (e) {
      actionError = errorMessage(e);
    }
  }

  async function doDelete() {
    actionError = null;
    try {
      await deleteEntry(entry);
    } catch (e) {
      actionError = errorMessage(e);
    }
  }

  const isActive = $derived(!entry.is_dir && app.filePath === entry.path);
  const iconName = $derived(entry.is_dir ? FOLDER_ICON : fileIconFor(entry.name));
  // A new file/folder nests inside a folder node, or sits beside a file node.
  const createDepth = $derived(entry.is_dir ? depth + 1 : depth);
  const indent = (d: number) => `padding-left: ${d * 14 + 6}px`;
</script>

{#if renaming}
  <!-- svelte-ignore a11y_autofocus -->
  <input
    class="h-[22px] w-full rounded-md border border-primary/50 bg-input px-1 text-[13px] outline-none"
    style={indent(depth) + "; padding-left: " + (depth * 14 + 26) + "px"}
    data-testid="tree-rename-input"
    bind:value={renameValue}
    use:autofocus
    onkeydown={(e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void commitRename();
      } else if (e.key === "Escape") {
        e.preventDefault();
        // Reset to the original name so the ensuing blur-commit is a no-op
        // (Escape cancels; clicking away commits the typed name).
        renameValue = entry.name;
        renaming = false;
      }
    }}
    onblur={() => void commitRename()}
  />
{:else}
  <ContextMenu.Root>
    <ContextMenu.Trigger class="block">
      <div
        class={cn(
          "flex h-[22px] cursor-default items-center gap-1 rounded-md whitespace-nowrap text-[13px] text-foreground select-none hover:bg-accent",
          isActive && "bg-primary/20 hover:bg-primary/20",
        )}
        style={indent(depth)}
        onclick={toggle}
        role="button"
        tabindex="0"
        onkeydown={(e) => (e.key === "Enter" || e.key === " ") && toggle()}
        data-testid="tree-node"
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
    </ContextMenu.Trigger>
    <ContextMenu.Content class="w-56" data-testid="tree-context-menu">
      {#if !entry.is_dir}
        <ContextMenu.Item
          onSelect={() => void runFile(entry.path).catch((e) => (actionError = errorMessage(e)))}
          data-testid="tree-run-in-dcs"
        >
          Run in DCS
        </ContextMenu.Item>
        <ContextMenu.Separator />
      {/if}
      <ContextMenu.Item onSelect={() => startCreate("file")}>New File…</ContextMenu.Item>
      <ContextMenu.Item onSelect={() => startCreate("folder")}>New Folder…</ContextMenu.Item>
      <ContextMenu.Separator />
      <ContextMenu.Item onSelect={startRename} data-testid="ctx-rename">Rename…</ContextMenu.Item>
      <ContextMenu.Item onSelect={doDuplicate}>Duplicate</ContextMenu.Item>
      <ContextMenu.Item variant="destructive" onSelect={doDelete} data-testid="ctx-delete">
        Delete
      </ContextMenu.Item>
      <ContextMenu.Separator />
      <ContextMenu.Item onSelect={() => copyPath(entry.path)}>Copy Path</ContextMenu.Item>
      <ContextMenu.Item onSelect={() => copyRelativePath(entry.path)}>
        Copy Relative Path
      </ContextMenu.Item>
      <ContextMenu.Item onSelect={() => reveal(entry.path)}>Reveal in Explorer</ContextMenu.Item>
    </ContextMenu.Content>
  </ContextMenu.Root>
{/if}

{#if actionError}
  <div class="whitespace-normal text-[11px] text-destructive" style={indent(depth)} data-testid="tree-action-error">
    {actionError}
  </div>
{/if}

{#if creating && (!entry.is_dir || expanded)}
  <!-- svelte-ignore a11y_autofocus -->
  <input
    class="h-[22px] w-full rounded-md border border-primary/50 bg-input px-1 text-[13px] outline-none"
    style="padding-left: {createDepth * 14 + 26}px"
    data-testid="tree-create-input"
    placeholder={creating === "file" ? "filename" : "folder name"}
    bind:value={createValue}
    use:autofocus
    onkeydown={(e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void commitCreate();
      } else if (e.key === "Escape") {
        e.preventDefault();
        // Cancel: clearing `creating` makes the ensuing blur-commit a no-op.
        creating = null;
      }
    }}
    onblur={() => void commitCreate()}
  />
{/if}

{#if expanded}
  {#if loading}
    <div class="h-5 text-xs text-muted-foreground" style={indent(depth + 1)}>loading…</div>
  {:else if error}
    <div class="text-xs whitespace-normal text-destructive" style={indent(depth + 1)}>{error}</div>
  {:else}
    {#each children as child (child.path)}
      <Self entry={child} depth={depth + 1} />
    {/each}
  {/if}
{/if}
