<script lang="ts">
  // Mission Scripting manager: finds DCS install dirs' Scripts\MissionScripting.lua
  // and toggles the sanitization block so mission scripts can use require/lfs/
  // os/io/package. Desanitized = line commented out; sanitized = line active.
  import { onMount } from "svelte";
  import { open } from "@tauri-apps/plugin-dialog";
  import {
    dcsDetectMissionScripts,
    dcsMissionScriptStatus,
    dcsMissionScriptSet,
    dcsMissionScriptRestore,
    type MissionScriptFile,
    type MissionScriptStatus,
  } from "$lib/api";
  import { cn } from "$lib/utils.js";

  import { Button } from "$lib/components/ui/button/index.js";
  import { ScrollArea } from "$lib/components/ui/scroll-area/index.js";
  import { Separator } from "$lib/components/ui/separator/index.js";
  import { FilePlus, RefreshCw } from "@lucide/svelte";

  let files = $state<MissionScriptFile[]>([]);
  let selected = $state<string | null>(null);
  let status = $state<MissionScriptStatus | null>(null);
  let busy = $state(false);
  let notice = $state<{ ok: boolean; text: string } | null>(null);

  const presentItems = $derived(status?.items.filter((i) => i.present) ?? []);
  const anyDesanitized = $derived(presentItems.some((i) => !i.sanitized));
  const anySanitized = $derived(presentItems.some((i) => i.sanitized));

  async function refreshStatus() {
    if (!selected) {
      status = null;
      return;
    }
    try {
      status = await dcsMissionScriptStatus(selected);
    } catch (e) {
      status = null;
      notice = { ok: false, text: String(e) };
    }
  }

  async function detect() {
    notice = null;
    try {
      files = await dcsDetectMissionScripts();
    } catch (e) {
      files = [];
      notice = { ok: false, text: String(e) };
    }
    if (!selected || !files.some((f) => f.path === selected)) {
      selected =
        files.find((f) => f.exists)?.path ?? files[0]?.path ?? null;
    }
    await refreshStatus();
  }

  async function select(path: string) {
    selected = path;
    notice = null;
    await refreshStatus();
  }

  async function locateFile() {
    const picked = await open({
      multiple: false,
      filters: [{ name: "Lua", extensions: ["lua"] }],
    });
    if (typeof picked !== "string") return;
    if (!files.some((f) => f.path === picked)) {
      const variant =
        picked.split(/[\\/]/).filter(Boolean).slice(-3, -2)[0] ?? picked;
      files = [...files, { variant, path: picked, exists: true }];
    }
    await select(picked);
  }

  async function apply(items: Record<string, boolean>, okText: string) {
    if (!selected || busy) return;
    busy = true;
    notice = null;
    try {
      status = await dcsMissionScriptSet(selected, items);
      notice = { ok: true, text: okText };
    } catch (e) {
      notice = { ok: false, text: String(e) };
    } finally {
      busy = false;
    }
  }

  function toggle(name: string, sanitized: boolean) {
    apply(
      { [name]: !sanitized },
      !sanitized ? `${name} re-sanitized.` : `${name} desanitized.`,
    );
  }

  function setAll(sanitized: boolean) {
    const items = Object.fromEntries(
      presentItems.map((i) => [i.name, sanitized]),
    );
    apply(
      items,
      sanitized ? "All items re-sanitized." : "All items desanitized.",
    );
  }

  async function restore() {
    if (!selected || busy) return;
    busy = true;
    notice = null;
    try {
      status = await dcsMissionScriptRestore(selected);
      notice = { ok: true, text: "Stock file restored from backup." };
    } catch (e) {
      notice = { ok: false, text: String(e) };
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    detect();
  });
</script>

