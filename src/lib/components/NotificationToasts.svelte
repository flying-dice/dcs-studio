<script lang="ts">
  // High-severity toast overlay (issue #61): a brief, auto-dismissing herald for
  // error-severity notifications so a dead analyzer or a failed build is noticed
  // without watching the panel. The notification center stays the durable
  // record — a toast is a thin, transient view over the same store: it shows
  // only `error` entries, fades after ~5s, and clicking it focuses the panel
  // (where the entry persists). Info/success/warning never toast. Mounted once
  // globally from +layout.svelte; injectable store mirrors Notifications.svelte
  // so /lab/notifications drives it from a plain browser.
  import { onDestroy } from "svelte";
  import { CircleX, X } from "@lucide/svelte";
  import { app } from "$lib/state.svelte";
  import { notifications as appNotifications, NotificationStore } from "$lib/notifications.svelte";
  import { visibleToasts, TOAST_TTL_MS } from "$lib/notifications-classify";

  let { store = appNotifications }: { store?: NotificationStore } = $props();

  // Toasts already gone — auto-timed-out, clicked, or dismissed — filtered out
  // of view. The entry itself lives on in the store/panel; only the toast goes.
  let dismissed = $state(new Set<number>());

  const toasts = $derived(visibleToasts(store.entries, dismissed));

  // One auto-dismiss timer per toast, armed exactly once when it first appears
  // (the `has` guard stops a re-render from restarting a running countdown).
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  $effect(() => {
    for (const t of toasts) {
      if (!timers.has(t.id)) {
        timers.set(
          t.id,
          setTimeout(() => dismiss(t.id), TOAST_TTL_MS),
        );
      }
    }
  });
  onDestroy(() => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  });

  function dismiss(id: number): void {
    const next = new Set(dismissed);
    next.add(id);
    dismissed = next;
    const timer = timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(id);
    }
  }

  // The toast is just the herald — clicking it surfaces the durable panel and
  // clears the toast (the entry remains in the panel).
  function focusPanel(id: number): void {
    app.rightTool = "notifications";
    dismiss(id);
  }
</script>

{#if toasts.length > 0}
  <div
    class="pointer-events-none fixed bottom-3 right-3 z-50 flex w-80 max-w-[calc(100vw-1.5rem)] flex-col gap-2 text-[12px]"
    data-testid="notification-toasts"
  >
    {#each toasts as t (t.id)}
      <div
        class="pointer-events-auto flex items-start gap-2 rounded-md border border-red-500/40 bg-background/95 px-3 py-2 shadow-lg backdrop-blur"
        data-testid="notification-toast"
        data-severity={t.severity}
        role="status"
      >
        <CircleX class="mt-0.5 size-4 shrink-0 text-red-500" />
        <button
          type="button"
          class="min-w-0 flex-1 cursor-pointer text-left"
          data-testid="notification-toast-body"
          onclick={() => focusPanel(t.id)}
        >
          <div class="break-words text-foreground/90" data-testid="notification-toast-message">
            {t.message}{#if t.count > 1}
              <span class="font-mono text-[10px] text-muted-foreground">×{t.count}</span>
            {/if}
          </div>
          {#if t.detail}
            <div
              class="mt-0.5 line-clamp-2 whitespace-pre-wrap break-words font-mono text-[10px] text-muted-foreground"
            >
              {t.detail}
            </div>
          {/if}
        </button>
        <button
          type="button"
          class="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          data-testid="notification-toast-dismiss"
          title="Dismiss"
          aria-label="Dismiss toast"
          onclick={() => dismiss(t.id)}
        >
          <X class="size-3.5" />
        </button>
      </div>
    {/each}
  </div>
{/if}
