<script lang="ts">
  // Problems panel: workspace findings from the language engine, grouped
  // by file (model/studio/lang.pds — PublishProblems / OpenProblem).
  import { CircleAlert, Info, TriangleAlert } from "@lucide/svelte";
  import { app } from "$lib/state.svelte";
  import { lang } from "$lib/lang/intel.svelte";
  import type { Diagnostic } from "$lib/lang/provider";

  const groups = $derived.by(() => {
    const byFile = new Map<string, Diagnostic[]>();
    for (const d of lang.diagnostics) {
      const list = byFile.get(d.path) ?? [];
      list.push(d);
      byFile.set(d.path, list);
    }
    return [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b));
  });

  function fileName(path: string): string {
    return path.split(/[\\/]/).pop() ?? path;
  }

  function open(finding: Diagnostic) {
    app.openFile(finding.path, fileName(finding.path));
  }
</script>

<div class="h-full overflow-auto px-2 py-1.5 text-[12px]" data-testid="problems-panel">
  {#if groups.length === 0}
    <div class="flex h-full items-center justify-center text-muted-foreground">
      {lang.engineStatus === "failed"
        ? "Language engine unavailable"
        : "No problems detected"}
    </div>
  {:else}
    {#each groups as [path, findings] (path)}
      <div class="mb-1.5">
        <div class="flex items-baseline gap-1.5 px-1 py-0.5 font-medium">
          <span>{fileName(path)}</span>
          <span class="truncate font-mono text-[10px] text-muted-foreground">{path}</span>
        </div>
        {#each findings as finding, index (`${finding.path}|${finding.start}|${finding.code}|${index}`)}
          <button
            type="button"
            class="flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left hover:bg-accent"
            data-testid="problem-entry"
            onclick={() => open(finding)}
          >
            {#if finding.severity === "error"}
              <CircleAlert class="size-3.5 shrink-0 text-red-500" />
            {:else if finding.severity === "warning"}
              <TriangleAlert class="size-3.5 shrink-0 text-amber-500" />
            {:else}
              <Info class="size-3.5 shrink-0 text-sky-500" />
            {/if}
            <span class="truncate">{finding.message}</span>
            <span class="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
              {finding.code} · {finding.start_line}:{finding.start_col}
            </span>
          </button>
        {/each}
      </div>
    {/each}
  {/if}
</div>
