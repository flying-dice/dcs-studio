<script lang="ts">
  import { readDir, type DirEntry } from "$lib/api";
  import { app } from "$lib/state.svelte";
  import { runConfig, isLuaFile } from "$lib/run-config.svelte";
  import { cn, errorMessage } from "$lib/utils.js";
  import { fileIconFor, FOLDER_ICON } from "$lib/file-icons";
  import FileIcon from "./FileIcon.svelte";
  import TreeCreateInput from "./TreeCreateInput.svelte";
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
  import { untrack } from "svelte";

  let { entry, depth = 0 }: { entry: DirEntry; depth?: number } = $props();

  let expanded = $state(false);
  let loaded = $state(false);
  let loading = $state(false);
  let children = $state<DirEntry[]>([]);
  let error = $state<string | null>(null);
  // Transient inline-edit state for the context-menu actions.
  let renaming = $state(false);
  let renameValue = $state("");
  let renameInputEl = $state<HTMLInputElement | null>(null);
  let creating = $state<"file" | "folder" | null>(null);
  let createValue = $state("");
  // Surfaced action failure (rename collision, create error) — cleared on the
  // next action.
  let actionError = $state<string | null>(null);

  async function loadChildren() {
    // Only show the loading placeholder on the FIRST load. A refresh (a
    // treeVersion bump from a mutation or the SWR poll) must update `children`
    // in place: swapping in the "loading…" branch would unmount the keyed
    // {#each}, destroying child TreeNodes — collapsing expanded subfolders and
    // tearing down any open inline create box. Reassigning the array instead
    // lets the keyed each reconcile by path and preserve that state.
    if (!loaded) loading = true;
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

  // An inline box (rename / new file / new folder) can't mount while the
  // context menu is still open: bits-ui's focus scope traps focus, so the
  // autofocused input is immediately blurred (firing its commit-on-blur and
  // tearing it back down). A menu pick only records the intent here; the
  // box opens from the menu's onCloseAutoFocus (`applyPending`), once the
  // focus scope has released.
  let pendingAction: { type: "rename" } | { type: "create"; kind: "file" | "folder" } | null = null;

  function startRename() {
    actionError = null;
    renameValue = entry.name;
    pendingAction = { type: "rename" };
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
    pendingAction = { type: "create", kind };
    // Expand a folder now (while the menu closes) so the box has a place to
    // appear; the `creating` flag itself flips in applyPending.
    if (entry.is_dir && !expanded) {
      expanded = true;
      if (!loaded && !loading) await loadChildren();
    }
  }

  function applyPending() {
    const p = pendingAction;
    pendingAction = null;
    if (!p) return;
    if (p.type === "rename") renaming = true;
    else creating = p.kind;
  }

  // While the rename box is open, suspend the SWR poll and commit only on a
  // genuine outside pointer press — never on blur. The box is blurred
  // programmatically (context-menu focus scope, tree re-render, the IDE
  // grabbing focus); a blur-commit would close it before the user can type.
  $effect(() => {
    if (!renaming) return;
    untrack(() => app.beginTreeEdit());
    const onPointerDown = (e: PointerEvent) => {
      if (renameInputEl && !renameInputEl.contains(e.target as Node)) {
        void commitRename();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      app.endTreeEdit();
    };
  });

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
    bind:this={renameInputEl}
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
        // Cancel without committing (no rename).
        renaming = false;
      }
    }}
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
    <!-- Open the inline box only once the menu has closed and released its
         focus scope (see `pendingAction`); preventDefault keeps focus off the
         trigger so the box's autofocus wins. -->
    <ContextMenu.Content
      class="w-56"
      data-testid="tree-context-menu"
      onCloseAutoFocus={(e) => {
        e.preventDefault();
        applyPending();
      }}
    >
      {#if !entry.is_dir && isLuaFile(entry.path)}
        <ContextMenu.Item
          onSelect={() => runConfig.runFileTarget(entry.path)}
          data-testid="tree-run-file"
        >
          Run '{entry.name}'
        </ContextMenu.Item>
        <ContextMenu.Item
          onSelect={() => runConfig.debugFileTarget(entry.path)}
          data-testid="tree-debug-file"
        >
          Debug '{entry.name}'
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
  <TreeCreateInput
    kind={creating}
    bind:value={createValue}
    paddingLeft={createDepth * 14 + 26}
    oncommit={() => void commitCreate()}
    oncancel={() => (creating = null)}
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
