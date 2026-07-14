import type { InstallRoots, ManifestModel } from "../domain/types";

// Port: parse/emit the `dcs-studio.toml` manifest and resolve an install
// destination against the DCS roots. The adapter wraps the shipped
// media/manifest-core.js UMD; these operations are synchronous.

export interface ManifestPort {
  /** Parse manifest TOML text into the model. */
  parseToml(text: string): ManifestModel;
  /** Emit the model back to canonical TOML text. */
  emitToml(model: ManifestModel): string;
  /**
   * Resolve a manifest `dest` token (e.g. `{SavedGames}/...`) to an absolute path,
   * or null when a required root (e.g. `{GameInstall}`) is unconfigured.
   */
  resolveDest(dest: string, roots: InstallRoots): string | null;
}
