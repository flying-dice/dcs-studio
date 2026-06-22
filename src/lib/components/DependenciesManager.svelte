<script lang="ts">
  // Dependencies panel (model/studio/cargolua.pds `CargoLuaTasks`, issue #51):
  // the IDE face over lua-cargo. Lists the project's CargoLua.toml dependencies,
  // fetches them (vendor + lock) and bundles its `[[bundle]]` targets without a
  // terminal, and streams progress live — mirrors the Output panel
  // (BuildOutput.svelte). A successful fetch re-indexes (cargolua store) so the
  // new modules resolve and autocomplete at once.
  import { app } from "$lib/state.svelte";
  import { cargolua } from "$lib/cargolua.svelte";
  import { readTextFile } from "$lib/api";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Download, Package, RefreshCw, LoaderCircle } from "@lucide/svelte";

  type Dep = { name: string; github: string };

  let deps = $state<Dep[]>([]);
  let outputHost = $state<HTMLDivElement | undefined>();

  /** Parse `key = { github = "owner/repo", … }` rows under `[dependencies]` —
   * the same text-level shape the Marketplace "Add as dependency" writes. */
  function parseDeps(toml: string): Dep[] {
    const lines = toml.split(/\r?\n/);
    const start = lines.findIndex((l) =>
      /^\s*\[dependencies\]\s*(#.*)?$/.test(l),
    );
    if (start === -1) return [];
    const out: Dep[] = [];
    for (let i = start + 1; i < lines.length; i++) {
      if (/^\s*\[/.test(lines[i])) break; // next section
      const row = lines[i].match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.+)$/);
      if (!row) continue;
      const github = row[2].match(/github\s*=\s*"([^"]+)"/);
      out.push({ name: row[1], github: github ? github[1] : "" });
    }
    return out;
  }

  async function loadDeps(): Promise<void> {
    if (!app.rootPath) {
      deps = [];
      return;
    }
    const sep = app.rootPath.includes("\\") ? "\\" : "/";
    const path = `${app.rootPath.replace(/[\\/]+$/, "")}${sep}CargoLua.toml`;
    try {
      deps = parseDeps(await readTextFile(path));
    } catch {
      deps = []; // no manifest yet
    }
  }

  // Re-read the manifest when the project changes and after each run completes
  // (a fetch may follow an Add-as-dependency that wrote a new line).
  $effect(() => {
    app.rootPath;
    cargolua.lastOutcome;
    void loadDeps();
  });

  // Keep the latest output in view (same pattern as BuildOutput.svelte).
  $effect(() => {
    cargolua.lines.length;
    outputHost?.scrollTo({ top: outputHost.scrollHeight });
  });
</script>

<div class="flex h-full min-h-0 flex-col" data-testid="dependencies-panel">
  <!-- Header row: actions + status -->
  <div class="flex h-9 shrink-0 items-center gap-1 border-b border-border/60 px-2">
    <Button
      variant="ghost"
      size="sm"
      class="text-muted-foreground hover:text-foreground"
      title="Fetch (vendor + lock) the project's dependencies"
      data-testid="deps-fetch"
      disabled={cargolua.running || !app.rootPath}
      onclick={() => app.rootPath && cargolua.fetch(app.rootPath)}
    >
      {#if cargolua.running && cargolua.task === "fetch"}
        <LoaderCircle class="animate-spin" />
      {:else}
        <Download />
      {/if}
      Fetch
    </Button>
    <Button
      variant="ghost"
      size="sm"
      class="text-muted-foreground hover:text-foreground"
      title="Bundle the project's [[bundle]] targets into one file"
      data-testid="deps-bundle"
      disabled={cargolua.running || !app.rootPath}
      onclick={() => app.rootPath && cargolua.bundle(app.rootPath)}
    >
      {#if cargolua.running && cargolua.task === "bundle"}
        <LoaderCircle class="animate-spin" />
      {:else}
        <Package />
      {/if}
      Bundle
    </Button>
    <Button
      variant="ghost"
      size="icon-sm"
      class="text-muted-foreground hover:text-foreground"
      title="Reload CargoLua.toml"
      data-testid="deps-reload"
      disabled={!app.rootPath}
      onclick={() => loadDeps()}
    >
      <RefreshCw />
    </Button>

    <span
      class="ml-auto truncate font-mono text-[11px] tracking-wide text-muted-foreground"
      data-testid="deps-status"
    >
      {#if cargolua.running}
        {cargolua.task === "bundle" ? "bundling…" : "fetching…"}
      {:else if cargolua.lastOutcome}
        {cargolua.lastOutcome.succeeded
          ? cargolua.lastOutcome.summary
          : `failed: ${cargolua.lastOutcome.summary}`}
      {/if}
    </span>
  </div>

  <!-- Declared dependencies, from CargoLua.toml -->
  <div class="max-h-40 shrink-0 overflow-auto border-b border-border/60 px-3 py-2">
    {#if deps.length === 0}
      <p class="text-[11px] tracking-wide text-muted-foreground">
        No dependencies — add one from the Marketplace, or declare it in
        CargoLua.toml, then Fetch.
      </p>
    {:else}
      <ul class="flex flex-col gap-0.5">
        {#each deps as dep (dep.name)}
          <li
            class="flex items-baseline justify-between gap-2 font-mono text-xs"
            data-testid="dep-row"
          >
            <span class="text-foreground">{dep.name}</span>
            <span class="truncate text-muted-foreground">{dep.github}</span>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <!-- Output: one line per fetch/bundle step, newest at the bottom -->
  <div class="min-h-0 flex-1 overflow-auto px-3 py-2" bind:this={outputHost}>
    {#if cargolua.lines.length === 0}
      <p class="text-[11px] tracking-wide text-muted-foreground">
        Fetch vendors dependencies into <code>.lua-cargo/deps</code>; Bundle
        amalgamates <code>[[bundle]]</code> targets. Output appears here.
      </p>
    {/if}
    {#each cargolua.lines as line, i (i)}
      <pre
        class="whitespace-pre-wrap break-all font-mono text-xs text-foreground"
        data-testid="deps-line">{line}</pre>
    {/each}
  </div>
</div>
