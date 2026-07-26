import * as fs from "fs";
import * as path from "path";
import { renderUninstallScript } from "../../core/domain/subscriptions";
import type { Subscription } from "../../core/domain/types";
import type { LedgerRead, SubscriptionLedgerStore } from "../../core/ports/ledger";

// Node adapter for `SubscriptionLedgerStore`: persists the ledger as
// `<dataDir>/subscriptions.json` (pretty-printed, keyed by lowercased repo — the
// frozen on-disk shape) and regenerates the derived `uninstall-all.bat` on every
// save. The bat write is best-effort: a read-only data dir must never break a
// subscription write. `dataDir` is a function so a settings change takes effect
// without reconstructing the adapter.
//
// A missing ledger is the normal first run and reads as `{}`. A ledger that
// exists but cannot be read is NOT the same thing: it is preserved as
// `subscriptions.json.corrupt`, a notice is raised for the UI to show, and the
// derived `uninstall-all.bat` is left alone — regenerating it from the empty
// read would rewrite the only escape hatch for links that are still on disk.

export class JsonLedgerStore implements SubscriptionLedgerStore {
  constructor(private readonly dataDir: () => string) {}

  /** `<dataDir>/subscriptions.json` — the frozen ledger file. */
  subsFilePath(): string {
    return path.join(this.dataDir(), "subscriptions.json");
  }

  /** `<dataDir>/uninstall-all.bat` — the derived clean-uninstall script. */
  uninstallBatPath(): string {
    return path.join(this.dataDir(), "uninstall-all.bat");
  }

  /** Where an unreadable `subscriptions.json` is preserved for recovery. */
  corruptFilePath(): string {
    return `${this.subsFilePath()}.corrupt`;
  }

  /** Tolerant read: empty `subs` when the file is missing or unreadable. */
  async load(): Promise<LedgerRead> {
    const read = this.loadSync();
    return read.quarantinedTo
      ? { subs: read.subs, recovered: { quarantinedTo: read.quarantinedTo } }
      : { subs: read.subs };
  }

  async save(subs: Record<string, Subscription>): Promise<void> {
    fs.mkdirSync(this.dataDir(), { recursive: true });
    fs.writeFileSync(this.subsFilePath(), JSON.stringify(subs, null, 2));
    this.writeUninstallBat(subs);
  }

  /** Make sure uninstall-all.bat exists (writes it from the current ledger, even
   *  when nothing is installed) — so it can always be revealed/run. Skipped when
   *  the ledger could not be read: an empty script would silently stop removing
   *  links that are still in the DCS folders. */
  ensureUninstallBat(): string {
    const read = this.loadSync();
    if (!read.quarantinedTo) this.writeUninstallBat(read.subs);
    return this.uninstallBatPath();
  }

  /** `quarantinedTo` is set exactly when the read failed and was preserved. */
  private loadSync(): { subs: Record<string, Subscription>; quarantinedTo?: string } {
    let raw: string;
    try {
      raw = fs.readFileSync(this.subsFilePath(), "utf8");
    } catch (e) {
      // No ledger yet — the normal state before the first install.
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { subs: {} };
      return this.quarantine();
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      // A valid JSON scalar or array is not a ledger; treating one as `{}` would
      // drop every subscription just as silently as a parse failure.
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return this.quarantine();
      }
      return { subs: parsed as Record<string, Subscription> };
    } catch {
      return this.quarantine();
    }
  }

  /** `uninstall-all.bat` as it was when the ledger went unreadable. */
  uninstallBatBackupPath(): string {
    return `${this.uninstallBatPath()}.corrupt`;
  }

  /**
   * Preserve the unreadable ledger beside itself, and the escape hatch with it.
   *
   * `load()` deliberately leaves `uninstall-all.bat` alone here, because
   * regenerating it from the empty read would rewrite the only record of links
   * that are still in the DCS folders. That holds until the next `save()` — one
   * install after a corruption, and the script is legitimately rewritten from a
   * ledger containing only the new mod, silently dropping every earlier entry.
   *
   * So the script is copied aside at the same moment the ledger is. Copy rather
   * than move: the live one has to keep working, and it is the version a user
   * following the warning will reach for first.
   */
  private quarantine(): { subs: Record<string, Subscription>; quarantinedTo: string } {
    let preserved = this.corruptFilePath();
    try {
      fs.renameSync(this.subsFilePath(), preserved);
    } catch {
      // Could not move it — point at where it still is rather than at nothing.
      preserved = this.subsFilePath();
    }
    try {
      fs.copyFileSync(this.uninstallBatPath(), this.uninstallBatBackupPath());
    } catch {
      // No script yet (corruption before the first install), or an unwritable
      // data dir. Best effort: the ledger copy above is the primary record.
    }
    return { subs: {}, quarantinedTo: preserved };
  }

  private writeUninstallBat(subs: Record<string, Subscription>): void {
    try {
      fs.mkdirSync(this.dataDir(), { recursive: true });
      fs.writeFileSync(
        this.uninstallBatPath(),
        renderUninstallScript(subs, this.dataDir(), this.subsFilePath()),
      );
    } catch {
      /* best-effort — a read-only data dir shouldn't break a subscription write */
    }
  }
}
