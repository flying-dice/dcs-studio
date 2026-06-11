<script lang="ts">
  // Problems panel: workspace findings from the language engine, grouped
  // by file (model/studio/lang.pds — PublishProblems / OpenProblem).
  // Severity ordering and the filter toggles are presentation concerns and
  // live here, panel-local — deliberately not in the model.
  import { CircleAlert, Info, TriangleAlert } from "@lucide/svelte";
  import { app } from "$lib/state.svelte";
  import { lang } from "$lib/lang/intel.svelte";
  import type { Diagnostic } from "$lib/lang/provider";
  import { cn } from "$lib/utils.js";

  type Severity = "error" | "warning" | "info";
  // Display order doubles as the sort rank: errors before warnings before info.
  const SEVERITIES: Severity[] = ["error", "warning", "info"];
  const FILTER_LABELS: Record<Severity, string> = {
    error: "errors",
    warning: "warnings",
    info: "info",
  };

  /** Unknown severities (a future engine's "hint") group with info. */
  function severityOf(finding: Diagnostic): Severity {
    return (SEVERITIES as string[]).includes(finding.severity)
      ? (finding.severity as Severity)
      : "info";
  }

  // Per-severity visibility — presentation state, panel-local.
  let shown = $state<Record<Severity, boolean>>({
    error: true,
    warning: true,
    info: true,
  });

  /** Workspace-wide counts per severity, independent of the filters. */
  const counts = $derived.by(() => {
    const tally: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
    for (const d of lang.diagnostics) tally[severityOf(d)] += 1;
    return tally;
  });

  const groups = $derived.by(() => {
    const byFile = new Map<string, Diagnostic[]>();
    for (const d of lang.diagnostics) {
      if (!shown[severityOf(d)]) continue;
      const list = byFile.get(d.path) ?? [];
      list.push(d);
      byFile.set(d.path, list);
    }
    // Within a file: severity first (errors, warnings, info), then span.
    for (const list of byFile.values()) {
      list.sort(
        (a, b) =>
          SEVERITIES.indexOf(severityOf(a)) - SEVERITIES.indexOf(severityOf(b)) ||
          a.start - b.start,
      );
    }
    return [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b));
  });

  /** Severities the disabled filters are currently hiding findings of. */
  const hiddenSeverities = $derived(
    SEVERITIES.filter((s) => !shown[s] && counts[s] > 0),
  );
  const hiddenCount = $derived(
    hiddenSeverities.reduce((n, s) => n + counts[s], 0),
  );

  function fileName(path: string): string {
    return path.split(/[\\/]/).pop() ?? path;
  }

  function open(finding: Diagnostic) {
    app.openFile(finding.path, fileName(finding.path), {
      line: finding.start_line,
      col: finding.start_col,
    });
  }
</script>

{#snippet severityIcon(severity: Severity)}
  {#if severity === "error"}
    <CircleAlert class="size-3.5 shrink-0 text-red-500" />
  {:else if severity === "warning"}
    <TriangleAlert class="size-3.5 shrink-0 text-amber-500" />
  {:else}
    <Info class="size-3.5 shrink-0 text-sky-500" />
  {/if}
{/snippet}

<div class="flex h-full flex-col text-[12px]" data-testid="problems-panel">
  <div
    class="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1"
    data-testid="problems-filters"
  >
    {#each SEVERITIES as severity (severity)}
      <button
        type="button"
        class={cn(
          "flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px]",
          shown[severity]
            ? "bg-accent text-foreground"
            : "text-muted-foreground opacity-60",
        )}
        aria-pressed={shown[severity]}
        title={`${shown[severity] ? "Hide" : "Show"} ${FILTER_LABELS[severity]}`}
        data-testid={`problems-filter-${severity}`}
        onclick={() => (shown[severity] = !shown[severity])}
      >
        {@render severityIcon(severity)}
        {counts[severity]}
      </button>
    {/each}
  </div>
  <div class="min-h-0 flex-1 overflow-auto px-2 py-1.5">
    {#if lang.diagnostics.length === 0}
      <div class="flex h-full items-center justify-center text-muted-foreground">
        {lang.engineStatus === "failed"
          ? "Language engine unavailable"
          : "No problems detected"}
      </div>
    {:else if groups.length === 0}
      <!-- Findings exist but every one is filtered out: say which filters. -->
      <div
        class="flex h-full items-center justify-center text-muted-foreground"
        data-testid="problems-filter-hint"
      >
        {hiddenCount} problem{hiddenCount === 1 ? "" : "s"} hidden by filters:
        {hiddenSeverities.map((s) => FILTER_LABELS[s]).join(", ")}
      </div>
    {:else}
      {#each groups as [path, findings] (path)}
        <div class="mb-1.5">
          <div class="flex items-baseline gap-1.5 px-1 py-0.5 font-medium">
            <span>{fileName(path)}</span>
            <span class="truncate font-mono text-[10px] text-muted-foreground">{path}</span>
          </div>
          {#each findings as finding, index (`${finding.path}|${finding.start}|${finding.code}|${index}`)}
            <div
              class="flex w-full items-center gap-1.5 rounded hover:bg-accent"
              data-testid="problem-entry"
            >
              <button
                type="button"
                class="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-0.5 text-left"
                data-testid="problem-open"
                onclick={() => open(finding)}
              >
                {@render severityIcon(severityOf(finding))}
                <span class="truncate">{finding.message}</span>
                <span class="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
                  {finding.start_line}:{finding.start_col}
                </span>
              </button>
              {#if finding.code_description}
                <a
                  href={finding.code_description}
                  target="_blank"
                  rel="noreferrer"
                  class="shrink-0 pr-1.5 font-mono text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  title={`Open ${finding.code} documentation`}
                  data-testid="problem-code"
                >
                  {finding.code}
                </a>
              {:else}
                <span
                  class="shrink-0 pr-1.5 font-mono text-[10px] text-muted-foreground"
                  data-testid="problem-code"
                >
                  {finding.code}
                </span>
              {/if}
            </div>
          {/each}
        </div>
      {/each}
    {/if}
  </div>
</div>