<ScrollArea class="h-full">
  <div class="flex flex-col gap-2 pb-3">
    <!-- Detected MissionScripting.lua files -->
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
          title="Locate MissionScripting.lua…"
          onclick={locateFile}
        >
          <FilePlus />
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

    {#if files.length === 0}
      <p class="px-3 text-xs text-muted-foreground">
        No DCS installs found. Use "Locate MissionScripting.lua…" to point at
        the file manually.
      </p>
    {:else}
      <div class="flex flex-col px-1.5">
        {#each files as f (f.path)}
          <button
            type="button"
            class={cn(
              "flex flex-col items-start gap-0 rounded-md px-1.5 py-1 text-left hover:bg-muted/60",
              selected === f.path && "bg-muted",
            )}
            onclick={() => select(f.path)}
          >
            <span class="flex w-full items-center gap-1.5 text-xs">
              <span class="truncate text-foreground">{f.variant}</span>
              <span
                class={cn(
                  "ml-auto shrink-0 font-mono text-[10px]",
                  f.exists ? "text-emerald-500" : "text-destructive",
                )}
                title={f.exists
                  ? "MissionScripting.lua found"
                  : "MissionScripting.lua not found in this install"}
                >{f.exists ? "✓" : "✗"}</span
              >
            </span>
            <span class="w-full truncate font-mono text-[10px] text-muted-foreground">
              {f.path}
            </span>
          </button>
        {/each}
      </div>
    {/if}

    {#if selected && status}
      <Separator />

      {#if status.exists}
        <!-- One row per sanitization item -->
        <div class="flex flex-col">
          <div class="flex items-center justify-between px-3 pb-0.5">
            <span
              class="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"
              >Sanitization</span
            >
          </div>
          {#each status.items as item (item.name)}
            <div class="flex items-center gap-2 px-3 py-1.5">
              <span
                class={cn(
                  "size-1.5 shrink-0 rounded-full",
                  !item.present && "bg-muted-foreground/40",
                  item.present &&
                    (item.sanitized ? "bg-amber-500" : "bg-emerald-500"),
                )}
              ></span>
              <span class="flex-1 font-mono text-xs text-foreground/90">{item.name}</span>
              <span class="font-mono text-[10px] tracking-wide text-muted-foreground">
                {#if !item.present}not found{:else if item.sanitized}sanitized{:else}desanitized{/if}
              </span>
              <!-- Toggle: on (right, amber) = sanitized, off (left) = desanitized -->
              <button
                type="button"
                role="switch"
                aria-checked={item.sanitized}
                aria-label={`Toggle ${item.name} sanitization`}
                disabled={!item.present || busy}
                class={cn(
                  "relative h-3.5 w-6 shrink-0 rounded-full transition-colors",
                  !item.present && "cursor-not-allowed bg-muted-foreground/20",
                  item.present &&
                    (item.sanitized ? "bg-amber-500/80" : "bg-emerald-500/80"),
                )}
                onclick={() => toggle(item.name, item.sanitized)}
              >
                <span
                  class={cn(
                    "absolute top-0.5 size-2.5 rounded-full bg-background transition-[left]",
                    item.sanitized ? "left-3" : "left-0.5",
                  )}
                ></span>
              </button>
            </div>
          {/each}
        </div>

        {#if !status.writable}
          <p class="px-3 text-[11px] leading-snug text-amber-500">
            Requires administrator rights — restart DCS Studio as admin to edit
            this file.
          </p>
        {/if}

        <!-- Quick actions -->
        <div class="flex flex-col gap-1.5 px-3">
          <Button
            size="sm"
            class="w-full"
            disabled={busy || !anySanitized}
            onclick={() => setAll(false)}
          >
            {busy ? "Working…" : "Desanitize all"}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            class="w-full"
            disabled={busy || !anyDesanitized}
            onclick={() => setAll(true)}
          >
            Re-sanitize all
          </Button>
          {#if status.backup_exists}
            <Button
              variant="destructive"
              size="sm"
              class="w-full"
              disabled={busy}
              onclick={restore}
            >
              Restore stock
            </Button>
          {/if}
          {#if notice}
            <p
              class={cn(
                "text-[11px] leading-snug",
                notice.ok ? "text-emerald-500" : "text-destructive",
              )}
            >
              {notice.text}
            </p>
          {/if}
        </div>
      {:else}
        <p class="px-3 text-xs text-muted-foreground">
          MissionScripting.lua not found at this path.
        </p>
        {#if notice}
          <p class="px-3 text-[11px] leading-snug text-destructive">{notice.text}</p>
        {/if}
      {/if}

      <Separator />

      <p class="px-3 text-[10px] leading-snug text-muted-foreground">
        Editing MissionScripting.lua disables multiplayer integrity checks and
        is reverted by DCS updates.
      </p>
    {/if}
  </div>
</ScrollArea>
