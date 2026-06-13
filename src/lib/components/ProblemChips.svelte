<script lang="ts">
  // Status-bar problem count chips (model/studio/lang.pds —
  // StatusBarCountsOpenProblems): live error/warning counts read straight
  // off the workspace findings store; clicking either chip opens the
  // Problems panel via `onOpen`. Zero counts render subdued, not hidden.
  import { CircleAlert, TriangleAlert } from "@lucide/svelte";
  import { lang } from "$lib/lang/intel.svelte";
  import { cn } from "$lib/utils.js";

  let { onOpen }: { onOpen: () => void } = $props();

  const errors = $derived(
    lang.diagnostics.filter((d) => d.severity === "error").length,
  );
  const warnings = $derived(
    lang.diagnostics.filter((d) => d.severity === "warning").length,
  );
</script>

<span class="flex shrink-0 items-center gap-1.5" data-testid="problem-chips">
  <button
    type="button"
    class={cn(
      "flex items-center gap-1 font-mono text-[11px] tracking-wide",
      errors > 0 ? "text-red-500" : "text-muted-foreground/50",
    )}
    title="Errors — open Problems"
    data-testid="status-chip-errors"
    onclick={onOpen}
  >
    <CircleAlert class="size-3" />{errors}
  </button>
  <button
    type="button"
    class={cn(
      "flex items-center gap-1 font-mono text-[11px] tracking-wide",
      warnings > 0 ? "text-amber-500" : "text-muted-foreground/50",
    )}
    title="Warnings — open Problems"
    data-testid="status-chip-warnings"
    onclick={onOpen}
  >
    <TriangleAlert class="size-3" />{warnings}
  </button>
</span>
