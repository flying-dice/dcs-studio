<script lang="ts">
  // The editor tab strip: one tab per open file with a dirty marker and a
  // close button. Clicking a tab activates it (model `ActivateTab`); closing
  // a dirty tab prompts before discarding (model `CloseFile`). Right-clicking
  // a tab opens a context menu for bulk closes and copy-path actions (model
  // `CloseOtherTabs` / `CloseTabsToRight` / `CloseAllTabs` / `CloseSavedTabs`
  // / `CopyTabPath` / `CopyTabRelativePath`).
  import { app } from "$lib/state.svelte";
  import { fileIconFor } from "$lib/file-icons";
  import FileIcon from "$lib/components/FileIcon.svelte";
  import * as ContextMenu from "$lib/components/ui/context-menu/index.js";
  import { copyPath, copyRelativePath } from "$lib/tree-actions";
  import { cleanTabPaths } from "$lib/tab-close";
  import { cn } from "$lib/utils.js";
  import { X } from "@lucide/svelte";

  // Close Saved is a no-op with no clean tab, so the menu disables it then.
  // The same for every tab's menu — derive it once for the whole strip.
  const hasCleanTab = $derived(cleanTabPaths(app.openFiles).length > 0);
</script>

{#if app.openFiles.length > 0}
  {#each app.openFiles as f, i (f.path)}
    {@const active = f.path === app.activePath}
    {@const dirty = app.isDirty(f.path)}
    {@const isLast = i === app.openFiles.length - 1}
    <ContextMenu.Root>
      <ContextMenu.Trigger>
        {#snippet child({ props })}
          <div
            {...props}
            role="tab"
            tabindex="0"
            aria-selected={active}
            data-testid="editor-tab"
            data-path={f.path}
            data-active={active}
            data-dirty={dirty}
            class={cn(
              "flex h-7 cursor-pointer select-none items-center gap-2 rounded-md pl-2.5 pr-1 text-xs",
              active
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
            )}
            onclick={() => app.activateFile(f.path)}
            onkeydown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                app.activateFile(f.path);
              }
            }}
          >
            {#if dirty}
              <span class="size-1.5 shrink-0 rounded-full bg-primary" title="Unsaved changes"></span>
            {/if}
            <FileIcon name={fileIconFor(f.name)} class="size-4 shrink-0" />
            <span class="truncate">{f.name}</span>
            <button
              type="button"
              data-testid="tab-close"
              class="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
              title="Close"
              aria-label={`Close ${f.name}`}
              onclick={(e) => {
                e.stopPropagation();
                void app.closeFile(f.path);
              }}
            >
              <X class="size-3.5" />
            </button>
          </div>
        {/snippet}
      </ContextMenu.Trigger>
      <ContextMenu.Content class="w-52" data-testid="tab-context-menu">
        <ContextMenu.Item data-testid="ctx-close" onSelect={() => void app.closeFile(f.path)}>
          Close
        </ContextMenu.Item>
        <ContextMenu.Item
          data-testid="ctx-close-others"
          disabled={app.openFiles.length <= 1}
          onSelect={() => void app.closeOthers(f.path)}
        >
          Close Others
        </ContextMenu.Item>
        <ContextMenu.Item
          data-testid="ctx-close-right"
          disabled={isLast}
          onSelect={() => void app.closeToRight(f.path)}
        >
          Close to the Right
        </ContextMenu.Item>
        <ContextMenu.Item data-testid="ctx-close-all" onSelect={() => void app.closeAll()}>
          Close All
        </ContextMenu.Item>
        <ContextMenu.Item
          data-testid="ctx-close-saved"
          disabled={!hasCleanTab}
          onSelect={() => void app.closeSaved()}
        >
          Close Saved
        </ContextMenu.Item>
        <ContextMenu.Separator />
        <ContextMenu.Item data-testid="ctx-copy-path" onSelect={() => void copyPath(f.path)}>
          Copy Path
        </ContextMenu.Item>
        <ContextMenu.Item
          data-testid="ctx-copy-rel-path"
          onSelect={() => void copyRelativePath(f.path)}
        >
          Copy Relative Path
        </ContextMenu.Item>
      </ContextMenu.Content>
    </ContextMenu.Root>
  {/each}
{:else}
  <span class="pl-2 font-mono text-[11px] tracking-wide text-muted-foreground">
    no file open
  </span>
{/if}
