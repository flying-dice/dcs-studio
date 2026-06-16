<script lang="ts">
  // Header GitHub identity chip + guided sign-in modal (model studio::github,
  // issue #11) — opt-in device flow. Signed out: a "Sign in" button opens a
  // blocking modal that requests a device code and walks the user through it
  // (copy the code, open github.com/login/device, authorize), while the backend
  // polls (emitting github://authorized | github://error). Signed in: the
  // profile + a sign-out menu. The IDE is fully usable either way — the modal is
  // blocking only while open; it is never a required gate.
  import { onDestroy } from "svelte";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { app } from "$lib/state.svelte";
  import {
    githubLoginStart,
    githubLoginCancel,
    type GithubDeviceCode,
    type GithubSession,
  } from "$lib/api";
  import { Button } from "$lib/components/ui/button/index.js";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu/index.js";
  import {
    LogIn,
    LoaderCircle,
    UserRound,
    LogOut,
    ExternalLink,
    Copy,
    Check,
    X,
  } from "@lucide/svelte";

  // Modal lifecycle: `open` controls visibility; `device` is the active handshake
  // (null while the code is being requested); `error` shows a retry affordance.
  let open = $state(false);
  let device = $state<GithubDeviceCode | null>(null);
  let error = $state<string | null>(null);
  let copied = $state(false);
  let unlisteners: UnlistenFn[] = [];

  function dropListeners() {
    for (const u of unlisteners) u();
    unlisteners = [];
  }

  function close() {
    open = false;
    device = null;
    error = null;
    copied = false;
    dropListeners();
    // Stop the backend poll loop: a code the user authorizes in the browser
    // after dismissing must not silently sign them in. Harmless after a
    // successful authorize (the loop has already finished).
    void githubLoginCancel().catch(() => {});
  }

  async function start() {
    open = true;
    error = null;
    device = null;
    // Drop listeners from any prior attempt before re-attaching.
    dropListeners();
    try {
      unlisteners.push(
        await listen<GithubSession>("github://authorized", (e) => {
          app.setSession(e.payload);
          close();
        }),
      );
      unlisteners.push(
        await listen<{ message: string }>("github://error", (e) => {
          error = e.payload.message;
          device = null;
          dropListeners();
        }),
      );
      device = await githubLoginStart();
    } catch (e) {
      error = String(e);
      device = null;
      dropListeners();
    }
  }

  async function copyCode() {
    if (!device) return;
    try {
      await navigator.clipboard.writeText(device.user_code);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      // Clipboard denied (rare in the webview); the code stays selectable.
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") close();
  }

  onDestroy(dropListeners);
</script>

<svelte:window onkeydown={open ? onKeydown : undefined} />

{#if app.session}
  {@const session = app.session}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <Button
          {...props}
          variant="ghost"
          size="sm"
          class="flex items-center gap-1.5 px-1.5 text-muted-foreground hover:text-foreground"
          title={`Signed in as ${session.login}`}
        >
          {#if session.avatar_url}
            <img src={session.avatar_url} alt="" class="size-4 rounded-full" />
          {:else}
            <UserRound class="size-4" />
          {/if}
          <span class="max-w-[10rem] truncate text-xs">{session.login}</span>
        </Button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content align="end">
      <DropdownMenu.Item onclick={() => void app.signOut()}>
        <LogOut class="mr-2 size-4" />
        Sign out
      </DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{:else}
  <Button
    variant="ghost"
    size="sm"
    class="flex items-center gap-1.5 px-1.5 text-muted-foreground hover:text-foreground"
    onclick={start}
    title="Sign in with GitHub"
  >
    <LogIn class="size-4" />
    <span class="text-xs">Sign in</span>
  </Button>
{/if}

{#if open}
  <!-- Backdrop -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) close();
    }}
  >
    <div
      class="w-[min(28rem,92vw)] overflow-y-auto rounded-xl border border-border bg-card p-5 shadow-2xl"
      role="dialog"
      aria-modal="true"
      aria-label="Sign in to GitHub"
    >
      <!-- Header -->
      <div class="mb-1 flex items-center justify-between">
        <div class="flex items-center gap-2">
          <LogIn class="size-4 text-muted-foreground" />
          <span class="text-sm font-medium text-foreground">Sign in to GitHub</span>
        </div>
        <button
          class="text-muted-foreground hover:text-foreground"
          aria-label="Close"
          onclick={close}
        >
          <X class="size-4" />
        </button>
      </div>

      <p class="mb-4 text-[12px] text-muted-foreground">
        Signing in is optional — the rest of DCS Studio works without it. It lets you
        sign the packages you publish under your GitHub identity.
      </p>

      {#if error}
        <!-- Error state: explain + retry. -->
        <div class="rounded-lg border border-red-500/40 bg-red-500/5 p-3">
          <p class="text-[12px] text-red-500">Sign-in didn’t complete.</p>
          <p class="mt-1 break-words font-mono text-[11px] text-muted-foreground">{error}</p>
        </div>
        <div class="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onclick={close}>Cancel</Button>
          <Button size="sm" onclick={start}>Try again</Button>
        </div>
      {:else if device}
        {@const dev = device}
        <!-- Active handshake: step the user through it. -->
        <ol class="flex flex-col gap-4">
          <li>
            <div class="mb-1.5 flex items-baseline gap-2">
              <span class="flex size-4 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground">1</span>
              <span class="text-[12px] text-foreground">Copy this one-time code</span>
            </div>
            <div class="flex items-center gap-2 pl-6">
              <span class="select-all rounded-lg border border-border bg-muted/40 px-3 py-1.5 font-mono text-lg tracking-[0.3em] text-foreground">
                {dev.user_code}
              </span>
              <button
                class="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                onclick={copyCode}
              >
                {#if copied}
                  <Check class="size-3.5 text-emerald-500" /> Copied
                {:else}
                  <Copy class="size-3.5" /> Copy
                {/if}
              </button>
            </div>
          </li>
          <li>
            <div class="mb-1.5 flex items-baseline gap-2">
              <span class="flex size-4 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground">2</span>
              <span class="text-[12px] text-foreground">Open GitHub and paste the code</span>
            </div>
            <div class="pl-6">
              <a
                href={dev.verification_uri}
                target="_blank"
                rel="noreferrer"
                class="inline-flex items-center gap-1.5 rounded-lg border border-border bg-muted/40 px-3 py-1.5 text-[12px] text-foreground hover:bg-muted"
              >
                Open {dev.verification_uri.replace(/^https?:\/\//, "")}
                <ExternalLink class="size-3.5" />
              </a>
            </div>
          </li>
          <li>
            <div class="mb-1.5 flex items-baseline gap-2">
              <span class="flex size-4 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground">3</span>
              <span class="text-[12px] text-foreground">Authorize DCS Studio</span>
            </div>
            <div class="flex items-center gap-2 pl-6 text-[12px] text-muted-foreground">
              <LoaderCircle class="size-3.5 animate-spin" />
              Waiting for you to authorize in the browser…
            </div>
          </li>
        </ol>
        <div class="mt-5 flex justify-end">
          <Button variant="ghost" size="sm" onclick={close}>Cancel</Button>
        </div>
      {:else}
        <!-- Requesting the device code. -->
        <div class="flex items-center gap-2 py-4 text-[12px] text-muted-foreground">
          <LoaderCircle class="size-4 animate-spin" />
          Starting sign-in…
        </div>
        <div class="mt-2 flex justify-end">
          <Button variant="ghost" size="sm" onclick={close}>Cancel</Button>
        </div>
      {/if}
    </div>
  </div>
{/if}
