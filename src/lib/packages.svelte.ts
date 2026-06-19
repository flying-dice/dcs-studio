// Packages panel store (model studio::package PackageLibrary, issue #37): the
// discovered (incoming) + installed lists, the live stale set from
// revalidation, and the pack/install/uninstall actions. Mirrors
// install.svelte.ts.

import {
  discoverPackages,
  installedPackageList,
  installPackage,
  packProject,
  revalidatePackages,
  uninstallPackage,
  type PackageEntry,
} from "./api";
import { errorMessage } from "$lib/utils";

class PackagesStore {
  /** Discovered `.dcspkg` files in the watch folder. */
  discovered = $state<PackageEntry[]>([]);
  /** Installed packages. */
  installed = $state<PackageEntry[]>([]);
  /** Ids of installed packages whose author has been revoked. */
  revokedIds = $state<string[]>([]);
  /** Ids the signing server could not be reached to confirm (fail-closed). */
  unverifiedIds = $state<string[]>([]);
  busy = $state(false);
  error = $state<string | null>(null);

  /** Whether an installed package's author has been revoked. */
  isRevoked(id: string): boolean {
    return this.revokedIds.includes(id);
  }

  /** Whether an installed package could not be revalidated (server outage). */
  isUnverified(id: string): boolean {
    return this.unverifiedIds.includes(id);
  }

  /** Refresh discovered + installed lists and the health set (revalidates
   * against the signing server). A revoked author surfaces as revoked; a
   * server outage surfaces as unverified — never silently cleared to trusted. */
  async refresh(): Promise<void> {
    this.error = null;
    try {
      this.discovered = await discoverPackages();
      this.installed = await installedPackageList();
      const health = await revalidatePackages();
      this.revokedIds = health.filter((h) => h.status === "revoked").map((h) => h.id);
      this.unverifiedIds = health.filter((h) => h.status === "unverified").map((h) => h.id);
    } catch (error) {
      this.error = errorMessage(error);
    }
  }

  /** Pack the open project into the incoming folder, then refresh. */
  async pack(root: string): Promise<void> {
    await this.run(() => packProject(root));
  }

  /** Install a discovered package, then refresh. */
  async install(artifact: string): Promise<void> {
    await this.run(() => installPackage(artifact));
  }

  /** Uninstall an installed package, then refresh. */
  async uninstall(id: string): Promise<void> {
    await this.run(() => uninstallPackage(id));
  }

  private async run(action: () => Promise<unknown>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = null;
    try {
      await action();
      await this.refresh();
    } catch (error) {
      this.error = errorMessage(error);
    } finally {
      this.busy = false;
    }
  }
}

export const packages = new PackagesStore();
