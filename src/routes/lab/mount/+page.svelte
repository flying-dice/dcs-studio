<script lang="ts">
  // Browser test surface for the WORKSPACE MOUNT path (like /lab/lua for
  // the lint pump): a LangIntel instance walking a fake filesystem through
  // the injectable IntelFs seam, driving the real provider stack. Covers
  // what the Tauri-only fs would otherwise keep out of reach: the
  // rapid-project-switch race guard, unreadable-file skip, and reset.
  import type { DirEntry } from "$lib/api";
  import { LangIntel, type IntelFs } from "$lib/lang/intel.svelte";

  // Project A: slow to walk, one broken file. Project B: instant, one
  // broken file plus one unreadable file. Opening B while A's walk is
  // still in flight must leave B's findings on screen, never A's.
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const file = (path: string): DirEntry => ({
    name: path.split("/").pop() ?? path,
    path,
    is_dir: false,
  });

  const fakeFs: IntelFs = {
    async readDir(path: string): Promise<DirEntry[]> {
      if (path.startsWith("/A")) {
        await delay(600); // keeps A's walk in flight while B mounts
        return [file("/A/a.lua")];
      }
      return [file("/B/b.lua"), file("/B/locked.lua")];
    },
    async readTextFile(path: string): Promise<string> {
      if (path === "/A/a.lua") return "function a(\n";
      if (path === "/B/b.lua") return "if x then\n";
      throw new Error(`unreadable: ${path}`);
    },
  };

  const intel = new LangIntel(fakeFs);
</script>

<div class="flex h-screen flex-col gap-2 p-3" data-testid="mount-lab">
  <div class="flex gap-2">
    <button type="button" data-testid="mount-a" onclick={() => void intel.mountWorkspace("/A")}>
      Mount A (slow)
    </button>
    <button type="button" data-testid="mount-b" onclick={() => void intel.mountWorkspace("/B")}>
      Mount B
    </button>
    <button type="button" data-testid="mount-reset" onclick={() => intel.reset()}>
      Reset
    </button>
  </div>
  <div class="text-xs" data-testid="mount-status">status: {intel.engineStatus}</div>
  <ul data-testid="mount-findings">
    {#each intel.diagnostics as finding, index (`${finding.path}|${finding.start}|${index}`)}
      <li data-testid="mount-finding">{finding.path} {finding.code}</li>
    {/each}
  </ul>
</div>
