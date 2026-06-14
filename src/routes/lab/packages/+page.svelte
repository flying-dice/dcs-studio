<script lang="ts">
  // Browser test surface for signed packages (issue #37): drives the REAL Tauri
  // package commands against the mock signing server the e2e harness spawns
  // (scripts/e2e-app.mjs: DCS_SIGNING_URL on a fixed loopback port, a temp
  // DCS_SAVED_GAMES roots). Packs a fixture project, installs it, revokes the
  // author on the server, and revalidates — exercising the whole app path:
  // pack/discover/install/uninstall + the revocation gate. Windows-only CDP
  // suite (no DCS needed thanks to the roots override).
  import { onMount } from "svelte";
  import { tempDir } from "@tauri-apps/api/path";
  import { createDir, writeTextFile } from "$lib/api";
  import { app } from "$lib/state.svelte";
  import { packages } from "$lib/packages.svelte";

  // Must match scripts/e2e-app.mjs.
  const SIGNING_URL = "http://127.0.0.1:8799";
  const PKG_NAME = "E2E Pkg";

  let ready = $state(false);
  let labError = $state("");
  let root = "";

  function join(dir: string, name: string): string {
    return `${dir.replace(/[\\/]+$/, "")}\\${name}`;
  }

  onMount(() => {
    void (async () => {
      try {
        const base = await tempDir();
        const dirName = "dcs-pkg-lab";
        await createDir(base, base, dirName).catch(() => {});
        root = join(base, dirName);
        await writeTextFile(
          join(root, "dcs-studio.toml"),
          `[project]\nname = "${PKG_NAME}"\nversion = "1.0.0"\n\n[[install]]\nsource = "mod.lua"\ndest = "{SavedGames}/Mods"\n`,
        );
        await writeTextFile(join(root, "mod.lua"), "print('packaged')\n");
        app.rootPath = root;
        // Self-clean prior-run installs so this run is deterministic.
        await packages.refresh();
        for (const pkg of packages.installed) await packages.uninstall(pkg.id);
        await packages.refresh();
        ready = true;
      } catch (error) {
        labError = error instanceof Error ? error.message : String(error);
      }
    })();
  });

  async function revokeAuthor() {
    // Direct (CORS-permitted) call to the mock; text/plain avoids preflight.
    await fetch(`${SIGNING_URL}/revoke`, {
      method: "POST",
      body: JSON.stringify({ user: "e2e-user" }),
    }).catch(() => {});
  }

  const discovered = $derived(packages.discovered.map((p) => p.name).join(","));
  const installed = $derived(packages.installed.map((p) => p.name).join(","));
  const stale = $derived(packages.staleIds.join(","));
  function installDiscovered() {
    const pkg = packages.discovered.find((p) => p.name === PKG_NAME);
    if (pkg) void packages.install(pkg.path);
  }
</script>

<div class="flex h-screen flex-col gap-2 p-3" data-testid="packages-lab">
  <div class="text-xs text-muted-foreground" data-testid="lab-status">
    {ready ? "ready" : labError ? `error: ${labError}` : "loading"}
  </div>
  <div class="flex flex-wrap items-center gap-2 text-xs">
    <button class="rounded border px-2 py-0.5" data-testid="do-pack" onclick={() => packages.pack(root)}>
      pack
    </button>
    <button class="rounded border px-2 py-0.5" data-testid="do-install" onclick={installDiscovered}>
      install
    </button>
    <button class="rounded border px-2 py-0.5" data-testid="do-revoke" onclick={revokeAuthor}>
      revoke author
    </button>
    <button class="rounded border px-2 py-0.5" data-testid="do-revalidate" onclick={() => packages.refresh()}>
      revalidate
    </button>
  </div>
  <div class="text-xs" data-testid="discovered">discovered: {discovered}</div>
  <div class="text-xs" data-testid="installed">installed: {installed}</div>
  <div class="text-xs" data-testid="stale">stale: {stale}</div>
  <pre class="shrink-0 overflow-auto rounded border p-2 text-xs" data-testid="error">{packages.error ?? ""}</pre>
</div>
