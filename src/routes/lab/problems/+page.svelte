<script lang="ts">
  // Browser test surface for the Problems panel presentation layer —
  // severity-then-span ordering, the panel-local filter toggles, and the
  // status-bar count chips (model StatusBarCountsOpenProblems) — over
  // findings seeded straight into the real `lang` store. Seeded, not
  // engine-produced: the dcs-lua engine emits errors only, so mixed
  // severities (and a code_description URL) cannot come from real Lua.
  import { onMount } from "svelte";
  import Problems from "$lib/components/Problems.svelte";
  import ProblemChips from "$lib/components/ProblemChips.svelte";
  import { lang } from "$lib/lang/intel.svelte";
  import type { Diagnostic } from "$lib/lang/provider";

  function finding(
    path: string,
    severity: string,
    code: string,
    start: number,
    line: number,
    col: number,
    codeDescription = "",
  ): Diagnostic {
    return {
      path,
      severity,
      code,
      code_description: codeDescription,
      message: `${severity} finding ${code}`,
      start,
      end: start + 2,
      start_line: line,
      start_col: col,
      end_line: line,
      end_col: col + 2,
    };
  }

  // a.lua deliberately feeds the info and warning BEFORE the errors in
  // source order, and the offset-80 error before the offset-40 one: the
  // panel must reorder to E102(40), E101(80), W001, I001. The E102 entry
  // carries a code_description so the code renders as a link.
  const FIXTURE: Diagnostic[] = [
    finding("lab/a.lua", "info", "DCS-I001", 5, 1, 6),
    finding("lab/a.lua", "warning", "DCS-W001", 20, 2, 3),
    finding("lab/a.lua", "error", "LUA-E101", 80, 6, 1),
    finding("lab/a.lua", "error", "LUA-E102", 40, 3, 5, "https://example.com/lua-e102"),
    finding("lab/b.lua", "error", "LUA-E100", 0, 1, 1),
  ];

  let ready = $state(false);
  let showPanel = $state(false);

  onMount(() => {
    lang.diagnostics = FIXTURE;
    lang.engineStatus = "ready";
    ready = true;
    return () => lang.reset();
  });
</script>

<div class="flex h-screen flex-col gap-2 p-3 text-sm" data-testid="problems-lab">
  <div class="text-xs text-muted-foreground" data-testid="lab-status">
    {ready ? "ready" : "seeding"}
  </div>
  <div class="flex items-center gap-3">
    <ProblemChips onOpen={() => (showPanel = true)} />
    <button
      type="button"
      class="rounded border px-2 py-0.5 text-xs"
      data-testid="lab-toggle-panel"
      onclick={() => (showPanel = !showPanel)}
    >
      toggle panel
    </button>
  </div>
  {#if showPanel}
    <div class="h-80 shrink-0 overflow-hidden rounded border">
      <Problems />
    </div>
  {/if}
</div>
