<script lang="ts">
  // Output panel (model/studio/build.pds, issue #6 R1): run a build of the
  // open project and watch cargo's output stream in live; install the built
  // project per its dcs-studio.toml [[install]] rules. Rendered as the IDE's
  // bottom "Output" tool window.
  import { onMount } from "svelte";
  import { app } from "$lib/state.svelte";
  import { build } from "$lib/build.svelte";
  import { installProject } from "$lib/api";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Hammer, PackageCheck, LoaderCircle } from "@lucide/svelte";

  let outputHost = $state<HTMLDivElement | undefined>();
  let installing = $state(false);

  async function install() {
    if (!app.rootPath || installing) return;
    installing = true;
    try {
      const report = await installProject(app.rootPath);
      build.lines.push(`Installed ${report.copied} file(s).`);
    } catch (e) {
      build.lines.push(`Install failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      installing = false;
    }
  }

  onMount(() => {
    void build.refreshToolchain();
  });

  // Keep the latest output in view (same pattern as LuaConsole.svelte).
  $effect(() => {
    build.lines.length;
    outputHost?.scrollTo({ top: outputHost.scrollHeight });
  });
</script>

<div class="flex h-full min-h-0 flex-col" data-testid="build-panel">
  <!-- Header row: actions + status -->
  <div class="flex h-9 shrink-0 items-center gap-1 border-b border-border/60 px-2">
    <Button
      variant="ghost"
      size="sm"
      class="text-muted-foreground hover:text-foreground"
      title="Build the open project"
      data-testid="build-run"
      disabled={build.running || !app.rootPath}
      onclick={() => app.rootPath && build.start(app.rootPath)}
    >
      {#if build.running}
        <LoaderCircle class="animate-spin" />
      {:else}
        <Hammer />
      {/if}
      Build
    </Button>
    <Button
      variant="ghost"
      size="sm"
      class="text-muted-foreground hover:text-foreground"
      title="Install per dcs-studio.toml [[install]] rules"
      data-testid="build-install"
      disabled={installing || !app.rootPath}
      onclick={() => install()}
    >
      {#if installing}
        <LoaderCircle class="animate-spin" />
      {:else}
        <PackageCheck />
      {/if}
      Install
    </Button>
    <span
      class="ml-auto truncate font-mono text-[11px] tracking-wide text-muted-foreground"
      data-testid="build-status"
    >
      {#if build.running}
        building…
      {:else if build.lastOutcome?.no_op}
        nothing to build
      {:else if build.lastOutcome}
        {build.lastOutcome.succeeded
          ? "build succeeded"
          : `build failed (exit ${build.lastOutcome.exit_code})`}
      {/if}
    </span>
  </div>

  <!-- Output: one line per cargo stdout/stderr line, newest at the bottom -->
  <div class="min-h-0 flex-1 overflow-auto px-3 py-2" bind:this={outputHost}>
    <!-- Toolchain hint: what a build would run with. -->
    <p class="mb-1 font-mono text-[11px] tracking-wide text-muted-foreground/70">
      cargo: {build.toolchain
        ? (build.toolchain.cargo ?? "not found — install Rust via rustup.rs")
        : "unknown"}
    </p>
    {#if build.lines.length === 0}
      <p class="text-[11px] tracking-wide text-muted-foreground">
        Build output appears here — Rust projects run `cargo build --release`.
      </p>
    {/if}
    {#each build.lines as line, i (i)}
      <pre
        class="whitespace-pre-wrap break-all font-mono text-xs text-foreground"
        data-testid="build-line">{line}</pre>
    {/each}
  </div>
</div>
