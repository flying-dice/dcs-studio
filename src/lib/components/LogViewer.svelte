<script lang="ts">
  // DCS log viewer (model studio::logs): tail Saved Games\DCS\Logs\dcs.log so you
  // watch what your script did in-sim — prints, Lua errors, the bridge's logger
  // output — without leaving the IDE. Lines from the CURRENT mod (whose log
  // subsystem matches the mod tag — default the open project's folder name) are
  // highlighted and can be isolated. Bottom "DCS Log" tool window.
  import { app } from "$lib/state.svelte";
  import { dcsLogTail, type LogTail } from "$lib/api";
  import { cn, fileName } from "$lib/utils.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { RefreshCw, Trash2, Play, Pause } from "@lucide/svelte";

  let tail = $state<LogTail>({ text: "", truncated: false });
  let following = $state(true);
  let filter = $state("");
  // The current mod's log namespace — seeded from the open project's folder
  // name, editable to whatever tag the script logs under (e.g. the bridge's
  // logger.Logger.new("MyMod")). Lines whose subsystem matches are "ours".
  let modTag = $state("");
  let onlyMod = $state(false);
  let body: HTMLDivElement | undefined = $state();

  // Seed (and re-seed on project switch) the mod tag from the open project.
  $effect(() => {
    const root = app.rootPath;
    modTag = root ? fileName(root) : "";
  });

  // A DCS log line: `2026-06-16 08:53:27.674 INFO    SUBSYS (pid): message`.
  // Group 2 is the subsystem — used by the mod match below.
  const LINE = /^[\d.\-: ]+(ERROR|WARNING|INFO|DEBUG)\s+(\S+)/;
  type Row = { text: string; level: "error" | "warning" | "info" | "plain"; mine: boolean };

  // A line "belongs to" the current mod when its subsystem IS the tag (the
  // bridge's namespaced logger, e.g. log.write("my-mod", …)) or the tag
  // appears as a whole word in the line (how a mission script tags env.info
  // output). The length-4 floor + word boundaries stop a short folder name
  // like "DCS"/"info" from matching nearly every line.
  function modMatcher(tag: string): ((text: string, subsys: string) => boolean) | null {
    const t = tag.trim().toLowerCase();
    if (t === "") return null;
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const word = t.length >= 4 ? new RegExp(`\\b${esc}\\b`) : null;
    return (text, subsys) => subsys.toLowerCase() === t || (word?.test(text.toLowerCase()) ?? false);
  }

  function parse(text: string, isMine: (text: string, subsys: string) => boolean): Row {
    const m = LINE.exec(text);
    const level: Row["level"] = !m
      ? "plain"
      : m[1] === "ERROR"
        ? "error"
        : m[1] === "WARNING"
          ? "warning"
          : "info";
    const subsys = m?.[2] ?? "";
    return { text, level, mine: isMine(text, subsys) };
  }

  const rows = $derived.by<Row[]>(() => {
    const f = filter.trim().toLowerCase();
    const isMine = modMatcher(modTag) ?? (() => false);
    return tail.text
      .split("\n")
      .map((t) => parse(t, isMine))
      .filter((r) => (!onlyMod || r.mine) && (!f || r.text.toLowerCase().includes(f)));
  });

  const mineCount = $derived(modTag.trim() ? rows.filter((r) => r.mine).length : 0);

  async function refresh() {
    tail = await dcsLogTail();
  }

  // Poll while following; cleared on pause/unmount.
  $effect(() => {
    if (!following) return;
    void refresh();
    const id = setInterval(() => void refresh(), 1500);
    return () => clearInterval(id);
  });

  // Auto-scroll to the newest line while following.
  $effect(() => {
    rows.length;
    if (following) body?.scrollTo({ top: body.scrollHeight });
  });
</script>

<div class="flex h-full min-h-0 flex-col" data-testid="dcs-log">
  <!-- Controls -->
  <div class="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border/60 px-2 py-1">
    <span class="text-[11px] tracking-wide text-muted-foreground">DCS Log</span>
    {#if tail.truncated}
      <span
        class="rounded bg-muted px-1 text-[10px] text-muted-foreground/80"
        title="Showing the tail of a larger log">tail</span>
    {/if}

    <input
      type="text"
      placeholder="Filter…"
      bind:value={filter}
      class="ml-1 h-6 w-36 rounded-md bg-input px-2 text-[11px] outline-none placeholder:text-muted-foreground"
      data-testid="dcs-log-filter"
    />

    <span class="ml-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">mod</span>
    <input
      type="text"
      placeholder="mod tag"
      title="Log namespace of the current mod — lines whose subsystem matches are highlighted"
      bind:value={modTag}
      class="h-6 w-28 rounded-md bg-input px-2 text-[11px] outline-none placeholder:text-muted-foreground"
      data-testid="dcs-log-modtag"
    />
    <button
      type="button"
      class={cn(
        "h-6 rounded-md px-2 text-[11px]",
        onlyMod ? "bg-primary/20 text-primary" : "text-muted-foreground hover:bg-secondary",
      )}
      title="Show only lines from the current mod"
      aria-pressed={onlyMod}
      data-testid="dcs-log-only-mod"
      onclick={() => (onlyMod = !onlyMod)}
    >
      only this mod{#if mineCount > 0}&nbsp;·&nbsp;{mineCount}{/if}
    </button>

    <div class="ml-auto flex items-center gap-1">
      <Button
        variant="ghost"
        size="icon-sm"
        class="text-muted-foreground hover:text-foreground"
        title={following ? "Pause" : "Follow"}
        aria-label="Toggle follow"
        data-testid="dcs-log-follow"
        onclick={() => (following = !following)}
      >
        {#if following}<Pause />{:else}<Play />{/if}
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        class="text-muted-foreground hover:text-foreground"
        title="Refresh"
        aria-label="Refresh"
        data-testid="dcs-log-refresh"
        onclick={() => void refresh()}
      >
        <RefreshCw />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        class="text-muted-foreground hover:text-foreground"
        title="Clear view"
        aria-label="Clear view"
        data-testid="dcs-log-clear"
        onclick={() => (tail = { text: "", truncated: false })}
      >
        <Trash2 />
      </Button>
    </div>
  </div>

  <!-- Log body -->
  <div
    bind:this={body}
    class="min-h-0 flex-1 overflow-auto px-2 py-1.5 font-mono text-[11px] leading-relaxed"
    data-testid="dcs-log-body"
  >
    {#if rows.length === 0}
      <p class="px-1 text-[11px] tracking-wide text-muted-foreground">
        {#if onlyMod || filter}
          No matching log lines{modTag && onlyMod ? ` for "${modTag}"` : ""}.
        {:else}
          No DCS log output yet. Launch DCS to see what your script does in-sim.
        {/if}
      </p>
    {/if}
    {#each rows as row, i (i)}
      <div
        data-testid="dcs-log-line"
        data-mine={row.mine}
        class={cn(
          "whitespace-pre-wrap break-all rounded px-1",
          row.mine && "bg-primary/10 ring-1 ring-inset ring-primary/30",
          row.level === "error"
            ? "text-destructive"
            : row.level === "warning"
              ? "text-amber-500"
              : row.level === "info"
                ? "text-foreground/80"
                : "text-muted-foreground",
        )}
      >{row.text}</div>
    {/each}
  </div>
</div>
