<script lang="ts">
  // Setup-help modal for the IDE-hosted MCP server (model studio::mcp, issue
  // #39). Hands a working config to any MCP editor on the machine: the
  // `claude mcp add` command, a raw JSON block for editors that read
  // `.mcp.json` / `mcp.json` (Cursor, VS Code, Claude Desktop), and the bare
  // URL for manual entry. The surface is unauthenticated (loopback-only), so a
  // config is just a URL — no token to copy.
  import { mcp } from "$lib/mcp.svelte";
  import { Copy, Check, X, Plug } from "@lucide/svelte";

  let { open = false, onClose }: { open?: boolean; onClose: () => void } =
    $props();

  // Which block was most recently copied (for the transient ✓ feedback).
  let copied = $state<string | null>(null);

  async function copy(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      copied = key;
      setTimeout(() => {
        if (copied === key) copied = null;
      }, 1500);
    } catch {
      // Clipboard denied (rare in the webview); the text stays selectable.
    }
  }

  // The store seeds `url`/`port` to the fixed-endpoint defaults, so no literal
  // is re-typed here.
  const url = $derived(mcp.url);

  const claudeCmd = $derived(`claude mcp add --transport http dcs-studio ${url}`);

  const rawJson = $derived(
    JSON.stringify(
      {
        mcpServers: {
          "dcs-studio": {
            type: "http",
            url,
          },
        },
      },
      null,
      2,
    ),
  );

  const blocks = $derived([
    {
      key: "claude",
      label: "Claude Code (CLI)",
      hint: "Run in any project to register the server.",
      text: claudeCmd,
    },
    {
      key: "json",
      label: "Cursor · VS Code · Claude Desktop",
      hint: "Paste into the editor's mcp.json / .mcp.json.",
      text: rawJson,
    },
    {
      key: "manual",
      label: "Manual entry",
      hint: "For editors with a URL field.",
      text: url,
    },
  ]);

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
      class="max-h-[85vh] w-[min(40rem,92vw)] overflow-y-auto rounded-xl border border-border bg-card p-5 shadow-2xl"
      role="dialog"
      aria-modal="true"
      aria-label="Connect an editor to the DCS Studio MCP server"
    >
      <!-- Header -->
      <div class="mb-1 flex items-center justify-between">
        <div class="flex items-center gap-2">
          <Plug class="size-4 text-muted-foreground" />
          <span class="text-sm font-medium text-foreground">DCS Studio MCP server</span>
        </div>
        <button
          class="text-muted-foreground hover:text-foreground"
          aria-label="Close"
          onclick={onClose}
        >
          <X class="size-4" />
        </button>
      </div>

      <!-- Status line -->
      {#if mcp.running}
        <p class="mb-4 text-[12px] text-muted-foreground">
          Serving on <span class="font-mono text-foreground">{url}</span>. Point any MCP
          editor on this machine at it with one of the configs below.
        </p>
      {:else}
        <p class="mb-4 text-[12px] text-red-500">
          Not running{#if mcp.error}&nbsp;— {mcp.error}{/if}. The fixed port
          ({mcp.port}) must be free; restart the IDE once it is.
        </p>
      {/if}

      <!-- Copy blocks -->
      <div class="flex flex-col gap-4">
        {#each blocks as b (b.key)}
          <div>
            <div class="mb-1 flex items-baseline justify-between gap-2">
              <span class="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                {b.label}
              </span>
              <button
                class="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                onclick={() => copy(b.key, b.text)}
              >
                {#if copied === b.key}
                  <Check class="size-3 text-emerald-500" /> Copied
                {:else}
                  <Copy class="size-3" /> Copy
                {/if}
              </button>
            </div>
            <p class="mb-1 text-[11px] text-muted-foreground">{b.hint}</p>
            <pre class="overflow-x-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed text-foreground"><code>{b.text}</code></pre>
          </div>
        {/each}
      </div>

      <p class="mt-4 text-[11px] text-muted-foreground">
        New projects scaffold a <span class="font-mono">.mcp.json</span> already, so an
        agent opened in the project reaches the surface with no setup. The configs above
        are for wiring up other editors on this machine. The server is loopback-only and
        unauthenticated.
      </p>
    </div>
  </div>
{/if}
