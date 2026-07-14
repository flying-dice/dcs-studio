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

  /** Tolerant read: `{}` when the file is missing or unparsable. */
  async load(): Promise<Record<string, Subscription>> {
    return this.loadSync();
  }

  async save(subs: Record<string, Subscription>): Promise<void> {
    fs.mkdirSync(this.dataDir(), { recursive: true });
    fs.writeFileSync(this.subsFilePath(), JSON.stringify(subs, null, 2));
    this.writeUninstallBat(subs);
  }

  /** Make sure uninstall-all.bat exists (writes it from the current ledger, even
   *  when nothing is installed) — so it can always be revealed/run. */
  ensureUninstallBat(): string {
    this.writeUninstallBat(this.loadSync());
    return this.uninstallBatPath();
  }

  private loadSync(): Record<string, Subscription> {
    try {
      return JSON.parse(fs.readFileSync(this.subsFilePath(), "utf8"));
    } catch {
      return {};
    }
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
