<script lang="ts">
  // Injection Manager: installs/updates/removes the in-DCS bridge (DLL + Lua
  // hook) into a detected DCS write dir — the in-app replacement for deploy.ps1.
  import { onMount } from "svelte";
  import { isTauri } from "@tauri-apps/api/core";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import {
    dcsDetectInstalls,
    dcsInjectionStatus,
    dcsInject,
    dcsEject,
    dcsLaunch,
    dcsStop,
    dcsLaunchStatus,
    pickFolder,
    type DcsInstall,
    type InjectionStatus,
    type LaunchStatus,
  } from "$lib/api";
  import { app } from "$lib/state.svelte";
  import { ToolActions } from "$lib/tool-actions.svelte";
  import { cn } from "$lib/utils.js";

  import { Button } from "$lib/components/ui/button/index.js";
  import { ScrollArea } from "$lib/components/ui/scroll-area/index.js";
  import { Separator } from "$lib/components/ui/separator/index.js";
  import { FolderPlus, RefreshCw } from "@lucide/svelte";

  let installs = $state<DcsInstall[]>([]);
  let selected = $state<string | null>(null);
  let status = $state<InjectionStatus | null>(null);
  let launchState = $state<LaunchStatus | null>(null);
  const ui = new ToolActions();
  const launchUi = new ToolActions();

  const anythingInstalled = $derived(
    !!status && (status.dll_installed || status.hook_installed),
  );
  const allUpToDate = $derived(
    !!status &&
      status.dll_installed &&
      status.dll_up_to_date &&
      status.hook_installed &&
      status.hook_up_to_date,
  );
  const actionLabel = $derived(
    !anythingInstalled ? "Inject" : allUpToDate ? "Reinstall" : "Update",
  );

  async function refreshStatus() {
    if (!selected) {
      status = null;
      return;
    }
    try {
      status = await dcsInjectionStatus(selected);
    } catch (e) {
      status = null;
      ui.fail(e);
    }
  }

  async function detect() {
    ui.clearNotice();
    try {
      installs = await dcsDetectInstalls();
    } catch (e) {
      installs = [];
      ui.fail(e);
    }
    if (!selected || !installs.some((i) => i.write_dir === selected)) {
      selected =
        installs.find((i) => i.valid)?.write_dir ??
        installs[0]?.write_dir ??
        null;
    }
    await refreshStatus();
  }

  async function select(writeDir: string) {
    selected = writeDir;
    ui.clearNotice();
    await refreshStatus();
  }

  async function addFolder() {
    const path = await pickFolder();
    if (!path) return;
    if (!installs.some((i) => i.write_dir === path)) {
      const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
      installs = [...installs, { name, write_dir: path, valid: true }];
    }
    await select(path);
  }

  async function inject() {
    const writeDir = selected;
    if (!writeDir) return;
    await ui.run("Bridge installed. Restart DCS to load it.", async () => {
      status = await dcsInject(writeDir);
    });
  }

  async function eject() {
    const writeDir = selected;
    if (!writeDir) return;
    await ui.run("Bridge removed.", async () => {
      status = await dcsEject(writeDir);
    });
  }

  async function refreshLaunch() {
    try {
      launchState = await dcsLaunchStatus();
    } catch {
      launchState = null;
    }
  }

  async function launch() {
    const writeDir = selected;
    if (!writeDir) return;
    await launchUi.run("DCS launching — windowed, low-spec.", async () => {
      await dcsLaunch(writeDir);
      await refreshLaunch();
    });
    // Injecting the bridge changed install status; reflect it.
    await refreshStatus();
  }

  async function stop() {
    const writeDir = selected;
    if (!writeDir) return;
    await launchUi.run("DCS stopped — bridge ejected, config restored.", async () => {
      await dcsStop(writeDir);
      await refreshLaunch();
    });
    await refreshStatus();
  }

  onMount(() => {
    detect();
    refreshLaunch();
    if (!isTauri()) return;
    // DCS exit (or an explicit stop) ejects the bridge and restores the config;
    // refresh both readouts when it lands.
    let unlisten: UnlistenFn | undefined;
    listen("launch://done", () => {
      refreshLaunch();
      refreshStatus();
    }).then((u) => (unlisten = u));
    return () => unlisten?.();
  });
</script>

