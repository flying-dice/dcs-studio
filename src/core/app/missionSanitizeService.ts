import { applyDesired, backupPath, type MissionStatus, scanItems } from "../domain/missionSanitize";
import {
  installTriggers,
  removeTriggers,
  type TriggerStatuses,
  triggerStatus,
} from "../domain/missionScriptTrigger";
import type { FileSystemPort } from "../ports/filesystem";

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
      return {
        path: p,
        exists: false,
        backupExists: await this.fs.exists(backupPath(p)),
        items: [],
      };
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

  /** Per-line status of the managed mod-script trigger dofile lines. */
  async triggerStatus(p: string): Promise<TriggerStatuses> {
    return triggerStatus(await this.fs.readText(p));
  }

  /** Idempotently install/fix both trigger lines; backs up on first change. */
  async installTriggers(p: string): Promise<TriggerStatuses> {
    await this.applyTriggerEdit(p, installTriggers);
    return this.triggerStatus(p);
  }

  /** Remove both trigger lines; backs up on first change. */
  async removeTriggers(p: string): Promise<TriggerStatuses> {
    await this.applyTriggerEdit(p, removeTriggers);
    return this.triggerStatus(p);
  }

  /** Read → compute the trigger edit → back up on first change → write. */
  private async applyTriggerEdit(
    p: string,
    edit: (content: string) => { content: string; changed: boolean },
  ): Promise<void> {
    const original = await this.fs.readText(p);
    const { content, changed } = edit(original);
    if (changed) {
      const bak = backupPath(p);
      if (!(await this.fs.exists(bak))) await this.fs.copy(p, bak);
      await this.fs.writeText(p, content);
    }
  }
}
