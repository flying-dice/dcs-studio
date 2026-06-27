<script lang="ts">
  // Help → Guides (issue #72): an in-app docs browser. A category index on the
  // left, the rendered guide on the right. Content is vendored in-repo and
  // bundled (see $lib/guides), so the whole series renders offline. The reading
  // pane reuses Prose — the same sanitized Markdown renderer the Marketplace
  // README uses. The backdrop / dialog / Escape shell mirrors McpHelpModal and
  // AboutModal; the index cross-links those two existing help surfaces.
  import { GUIDE_GROUPS, FIRST_GUIDE_KEY, guideByKey } from "$lib/guides";
  import Prose from "$lib/components/Prose.svelte";
  import { BookOpen, X, Info, Plug } from "@lucide/svelte";

  let {
    open = false,
    onClose,
    onOpenAbout,
    onOpenMcpHelp,
  }: {
    open?: boolean;
    onClose: () => void;
    // The index links to the two existing help surfaces; the parent owns their
    // open state, so opening one closes the guides viewer and shows it.
    onOpenAbout: () => void;
    onOpenMcpHelp: () => void;
  } = $props();

  let selectedKey = $state(FIRST_GUIDE_KEY);
  const current = $derived(guideByKey(selectedKey));

  let dialogEl = $state<HTMLElement>();
  let paneEl = $state<HTMLElement>();

  // Focus the dialog on open and return focus to wherever it was (the menu /
  // editor) on close — the AC's "editor focus returns".
  let restoreTarget: HTMLElement | null = null;
  $effect(() => {
    if (open) {
      if (!restoreTarget) {
        restoreTarget = document.activeElement as HTMLElement | null;
      }
      dialogEl?.focus();
    } else if (restoreTarget) {
      restoreTarget.focus();
      restoreTarget = null;
    }
  });

  function select(key: string) {
    selectedKey = key;
    // Start each guide at the top, not wherever the last (possibly long) one
    // was scrolled to.
    paneEl?.scrollTo({ top: 0 });
  }

  // Keep Tab focus inside the dialog (focus trap) and close on Escape.
  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      onClose();
      return;
    }
    if (e.key !== "Tab" || !dialogEl) return;
    const focusables = dialogEl.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])',
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    } else if (active instanceof Node && !dialogEl.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  }
</script>

<svelte:window onkeydown={open ? onKeydown : undefined} />

{#if open}
  <!-- Backdrop -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}
  >
    <div
      bind:this={dialogEl}
      tabindex="-1"
      class="flex h-[80vh] max-h-[85vh] w-[min(64rem,94vw)] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl outline-none"
      role="dialog"
      aria-modal="true"
      aria-label="DCS Studio guides"
      data-testid="guides-modal"
    >
      <!-- Header -->
      <div class="flex items-center justify-between border-b border-border px-4 py-3">
        <div class="flex items-center gap-2">
          <BookOpen class="size-4 text-muted-foreground" />
          <span class="text-sm font-medium text-foreground">Guides</span>
        </div>
        <button
          class="text-muted-foreground hover:text-foreground"
          aria-label="Close"
          onclick={onClose}
        >
          <X class="size-4" />
        </button>
      </div>

      <!-- Body: index | reading pane -->
      <div class="flex min-h-0 flex-1">
        <!-- Index -->
        <nav
          class="w-60 shrink-0 overflow-y-auto border-r border-border p-3"
          aria-label="Guide index"
          data-testid="guides-index"
        >
          {#each GUIDE_GROUPS as group (group.id)}
            <div class="mb-3">
              <div
                class="px-2 pb-1 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground"
              >
                {group.label}
              </div>
              {#each group.guides as guide (guide.key)}
                <button
                  class={selectedKey === guide.key
                    ? "block w-full rounded-md bg-accent px-2 py-1.5 text-left text-[12px] text-foreground"
                    : "block w-full rounded-md px-2 py-1.5 text-left text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground"}
                  aria-current={selectedKey === guide.key ? "page" : undefined}
                  data-testid="guide-item"
                  onclick={() => select(guide.key)}
                >
                  {guide.title}
                </button>
              {/each}
            </div>
          {/each}

          <!-- Cross-links to the existing help surfaces -->
          <div class="mt-1 border-t border-border pt-3">
            <div
              class="px-2 pb-1 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground"
            >
              More help
            </div>
            <button
              class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground"
              data-testid="guides-link-about"
              onclick={onOpenAbout}
            >
              <Info class="size-3.5" /> About DCS Studio
            </button>
            <button
              class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground"
              data-testid="guides-link-mcp"
              onclick={onOpenMcpHelp}
            >
              <Plug class="size-3.5" /> MCP server setup
            </button>
          </div>
        </nav>

        <!-- Reading pane -->
        <main
          bind:this={paneEl}
          class="flex-1 overflow-y-auto px-6 py-5 text-[13px] leading-relaxed"
          data-testid="guide-content"
        >
          {#if current}
            <Prose source={current.body} />
          {/if}
        </main>
      </div>
    </div>
  </div>
{/if}
