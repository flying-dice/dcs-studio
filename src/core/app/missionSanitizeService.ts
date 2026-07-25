import {
  applyDesired,
  backupPath,
  backupProblem,
  backupStampPath,
  type MissionStatus,
  scanItems,
  stampFor,
} from "../domain/missionSanitize";
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
    await this.writeChange(p, applyDesired(original, desired));
    return this.status(p);
  }

  /**
   * Whether the live file has moved on since DCS Studio last wrote it — a DCS
   * update replacing MissionScripting.lua, or someone editing it by hand. The
   * backup is never refreshed, so restoring in that state rewinds the file past
   * whatever changed it; the caller warns rather than doing that silently.
   * Unknown (no stamp — a backup from before stamps were written) counts as
   * not stale: there is no evidence to warn on.
   */
  async backupIsStale(p: string): Promise<boolean> {
    const stampPath = backupStampPath(p);
    if (!(await this.fs.exists(stampPath))) return false;
    const stamp = (await this.fs.readText(stampPath)).trim();
    return stamp !== stampFor(await this.fs.readText(p));
  }

  /** Whether a pristine backup exists for this file. */
  async backupExists(p: string): Promise<boolean> {
    return this.fs.exists(backupPath(p));
  }

  /** Validate the backup, then copy it back over the live file. */
  async restore(p: string): Promise<MissionStatus> {
    const bak = backupPath(p);
    if (!(await this.fs.exists(bak))) throw new Error("No backup found.");
    const content = await this.fs.readText(bak);
    const problem = backupProblem(content);
    if (problem) {
      throw new Error(
        `Refusing to restore from the backup — ${problem}. MissionScripting.lua was left as it is.`,
      );
    }
    await this.fs.copy(bak, p);
    // The live file is now the backup's content; stamp it so a later restore
    // does not read this restore itself as an outside change.
    await this.writeStamp(p, content);
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
    await this.writeChange(p, edit(original));
  }

  /**
   * The one write path: nothing to do unless the edit actually changed
   * something, and when it did, snapshot the pristine file the first time
   * before writing, then stamp what was written.
   */
  private async writeChange(p: string, edit: { content: string; changed: boolean }): Promise<void> {
    if (!edit.changed) return;
    const bak = backupPath(p);
    if (!(await this.fs.exists(bak))) await this.fs.copy(p, bak);
    await this.fs.writeText(p, edit.content);
    await this.writeStamp(p, edit.content);
  }

  /**
   * Record what the live file holds now. Best effort: the sidecar only powers
   * the "changed since we wrote it" warning, so failing to write it must never
   * turn a successful edit into a reported failure.
   */
  private async writeStamp(p: string, content: string): Promise<void> {
    try {
      await this.fs.writeText(backupStampPath(p), stampFor(content));
    } catch {
      // Ignored deliberately — see above.
    }
  }
}
