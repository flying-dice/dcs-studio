<script lang="ts">
  // Notifications panel (model studio::notifications, issue #56): a reverse-
  // chronological history of the transient IDE events that otherwise only flash
  // — build outcomes, DCS link transitions, managed-launch exits, publish
  // results, MCP bind errors. Each row shows a severity, a source chip, a human
  // message, and a relative timestamp; actionable rows navigate on click (a
  // failed build opens Output, a publish error focuses Publish, an engine crash
  // opens Problems). Opening the panel marks everything read and clears the
  // rail's bell badge. Mirrors the Todos panel trio (store + component +
  // +page.svelte registration).
  import { onMount } from "svelte";
  import {
    CircleCheck,
    CircleX,
    Info,
    TriangleAlert,
    X,
    Trash2,
    BellOff,
    type LucideIcon,
  } from "@lucide/svelte";
  import { app } from "$lib/state.svelte";
  import { notifications as appNotifications, NotificationStore } from "$lib/notifications.svelte";
  import { relativeTime, type NotificationAction, type Severity } from "$lib/notifications-classify";
  import { cn } from "$lib/utils.js";

  // Injectable store so /lab/notifications drives the real list, dismiss, and
  // clear from a plain browser (same seam convention as Todos's `store` prop).
  let { store = appNotifications }: { store?: NotificationStore } = $props();

  // Per-severity icon + tone, drawn from the status bar's palette
  // (sky/emerald/amber/red) so the IDE reads consistently.
  const SEVERITY: Record<Severity, { icon: LucideIcon; tone: string }> = {
    info: { icon: Info, tone: "text-sky-500" },
    success: { icon: CircleCheck, tone: "text-emerald-500" },
    warning: { icon: TriangleAlert, tone: "text-amber-500" },
    error: { icon: CircleX, tone: "text-red-500" },
  };

  // A ticking clock so "2m ago" stays honest while the panel is open, without a
  // per-row timer — 30s is finer than the smallest unit the format prints.
  let now = $state(Date.now());

  onMount(() => {
    // Opening marks the backlog read (clears the badge) and keeps arrivals
    // while open from re-raising it; the cleanup releases both.
    store.setOpen(true);
    const tick = setInterval(() => (now = Date.now()), 30_000);
    return () => {
      clearInterval(tick);
      store.setOpen(false);
    };
  });

  // Map a notification's intent to a concrete panel toggle. The store/util stays
  // UI-agnostic (it only knows "open-output" / "focus-publish"); the panel owns
  // which tool that is — the same navigation app.bottomTool/toggleTool the
  // Output shortcut and ProblemChips already use.
  function navigate(action: NotificationAction) {
    if (action === "open-output") app.bottomTool = "output";
    else if (action === "open-problems") app.bottomTool = "problems";
    else app.rightTool = "publish"; // focus-publish
  }
</script>

<div class="flex h-full flex-col text-[12px]" data-testid="notifications-panel">
  <div class="flex shrink-0 items-center gap-2 border-b border-border/60 px-2 py-1">
    <span class="font-mono text-[10px] text-muted-foreground" data-testid="notifications-count">
      {store.entries.length}
      {store.entries.length === 1 ? "notification" : "notifications"}
    </span>
    {#if store.entries.length > 0}
      <button
        type="button"
        class="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        data-testid="notifications-clear"
        title="Clear all notifications"
        onclick={() => store.clear()}
      >
        <Trash2 class="size-3.5" />
        Clear all
      </button>
    {/if}
  </div>
  <div class="min-h-0 flex-1 overflow-auto px-1.5 py-1.5">
    {#if store.entries.length === 0}
      <div
        class="flex h-full flex-col items-center justify-center gap-1.5 text-muted-foreground"
        data-testid="notifications-empty"
      >
        <BellOff class="size-5 opacity-60" />
        No notifications
      </div>
    {:else}
      {#each store.entries as n (n.id)}
        {@const Icon = SEVERITY[n.severity].icon}
        <div
          class="group flex items-start gap-2 rounded px-1.5 py-1 hover:bg-accent"
          data-testid="notification"
          data-severity={n.severity}
        >
          <Icon class={cn("mt-0.5 size-3.5 shrink-0", SEVERITY[n.severity].tone)} />

          {#snippet body()}
            <div class="flex items-baseline gap-1.5">
              <span
                class="shrink-0 rounded bg-muted px-1 font-mono text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
                data-testid="notification-source">{n.source}</span
              >
              {#if n.count > 1}
                <span
                  class="shrink-0 rounded bg-muted px-1 font-mono text-[10px] font-semibold text-muted-foreground"
                  data-testid="notification-count"
                  title={`Repeated ${n.count} times`}>×{n.count}</span
                >
              {/if}
              <span
                class="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground"
                data-testid="notification-time">{relativeTime(now, n.at)}</span
              >
            </div>
            <div class="mt-0.5 break-words text-foreground/90" data-testid="notification-message">
              {n.message}
            </div>
            {#if n.detail}
              <div
                class="mt-0.5 line-clamp-3 whitespace-pre-wrap break-words font-mono text-[10px] text-muted-foreground"
                data-testid="notification-detail"
              >
                {n.detail}
              </div>
            {/if}
          {/snippet}

          {#if n.action}
            {@const action = n.action}
            <button
              type="button"
              class="min-w-0 flex-1 cursor-pointer text-left"
              data-testid="notification-body"
              data-actionable="true"
              onclick={() => navigate(action)}
            >
              {@render body()}
            </button>
          {:else}
            <div class="min-w-0 flex-1" data-testid="notification-body">
              {@render body()}
            </div>
          {/if}

          <button
            type="button"
            class="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-background hover:text-foreground group-hover:opacity-100"
            data-testid="notification-dismiss"
            title="Dismiss"
            aria-label="Dismiss notification"
            onclick={() => store.dismiss(n.id)}
          >
            <X class="size-3.5" />
          </button>
        </div>
      {/each}
    {/if}
  </div>
</div>
