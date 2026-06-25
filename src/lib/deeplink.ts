// Deep-link consumer (model studio::deeplink, issue #44): turns a routed
// `dcs-studio://` link — classified in Rust (crates/app/src/deeplink.rs) and
// emitted as `deeplink://navigate` — into IDE navigation. `marketplace` opens a
// mod's product page; `open` loads a local project (the path is already
// validated as a recognized project root before it reaches here). A cold-start
// link routed before this listener was attached is drained once on init via
// `deeplink_take_pending`. A no-op outside Tauri (no Rust side to route).

import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { goto } from "$app/navigation";
import { app } from "./state.svelte";

/** The navigation payload emitted by the Rust router (matches `Route`). */
type DeepLinkNav =
  | { kind: "marketplace"; owner: string; repo: string }
  | { kind: "open"; path: string };

const NAVIGATE_EVENT = "deeplink://navigate";

/** Apply one routed link: navigate to a product page, or open a project. */
async function apply(nav: DeepLinkNav): Promise<void> {
  switch (nav.kind) {
    case "marketplace":
      await goto(`/marketplace/${nav.owner}/${nav.repo}`);
      break;
    case "open":
      await app.openPath(nav.path);
      break;
  }
}

class DeepLinks {
  private armed = false;

  /** Arm the live listener and drain any cold-start link. Called once from the
   * root layout; idempotent and a no-op outside Tauri. */
  async init(): Promise<void> {
    if (this.armed || !isTauri()) return;
    this.armed = true;
    await listen<DeepLinkNav>(NAVIGATE_EVENT, (e) => void apply(e.payload));
    // A link that cold-started the IDE was routed before this listener existed;
    // drain it now (`null` in the common already-running case).
    const pending = await invoke<DeepLinkNav | null>("deeplink_take_pending");
    if (pending) await apply(pending);
  }
}

export const deeplinks = new DeepLinks();
