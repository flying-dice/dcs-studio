<script lang="ts">
  // Packages panel (model studio::package, issue #37): pack the open project
  // into a signed .dcspkg, install/uninstall discovered packages, and surface
  // installed packages whose author has been revoked as STALE — revalidation
  // hits the signing server on open, so revocation shows up no matter where the
  // package came from.
  import { onMount } from "svelte";
  import { packages } from "$lib/packages.svelte";
  import { app } from "$lib/state.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { ScrollArea } from "$lib/components/ui/scroll-area/index.js";
  import { Separator } from "$lib/components/ui/separator/index.js";
  import { Package, Download, Trash2, RefreshCw, ShieldAlert } from "@lucide/svelte";

  onMount(() => void packages.refresh());
</script>

<div class="flex h-full flex-col gap-2 p-2 text-[13px]" data-testid="packages-panel">
  <div class="flex items-center gap-2">
    <Button
      size="sm"
      variant="outline"
      class="gap-1.5"
      data-testid="pkg-pack"
      disabled={!app.rootPath || packages.busy}
      onclick={() => app.rootPath && packages.pack(app.rootPath)}
    >
      <Package class="size-3.5" />
      Pack this project
    </Button>
    <Button
      size="icon-sm"
      variant="ghost"
      title="Refresh"
      data-testid="pkg-refresh"
      disabled={packages.busy}
      onclick={() => packages.refresh()}
    >
      <RefreshCw class={packages.busy ? "animate-spin" : ""} />
    </Button>
  </div>

  {#if packages.error}
    <div class="rounded bg-destructive/10 px-2 py-1 text-[11px] text-destructive" data-testid="pkg-error">
      {packages.error}
    </div>
  {/if}

  <ScrollArea class="min-h-0 flex-1">
    <!-- Available to install -->
    <div class="px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      Available
    </div>
    {#if packages.discovered.length === 0}
      <div class="px-2 py-1 text-[11px] text-muted-foreground" data-testid="pkg-available-empty">
        No packages in the incoming folder.
      </div>
    {:else}
      {#each packages.discovered as pkg (pkg.id)}
        <div
          class="flex items-center gap-2 rounded px-2 py-1 hover:bg-accent/50"
          data-testid="pkg-available-row"
        >
          <Package class="size-3.5 shrink-0 text-muted-foreground" />
          <div class="min-w-0 flex-1">
            <div class="truncate font-medium">{pkg.name}</div>
            <div class="truncate font-mono text-[10px] text-muted-foreground">by {pkg.author}</div>
          </div>
          <Button
            size="icon-sm"
            variant="ghost"
            title="Install"
            data-testid="pkg-install"
            disabled={packages.busy}
            onclick={() => packages.install(pkg.path)}
          >
            <Download class="size-3.5" />
          </Button>
        </div>
      {/each}
    {/if}

    <Separator class="my-2" />

    <!-- Installed -->
    <div class="px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      Installed
    </div>
    {#if packages.installed.length === 0}
      <div class="px-2 py-1 text-[11px] text-muted-foreground" data-testid="pkg-installed-empty">
        Nothing installed.
      </div>
    {:else}
      {#each packages.installed as pkg (pkg.id)}
        <div
          class="flex items-center gap-2 rounded px-2 py-1 hover:bg-accent/50"
          data-testid="pkg-installed-row"
          data-revoked={packages.isRevoked(pkg.id)}
          data-unverified={packages.isUnverified(pkg.id)}
        >
          <Package class="size-3.5 shrink-0 text-muted-foreground" />
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5">
              <span class="truncate font-medium">{pkg.name}</span>
              {#if packages.isRevoked(pkg.id)}
                <span
                  class="flex shrink-0 items-center gap-1 rounded bg-destructive/15 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-destructive"
                  title="The author was revoked — this package is no longer trusted"
                  data-testid="pkg-stale-badge"
                >
                  <ShieldAlert class="size-2.5" />
                  revoked
                </span>
              {:else if packages.isUnverified(pkg.id)}
                <span
                  class="flex shrink-0 items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-amber-600 dark:text-amber-500"
                  title="The signing server could not be reached — trust unconfirmed"
                  data-testid="pkg-unverified-badge"
                >
                  <ShieldAlert class="size-2.5" />
                  unverified
                </span>
              {/if}
            </div>
            <div class="truncate font-mono text-[10px] text-muted-foreground">by {pkg.author}</div>
          </div>
          <Button
            size="icon-sm"
            variant="ghost"
            title="Uninstall"
            data-testid="pkg-uninstall"
            disabled={packages.busy}
            onclick={() => packages.uninstall(pkg.id)}
          >
            <Trash2 class="size-3.5" />
          </Button>
        </div>
      {/each}
    {/if}
  </ScrollArea>
</div>
