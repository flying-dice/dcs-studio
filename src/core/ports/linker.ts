import type { LinkDefinition, InstalledLink, LinkResult, DisableResult } from "../domain/types";

// Port: create/remove the links between unpacked assets and their DCS
// destinations. Strategy (junction vs hard link vs elevated symlink) is entirely
// the adapter's concern; the core only asks for enable/disable with rollback
// semantics preserved.

export interface LinkerPort {
  /** Create all links; roll everything back on the first failure. */
  enable(defs: LinkDefinition[]): Promise<LinkResult>;
  /** Remove link entries (never their targets); each attempted independently. */
  disable(installed: InstalledLink[]): DisableResult;
}