<!-- One install row: status dot (emerald = up to date, amber = update
     available, muted = not installed) + state label. -->
{#snippet artifactRow(label: string, installed: boolean, upToDate: boolean)}
  <div class="flex items-center gap-2 px-3 py-1.5">
    <span
      class={cn(
        "size-1.5 shrink-0 rounded-full",
        !installed && "bg-muted-foreground/40",
        installed && (upToDate ? "bg-emerald-500" : "bg-amber-500"),
      )}
    ></span>
    <span class="flex-1 text-xs text-foreground/90">{label}</span>
    <span class="font-mono text-[10px] tracking-wide text-muted-foreground">
      {#if !installed}not installed{:else if upToDate}up to date{:else}update available{/if}
    </span>
  </div>
{/snippet}

<ScrollArea class="h-full">
  <div class="flex flex-col gap-2 pb-3">
    <!-- Detected installs -->
    <div class="flex items-center justify-between px-3 pt-1">
      <span
        class="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"
        >Installations</span
      >
      <div class="flex items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon-xs"
          class="text-muted-foreground hover:text-foreground"
          title="Add folder…"
          onclick={addFolder}
        >
          <FolderPlus />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          class="text-muted-foreground hover:text-foreground"
          title="Refresh"
          onclick={detect}
        >
          <RefreshCw />
        </Button>
      </div>
    </div>

    {#if installs.length === 0}
      <p class="px-3 text-xs text-muted-foreground">
        No DCS write dirs found in Saved Games. Use "Add folder…" to point at
        one manually.
      </p>
    {:else}
      <div class="flex flex-col px-1.5">
        {#each installs as ins (ins.write_dir)}
          <button
            type="button"
            class={cn(
              "flex flex-col items-start gap-0 rounded-md px-1.5 py-1 text-left hover:bg-muted/60",
              selected === ins.write_dir && "bg-muted",
            )}
            onclick={() => select(ins.write_dir)}
          >
            <span class="flex w-full items-center gap-1.5 text-xs">
              <span class="truncate text-foreground">{ins.name}</span>
              <span
                class={cn(
                  "ml-auto shrink-0 font-mono text-[10px]",
                  ins.valid ? "text-emerald-500" : "text-destructive",
                )}
                title={ins.valid ? "DCS write dir" : "No Config dir — may not be a DCS write dir"}
                >{ins.valid ? "✓" : "✗"}</span
              >
            </span>
            <span class="w-full truncate font-mono text-[10px] text-muted-foreground">
              {ins.write_dir}
            </span>
          </button>
        {/each}
      </div>
    {/if}

    {#if selected && status}
      <Separator />

      <!-- Artifact status for the selected install -->
      <div class="flex flex-col">
        <div class="flex items-center justify-between px-3 pb-0.5">
          <span
            class="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"
            >Bridge v{status.source_version}</span
          >
        </div>
        {@render artifactRow("Bridge DLL", status.dll_installed, status.dll_up_to_date)}
        {@render artifactRow("Export hook", status.hook_installed, status.hook_up_to_date)}
      </div>

      <!-- Actions -->
      <div class="flex flex-col gap-1.5 px-3">
        <Button
          size="sm"
          class="w-full"
          disabled={ui.busy || !status.source_available}
          onclick={inject}
        >
          {ui.busy ? "Working…" : actionLabel}
        </Button>
        {#if !status.source_available}
          <p class="text-[11px] leading-snug text-amber-500">
            Build the bridge: cargo build -p dcs-bridge --release
          </p>
        {/if}
        {#if anythingInstalled}
          <Button
            variant="destructive"
            size="sm"
            class="w-full"
            disabled={ui.busy}
            onclick={eject}
          >
            Eject
          </Button>
        {/if}
        {#if ui.notice}
          <p
            class={cn(
              "text-[11px] leading-snug",
              ui.notice.ok ? "text-emerald-500" : "text-destructive",
            )}
          >
            {ui.notice.text}
          </p>
        {/if}
      </div>

      <Separator />

      <!-- Live link readout (same semantics as the footer dot) -->
      <div class="flex items-center gap-1.5 px-3 font-mono text-[11px] tracking-wide text-muted-foreground">
        <span
          class={cn(
            "size-1.5 rounded-full",
            !app.dcsConnected && "bg-muted-foreground/40",
            app.dcsConnected && (app.dcsSimRunning ? "bg-emerald-500" : "bg-amber-500"),
          )}
        ></span>
        DCS link: {!app.dcsConnected
          ? "offline"
          : app.dcsSimRunning
            ? "mission running"
            : "connected"}
      </div>

      <Separator />

      <!-- Managed launch: inject + low-spec windowed config + start DCS;
           auto-eject and restore the config on exit. -->
      <div class="flex flex-col gap-1.5 px-3">
        <div class="flex items-center justify-between pb-0.5">
          <span
            class="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"
            >Launch</span
          >
          {#if launchState?.running}
            <span class="font-mono text-[10px] text-emerald-500">running</span>
          {/if}
        </div>
        {#if launchState?.running}
          <Button
            variant="destructive"
            size="sm"
            class="w-full"
            disabled={launchUi.busy}
            onclick={stop}
          >
            {launchUi.busy ? "Working…" : "Stop DCS"}
          </Button>
        {:else}
          <Button
            size="sm"
            class="w-full"
            disabled={launchUi.busy || !status.source_available || app.dcsConnected}
            onclick={launch}
          >
            {launchUi.busy ? "Working…" : "Launch DCS (windowed, low-spec)"}
          </Button>
          {#if app.dcsConnected}
            <p class="text-[11px] leading-snug text-muted-foreground">
              DCS is already running — stop it before launching from here.
            </p>
          {/if}
        {/if}
        {#if launchUi.notice}
          <p
            class={cn(
              "text-[11px] leading-snug",
              launchUi.notice.ok ? "text-emerald-500" : "text-destructive",
            )}
          >
            {launchUi.notice.text}
          </p>
        {/if}
      </div>
    {/if}
  </div>
</ScrollArea>
