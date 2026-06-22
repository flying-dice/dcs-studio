<script lang="ts">
  // About dialog (Help → About DCS Studio, issue #59): the app name, the REAL
  // version (sourced from $lib/version — package.json, never hardcoded), and
  // external links to the repository and docs. Mirrors McpHelpModal's
  // backdrop / dialog / Escape shell. Links open in the OS browser via
  // openExternal so a click never navigates the Tauri webview off the editor.
  import { APP_VERSION } from "$lib/version";
  import { openExternal } from "$lib/external";
  import { Boxes, X, ExternalLink } from "@lucide/svelte";

  let { open = false, onClose }: { open?: boolean; onClose: () => void } =
    $props();

  // The project's home + docs. Declared here because the repo URL lives nowhere
  // else in the frontend; the docs link points at the in-repo keybindings guide.
  const REPO_URL = "https://gitlab.beluga-sirius.ts.net/flying-dice/dcs-studio";
  const links = [
    { label: "Repository", href: REPO_URL },
    { label: "Keyboard shortcuts", href: `${REPO_URL}/-/blob/main/docs/keybindings.md` },
  ];

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") onClose();
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
      class="w-[min(26rem,92vw)] rounded-xl border border-border bg-card p-5 shadow-2xl"
      role="dialog"
      aria-modal="true"
      aria-label="About DCS Studio"
      data-testid="about-modal"
    >
      <!-- Header: brand + real version -->
      <div class="mb-3 flex items-start justify-between">
        <div class="flex items-center gap-2.5">
          <Boxes class="size-5 text-foreground" />
          <div class="flex flex-col">
            <span class="text-sm font-semibold text-foreground">DCS Studio</span>
            <span class="font-mono text-[11px] text-muted-foreground" data-testid="about-version">
              v{APP_VERSION}
            </span>
          </div>
        </div>
        <button
          class="text-muted-foreground hover:text-foreground"
          aria-label="Close"
          onclick={onClose}
        >
          <X class="size-4" />
        </button>
      </div>

      <p class="mb-4 text-[12px] leading-relaxed text-muted-foreground">
        Author, manage, and package Digital Combat Simulator mods.
      </p>

      <!-- External links -->
      <div class="flex flex-col gap-1">
        {#each links as l (l.href)}
          <button
            class="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-foreground hover:bg-accent"
            onclick={() => void openExternal(l.href)}
          >
            <ExternalLink class="size-3.5 text-muted-foreground" />
            {l.label}
          </button>
        {/each}
      </div>
    </div>
  </div>
{/if}
