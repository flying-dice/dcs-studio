import * as fs from "fs";
import * as path from "path";
import { renderUninstallScript } from "../../core/domain/subscriptions";
import type { Subscription } from "../../core/domain/types";
import type { SubscriptionLedgerStore } from "../../core/ports/ledger";

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

  /** Set when an unreadable ledger was preserved; consumed by takeCorruptNotice. */
  private corruptNotice: string | undefined;

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

  /** Tolerant read: `{}` when the file is missing or could not be read. */
  async load(): Promise<Record<string, Subscription>> {
    return this.loadSync().subs;
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
    if (!read.unreadable) this.writeUninstallBat(read.subs);
    return this.uninstallBatPath();
  }

  /**
   * The path an unreadable ledger was preserved at, if one has been quarantined
   * since this was last called — the message the UI owes the user. Consumed on
   * read, so the warning is shown once per corruption rather than per refresh.
   */
  takeCorruptNotice(): string | undefined {
    const notice = this.corruptNotice;
    this.corruptNotice = undefined;
    return notice;
  }

  private loadSync(): { subs: Record<string, Subscription>; unreadable: boolean } {
    let raw: string;
    try {
      raw = fs.readFileSync(this.subsFilePath(), "utf8");
    } catch (e) {
      // No ledger yet — the normal state before the first install.
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { subs: {}, unreadable: false };
      return this.quarantine();
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      // A valid JSON scalar or array is not a ledger; treating one as `{}` would
      // drop every subscription just as silently as a parse failure.
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return this.quarantine();
      }
      return { subs: parsed as Record<string, Subscription>, unreadable: false };
    } catch {
      return this.quarantine();
    }
  }

  /** Preserve the unreadable ledger beside itself and raise the notice. */
  private quarantine(): { subs: Record<string, Subscription>; unreadable: true } {
    let preserved = this.corruptFilePath();
    try {
      fs.renameSync(this.subsFilePath(), preserved);
    } catch {
      // Could not move it — point at where it still is rather than at nothing.
      preserved = this.subsFilePath();
    }
    this.corruptNotice = preserved;
    return { subs: {}, unreadable: true };
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
