<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
  import { EyeOff, FolderOpen, ExternalLink } from "@lucide/svelte";
  import { formatBytes } from "$lib/utils";
  import { revealInExplorer, openInAssociatedApp } from "$lib/reveal";

  // The binary-file placeholder (model BinaryFileShowsPlaceholder): a
  // JetBrains-Fleet-style panel — eye-off icon, message, size, and the two OS
  // actions — shown instead of a binary file's bytes. The Editor renders it as
  // an opaque overlay over its blank view, so it absolute-fills its host.
  let { path, size }: { path: string; size: number } = $props();
</script>

<div
  class="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-card px-10 text-center"
  data-testid="binary-overlay"
>
  <EyeOff class="size-8 text-muted-foreground/70" />
  <p class="max-w-xs text-sm text-foreground/80">
    The file is not shown because it is binary.
  </p>
  <p class="font-mono text-[11px] tracking-wide text-muted-foreground">
    {formatBytes(size)}
  </p>
  <div class="mt-1 flex items-center gap-2">
    <Button variant="outline" size="sm" onclick={() => revealInExplorer(path)}>
      <FolderOpen />
      Open in Explorer
    </Button>
    <Button variant="outline" size="sm" onclick={() => openInAssociatedApp(path)}>
      <ExternalLink />
      Open in associated application
    </Button>
  </div>
</div>
