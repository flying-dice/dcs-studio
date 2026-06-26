// Marketplace panel store (model studio::market Registry, issue #10): the
// discovered listings + the discover/refresh action, and the open product page.
// Discovery searches GitHub by the `dcs-studio` topic; results are cached
// backend-side — a still-fresh cache returns without a network call, and Refresh
// forces a live search. Mirrors packages.svelte.ts.

import { isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  CANCELLED,
  marketDiscover,
  marketProduct,
  marketInstallWithProgress,
  marketInstallCancel,
  marketUninstall,
  marketInstalled,
  type InstallProgress,
  type MarketListing,
  type ProductDetail,
} from "./api";
import { errorMessage } from "$lib/utils";
import { notifications } from "./notifications.svelte";
import { marketplaceInstalledNotification } from "./notifications-classify";

class MarketplaceStore {
  /** Discovered mods (every public repo carrying the `dcs-studio` topic). */
  listings = $state<MarketListing[]>([]);
  busy = $state(false);
  error = $state<string | null>(null);
  /** Whether a discovery has *completed* (success OR failure) at least once —
   * drives empty-state copy AND stops the panel's load effect from re-firing on
   * a persistent error (it is set in `finally`, not only on success). */
  loaded = $state(false);

  /** The currently-open product page, or null while loading / on the store. */
  product = $state<ProductDetail | null>(null);
  productBusy = $state(false);
  productError = $state<string | null>(null);

  /** Ids (`owner/name`) of mods installed on this machine. */
  installedIds = $state<string[]>([]);
  installBusy = $state(false);
  installError = $state<string | null>(null);
  /** Last install/uninstall result worth surfacing: which dependencies were
   * pulled in / removed. Cleared when a new install/uninstall starts. */
  installNotice = $state<string | null>(null);
  /** Non-fatal install warnings (version mismatches, skipped optional deps). */
  installWarnings = $state<string[]>([]);
  /** Live per-node install progress, or null when no install is running. */
  installProgress = $state<InstallProgress | null>(null);

  // Monotonic token so a slow product load can't clobber a newer one (rapid
  // A→B→A navigation): only the latest call writes its result.
  #productGen = 0;

  // One persistent `install://progress` listener, attached on first install.
  // Safe to share across installs: the backend's single-flight install guard
  // means two installs' events can never interleave on this channel.
  #installListening = false;

  async #ensureInstallListener(): Promise<void> {
    if (this.#installListening || !isTauri()) return;
    let unlisten: UnlistenFn;
    try {
      unlisten = await listen<InstallProgress>("install://progress", (e) => {
        // A late event from a settled run must not resurrect the bar.
        if (this.installBusy) this.installProgress = e.payload;
      });
    } catch {
      return; // stay unlistened so the next install retries the attach
    }
    void unlisten; // persistent for the app's lifetime (single-flight channel)
    this.#installListening = true;
  }

  /** Discover mods. `force` (the Refresh button) bypasses the backend's
   * fresh-cache shortcut and does a live search. */
  async discover(force = false): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = null;
    try {
      this.listings = await marketDiscover(force);
    } catch (error) {
      this.error = errorMessage(error);
    } finally {
      // Mark loaded on BOTH paths so a failed discovery doesn't retry-loop.
      this.loaded = true;
      this.busy = false;
    }
  }

  /** Load one mod's product page (README + install plan + size). */
  async loadProduct(owner: string, name: string): Promise<void> {
    const gen = ++this.#productGen;
    this.productBusy = true;
    this.productError = null;
    this.product = null;
    // Drop any install/uninstall result from a previously-viewed product so its
    // notice/warnings/error don't bleed onto this page's install card.
    this.installError = null;
    this.installNotice = null;
    this.installWarnings = [];
    try {
      const detail = await marketProduct(owner, name);
      if (gen === this.#productGen) this.product = detail;
    } catch (error) {
      if (gen === this.#productGen) this.productError = errorMessage(error);
    } finally {
      if (gen === this.#productGen) this.productBusy = false;
    }
  }

  /** Whether a mod (`owner/name`) is installed on this machine. */
  isInstalled(id: string): boolean {
    return this.installedIds.includes(id);
  }

  /** Refresh the installed-mods set from the ledger. */
  async refreshInstalled(): Promise<void> {
    try {
      this.installedIds = await marketInstalled();
    } catch {
      this.installedIds = [];
    }
  }

  /** Install a mod and its dependencies (resolve → download → link), then
   * refresh. Surfaces the dependencies pulled in and any non-fatal warnings. */
  async install(owner: string, name: string): Promise<void> {
    if (this.installBusy) return;
    this.installBusy = true;
    this.installError = null;
    this.installNotice = null;
    this.installWarnings = [];
    this.installProgress = null;
    try {
      await this.#ensureInstallListener();
      const outcome = await marketInstallWithProgress(owner, name);
      this.installWarnings = outcome.warnings;
      this.installNotice =
        outcome.installed_deps.length > 0
          ? `Installed with ${outcome.installed_deps.length} ${
              outcome.installed_deps.length === 1 ? "dependency" : "dependencies"
            }: ${outcome.installed_deps.join(", ")}`
          : null;
      await this.refreshInstalled();
      // A finished install earns a durable, review-only notification (issue
      // #61) so it isn't missed; info severity, so it never toasts.
      notifications.add(marketplaceInstalledNotification(`${owner}/${name}`));
    } catch (error) {
      // A user cancel rolled back to nothing — a benign notice, not an error
      // (no failure notification, mirroring the publish-escalation cancel).
      if (errorMessage(error) === CANCELLED) {
        this.installNotice = "Install cancelled — nothing was installed.";
      } else {
        this.installError = errorMessage(error);
      }
    } finally {
      this.installBusy = false;
      this.installProgress = null;
    }
  }

  /** Cancel an in-progress install: roll back this pass server-side (records
   * nothing). Wired to the product page's Cancel while installing. */
  cancelInstall(): void {
    void marketInstallCancel().catch(() => {});
  }

  /** Uninstall a mod by id (`owner/name`), then refresh. Surfaces any
   * dependencies garbage-collected along with it. */
  async uninstall(id: string): Promise<void> {
    if (this.installBusy) return;
    this.installBusy = true;
    this.installError = null;
    this.installNotice = null;
    this.installWarnings = [];
    try {
      const outcome = await marketUninstall(id);
      const alsoRemoved = outcome.removed.filter((r) => r !== id);
      this.installNotice =
        alsoRemoved.length > 0
          ? `Also removed ${alsoRemoved.length} orphaned ${
              alsoRemoved.length === 1 ? "dependency" : "dependencies"
            }: ${alsoRemoved.join(", ")}`
          : null;
      await this.refreshInstalled();
    } catch (error) {
      this.installError = errorMessage(error);
    } finally {
      this.installBusy = false;
    }
  }

  /** Drop all discovered/product state — called on sign-out so the next user
   * (or the next sign-in) never sees the previous account's listings. */
  reset(): void {
    this.listings = [];
    this.error = null;
    this.loaded = false;
    this.product = null;
    this.productError = null;
    this.installedIds = [];
    this.installError = null;
    this.installNotice = null;
    this.installWarnings = [];
    this.installProgress = null;
    this.#productGen += 1; // abandon any in-flight product load
  }
}

export const marketplace = new MarketplaceStore();
