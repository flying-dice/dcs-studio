<script lang="ts">
  // The editor tab strip: one tab per open file with a dirty marker and a
  // close button. Clicking a tab activates it (model `ActivateTab`); closing
  // a dirty tab prompts before discarding (model `CloseFile`).
  import { app } from "$lib/state.svelte";
  import { fileIconFor } from "$lib/file-icons";
  import FileIcon from "$lib/components/FileIcon.svelte";
  import { cn } from "$lib/utils.js";
  import { X } from "@lucide/svelte";
</script>

{#if app.openFiles.length > 0}
  {#each app.openFiles as f (f.path)}
    {@const active = f.path === app.activePath}
    {@const dirty = app.isDirty(f.path)}
    <div
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
          app.closeFile(f.path);
        }}
      >
        <X class="size-3.5" />
      </button>
    </div>
  {/each}
{:else}
  <span class="pl-2 font-mono text-[11px] tracking-wide text-muted-foreground">
    no file open
  </span>
{/if}
