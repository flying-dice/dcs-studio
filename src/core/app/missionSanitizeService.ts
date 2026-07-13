import type { FileSystemPort } from "../ports/filesystem";
import {
  applyDesired,
  backupPath,
  scanItems,
  type MissionStatus,
} from "../domain/missionSanitize";

// Use-case service for managing MissionScripting.lua's sanitization block. Pure
// parsing/edit computation lives in core/domain/missionSanitize; this layer owns
// the file-access sequencing (read → compute → back up on first change → write)
// through the injected FileSystemPort. The backup filename and "snapshot a
// pristine copy on the first change" rule are preserved exactly.
export class MissionSanitizeService {
  constructor(private readonly fs: FileSystemPort) {}

  /** Presence/sanitized status of every item, plus whether a backup exists. */
  async status(p: string): Promise<MissionStatus> {
    let content: string;
    try {
      content = await this.fs.readText(p);
    } catch {
      return { path: p, exists: false, backupExists: await this.fs.exists(backupPath(p)), items: [] };
    }
    return {
      path: p,
      exists: true,
      backupExists: await this.fs.exists(backupPath(p)),
      items: scanItems(content),
    };
  }

  /** Apply the desired sanitized state; backs up on first change; preserves EOL. */
  async setItems(p: string, desired: Record<string, boolean>): Promise<MissionStatus> {
    const original = await this.fs.readText(p);
    const { content, changed } = applyDesired(original, desired);
    if (changed) {
      const bak = backupPath(p);
      if (!(await this.fs.exists(bak))) await this.fs.copy(p, bak);
      await this.fs.writeText(p, content);
    }
    return this.status(p);
  }

  /** Copy the pristine backup back over the live file. */
  async restore(p: string): Promise<MissionStatus> {
    const bak = backupPath(p);
    if (!(await this.fs.exists(bak))) throw new Error("No backup found.");
    await this.fs.copy(bak, p);
    return this.status(p);
  }
}
