<script lang="ts">
  // Output panel (model/studio/build.pds, issue #6 R1): run a build of the
  // open project and watch cargo's output stream in live; install the built
  // project per its dcs-studio.toml [[install]] rules. Rendered as the IDE's
  // bottom "Output" tool window.
  import { onMount } from "svelte";
  import { app } from "$lib/state.svelte";
  import { build } from "$lib/build.svelte";
  import { installer } from "$lib/install.svelte";
  import { cn } from "$lib/utils.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Hammer, PackageCheck, PackageMinus, LoaderCircle } from "@lucide/svelte";

  let outputHost = $state<HTMLDivElement | undefined>();

  onMount(async () => {
    void build.refreshToolchain();
    if (app.rootPath) await installer.refreshStatus(app.rootPath);
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
      disabled={installer.installing || !app.rootPath}
      onclick={() => app.rootPath && installer.install(app.rootPath)}
    >
      {#if installer.installing}
        <LoaderCircle class="animate-spin" />
      {:else}
        <PackageCheck />
      {/if}
      Install
    </Button>
    <Button
      variant="ghost"
      size="sm"
      class="text-muted-foreground hover:text-foreground"
      title="Remove installed files"
      data-testid="build-uninstall"
      disabled={installer.uninstalling || !app.rootPath || !installer.status?.installed}
      onclick={() => app.rootPath && installer.uninstall(app.rootPath)}
    >
      {#if installer.uninstalling}
        <LoaderCircle class="animate-spin" />
      {:else}
        <PackageMinus />
      {/if}
      Uninstall
    </Button>

    {#if installer.status}
      <span class="flex items-center gap-1.5 font-mono text-[11px] tracking-wide text-muted-foreground">
        <span
          class={cn(
            "size-1.5 rounded-full",
            !installer.status.installed && "bg-muted-foreground/40",
            installer.status.installed &&
              (installer.status.up_to_date ? "bg-emerald-500" : "bg-amber-500"),
          )}
        ></span>
        {#if !installer.status.installed}
          not installed
        {:else if installer.status.up_to_date}
          installed
        {:else}
          installed · outdated
        {/if}
      </span>
    {/if}

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
