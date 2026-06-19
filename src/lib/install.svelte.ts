// Install store (model/studio/installer.pds): owns the install lifecycle —
// status checking, deploying, and removing the project's [[install]] targets.
// A singleton shared by BuildOutput.svelte and the top-right header buttons so
// both surfaces read the same state without prop-drilling.

import {
  installProject,
  installStatus,
  uninstallProject,
  type InstallStatus,
} from "$lib/api";
import { build } from "$lib/build.svelte";
import { errorMessage } from "$lib/utils";

export class InstallStore {
  /** An install is in flight. */
  installing = $state(false);
  /** An uninstall is in flight. */
  uninstalling = $state(false);
  /** Latest known deployment state, or null if not yet checked / no project open. */
  status = $state<InstallStatus | null>(null);

  /** Re-check whether the project's files are deployed and current. */
  async refreshStatus(root: string): Promise<void> {
    try {
      this.status = await installStatus(root);
    } catch {
      this.status = null;
    }
  }

  /** Deploy the project per its dcs-studio.toml [[install]] rules. */
  async install(root: string): Promise<void> {
    if (this.installing) return;
    this.installing = true;
    try {
      const report = await installProject(root);
      build.lines.push(`Installed ${report.copied} file(s):`);
      for (const f of report.files) build.lines.push(`  + ${f}`);
    } catch (e) {
      build.lines.push(`Install failed: ${errorMessage(e)}`);
    } finally {
      this.installing = false;
      await this.refreshStatus(root);
    }
  }

  /** Remove every file the project's [[install]] rules deployed. */
  async uninstall(root: string): Promise<void> {
    if (this.uninstalling) return;
    this.uninstalling = true;
    try {
      const report = await uninstallProject(root);
      build.lines.push(`Uninstalled ${report.removed} file(s):`);
      for (const f of report.files) build.lines.push(`  - ${f}`);
    } catch (e) {
      build.lines.push(`Uninstall failed: ${errorMessage(e)}`);
    } finally {
      this.uninstalling = false;
      await this.refreshStatus(root);
    }
  }
}

export const installer = new InstallStore();
