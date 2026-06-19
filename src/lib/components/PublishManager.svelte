<script lang="ts">
  // Publish panel (model studio::publish, issue #12): share the open project to
  // GitHub (create repo + tag `dcs-studio` + push) and cut a release (uploads
  // `dcs-studio.toml`) so it appears in the Marketplace. Publishing needs a
  // write-scoped token; when the cached sign-in is read-only the store escalates
  // via the device flow and this panel shows the code.
  import { goto } from "$app/navigation";
  import { publish } from "$lib/publish.svelte";
  import { app } from "$lib/state.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Separator } from "$lib/components/ui/separator/index.js";
  import {
    Rocket,
    UploadCloud,
    Tag as TagIcon,
    ExternalLink,
    LoaderCircle,
    Store,
    GitBranch,
  } from "@lucide/svelte";

  let tag = $state("v0.1.0");
</script>

<div class="flex h-full flex-col gap-2 p-2 text-[13px]" data-testid="publish-panel">
  {#if !app.rootPath}
    <p class="px-2 py-1 text-[12px] text-muted-foreground">Open a project to publish it.</p>
  {:else if !app.session}
    <p class="px-2 py-1 text-[12px] text-muted-foreground">
      Sign in with GitHub (top-right) to publish this project.
    </p>
  {:else}
    {@const root = app.rootPath}

    {#if publish.device}
      <!-- Scope escalation in progress: enter the code at GitHub. -->
      <div class="rounded-lg border border-border bg-card p-2.5">
        <p class="text-[12px] font-medium">Authorize publishing</p>
        <p class="mt-1 text-[11px] text-muted-foreground">
          Enter this code at GitHub to grant repo access:
        </p>
        <div class="mt-1.5 flex items-center gap-2">
          <span class="select-all rounded border border-border bg-muted/40 px-2 py-1 font-mono text-base tracking-[0.25em]">
            {publish.device.user_code}
          </span>
          <a
            href={publish.device.verification_uri}
            target="_blank"
            rel="noreferrer"
            class="inline-flex items-center gap-1 text-[11px] underline underline-offset-2"
          >
            Open <ExternalLink class="size-3" />
          </a>
        </div>
        <div class="mt-2 flex items-center justify-between gap-2">
          <span class="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <LoaderCircle class="size-3 animate-spin" /> Waiting for authorization…
          </span>
          <button
            class="text-[11px] text-muted-foreground hover:text-foreground"
            onclick={() => publish.cancel()}
            data-testid="publish-cancel"
          >
            Cancel
          </button>
        </div>
      </div>
    {/if}

    <!-- ── Share ── -->
    <div class="px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      Share on GitHub
    </div>
    {#if publish.repo}
      {@const repo = publish.repo}
      <div class="rounded-lg border border-border bg-card p-2.5">
        <div class="flex items-center gap-1.5 text-[12px]">
          <GitBranch class="size-3.5 text-muted-foreground" />
          <span class="truncate font-medium">{repo.full_name}</span>
        </div>
        <div class="mt-2 flex items-center gap-3">
          <a href={repo.html_url} target="_blank" rel="noreferrer" class="inline-flex items-center gap-1 text-[11px] underline underline-offset-2">
            Repo <ExternalLink class="size-3" />
          </a>
          <button class="inline-flex items-center gap-1 text-[11px] text-foreground hover:text-muted-foreground" onclick={() => goto(`/marketplace/${repo.full_name}`)}>
            <Store class="size-3" /> View in Marketplace
          </button>
        </div>
      </div>
    {:else}
      <Button
        size="sm"
        variant="outline"
        class="gap-1.5"
        disabled={publish.busy}
        onclick={() => publish.share(root)}
        data-testid="publish-share"
      >
        {#if publish.busy && !publish.device}
          <LoaderCircle class="size-3.5 animate-spin" />
        {:else}
          <Rocket class="size-3.5" />
        {/if}
        Share on GitHub
      </Button>
      <p class="px-1 text-[11px] text-amber-600 dark:text-amber-500">
        ⚠ Creates a <strong>public</strong>, world-readable repo tagged
        <span class="font-mono">dcs-studio</span> and pushes this project's files to it.
      </p>
    {/if}

    <Separator class="my-1.5" />

    <!-- ── Release ── -->
    <div class="px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      Publish a release
    </div>
    <div class="flex items-center gap-1.5">
      <div class="relative flex-1">
        <TagIcon class="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
        <input
          bind:value={tag}
          placeholder="v0.1.0"
          spellcheck="false"
          autocomplete="off"
          class="w-full rounded-md border border-input bg-background py-1.5 pl-7 pr-2 font-mono text-[12px] outline-none focus:ring-1 focus:ring-ring"
          data-testid="publish-tag"
        />
      </div>
      <Button
        size="sm"
        variant="outline"
        class="gap-1.5"
        disabled={publish.busy || !tag.trim()}
        onclick={() => publish.publishReleaseTag(root, tag)}
        data-testid="publish-release"
      >
        <UploadCloud class="size-3.5" /> Release
      </Button>
    </div>
    {#if publish.release}
      {@const release = publish.release}
      <div class="rounded-lg border border-border bg-card p-2.5">
        <div class="text-[12px]">Released <span class="font-mono">{release.tag}</span> 🎉</div>
        <div class="mt-2 flex items-center gap-3">
          <a href={release.html_url} target="_blank" rel="noreferrer" class="inline-flex items-center gap-1 text-[11px] underline underline-offset-2">
            Release <ExternalLink class="size-3" />
          </a>
          <button class="inline-flex items-center gap-1 text-[11px] text-foreground hover:text-muted-foreground" onclick={() => goto("/marketplace")}>
            <Store class="size-3" /> Open Marketplace
          </button>
        </div>
      </div>
    {:else}
      <p class="px-1 text-[11px] text-muted-foreground">
        Uploads <span class="font-mono">dcs-studio.toml</span> so the Marketplace shows the install plan.
      </p>
    {/if}

    {#if publish.error}
      <div class="mt-1 rounded bg-destructive/10 px-2 py-1 text-[11px] text-destructive" data-testid="publish-error">
        {publish.error}
      </div>
    {/if}
  {/if}
</div>
