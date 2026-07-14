import * as path from "node:path";
import type { SubscriptionLedgerStore } from "../ports/ledger";
import type { ArchivePort } from "../ports/archive";
import type { DownloadPort } from "../ports/downloader";
import type { LinkerPort } from "../ports/linker";
import type { ManifestPort } from "../ports/manifest";
import type { InstallRootsPort } from "../ports/installRoots";
import type { FileSystemPort } from "../ports/filesystem";
import type { ClockPort } from "../ports/clock";
import type { InstallTarget, InstallRoots, ProductAsset, Subscription } from "../domain/types";
import type { LinkDefinition } from "../domain/types";
import { MANIFEST, keyOf, ledgerKey, sortedByName } from "../domain/subscriptions";
import { selectPayloadVolumes } from "../domain/archivePolicy";

// The subscription lifecycle use-cases (Dropzone model): subscribe = download +
// unpack into the data dir; enable = link the unpacked assets to their
// dcs-studio.toml destinations; disable = remove the links (keep the unpacked
// files); update = re-download a newer release preserving enabled state;
// unsubscribe = disable + delete the unpacked files. State lives behind the
// SubscriptionLedgerStore port; every external effect goes through a port, so a
// different ledger/marketplace backend swaps in without touching this class.

/** Progress events pushed while a subscribe/install/update runs. */
export interface Progress {
  phase: "download" | "extract" | "link" | "done";
  label: string;
  pct?: number;
}
export type OnProgress = (p: Progress) => void;

/** The resolved install plan parsed from a release's manifest (for display). */
export interface InstallPlan {
  installs: { source: string; dest: string; resolved: string | null }[];
  requires: { id: string }[];
}

/** The ports the service needs — constructor-injected as a plain object. */
export interface SubscriptionPorts {
  ledger: SubscriptionLedgerStore;
  archive: ArchivePort;
  downloader: DownloadPort;
  linker: LinkerPort;
  manifest: ManifestPort;
  roots: InstallRootsPort;
  fs: FileSystemPort;
  clock: ClockPort;
}

export class SubscriptionService {
  constructor(private readonly ports: SubscriptionPorts) {}

  private roots(): InstallRoots {
    return { savedGames: this.ports.roots.savedGames(), gameInstall: this.ports.roots.gameInstall() || "" };
  }

  /** All subscriptions, sorted by display name. */
  async list(): Promise<Subscription[]> {
    return sortedByName(await this.ports.ledger.load());
  }

  /** The subscription for `repo` (case-insensitive), or undefined. */
  async get(repo: string): Promise<Subscription | undefined> {
    return (await this.ports.ledger.load())[ledgerKey(repo)];
  }

  async isSubscribed(repo: string): Promise<boolean> {
    return !!(await this.get(repo));
  }

  async isEnabled(repo: string): Promise<boolean> {
    return !!(await this.get(repo))?.enabled;
  }

  /** Parse a release's dcs-studio.toml asset into the resolved plan (for display). */
  async fetchPlan(assets: ProductAsset[], token: string | undefined): Promise<InstallPlan | null> {
    const manifestAsset = assets.find((a) => a.name === MANIFEST);
    if (!manifestAsset) return null;
    const tmp = path.join(this.ports.roots.dataDir(), ".tmp", `${this.ports.clock.now()}-${MANIFEST}`);
    await this.ports.downloader.download(manifestAsset.url, tmp, token);
    const m = this.ports.manifest.parseToml(await this.ports.fs.readText(tmp));
    await this.ports.fs.remove(tmp);
    const r = this.roots();
    return {
      installs: m.symlink.map((s) => ({
        source: s.source,
        dest: s.dest,
        resolved: this.ports.manifest.resolveDest(s.dest, r),
      })),
      requires: m.requires_module.map((x) => ({ id: x.id })),
    };
  }

  /** Download the payload volumes and unpack them into the mod's data dir. */
  private async downloadAndUnpack(
    target: InstallTarget,
    token: string | undefined,
    onProgress: OnProgress,
  ): Promise<string> {
    if (!(await this.ports.archive.available())) {
      throw new Error("7-Zip not found — install 7-Zip (7-zip.org) to install mods.");
    }
    const volumes = selectPayloadVolumes(target.assets);
    if (!volumes.length) throw new Error("This release has no .7z payload to install.");

    const dir = path.join(this.ports.roots.dataDir(), keyOf(target.repo));
    const dl = path.join(dir, ".download");
    await this.ports.fs.remove(dl);
    await this.ports.fs.mkdirp(dl);
    for (let i = 0; i < volumes.length; i++) {
      const v = volumes[i];
      const label = `Downloading ${v.name} (${i + 1}/${volumes.length})`;
      onProgress({ phase: "download", label, pct: 0 });
      await this.ports.downloader.download(v.url, path.join(dl, v.name), token, (f) =>
        onProgress({ phase: "download", label, pct: f }),
      );
    }
    onProgress({ phase: "extract", label: "Extracting payload…" });
    // Clear prior unpacked content but keep the .download dir until extraction done.
    const entries = (await this.ports.fs.exists(dir)) ? await this.ports.fs.readDir(dir) : [];
    for (const entry of entries) {
      if (entry !== ".download") await this.ports.fs.remove(path.join(dir, entry));
    }
    await this.ports.archive.extract(path.join(dl, volumes[0].name), dir);
    await this.ports.fs.remove(dl);
    return dir;
  }

  /** Subscribe: download + unpack (does not enable/link). */
  async subscribe(target: InstallTarget, token: string | undefined, onProgress: OnProgress): Promise<Subscription> {
    const dir = await this.downloadAndUnpack(target, token, onProgress);
    const subs = await this.ports.ledger.load();
    const existing = subs[ledgerKey(target.repo)];
    const sub: Subscription = {
      repo: target.repo,
      name: target.name,
      tag: target.tag,
      dir,
      enabled: existing?.enabled ?? false,
      links: existing?.links ?? [],
    };
    subs[ledgerKey(target.repo)] = sub;
    await this.ports.ledger.save(subs);
    onProgress({ phase: "done", label: "Subscribed (downloaded & unpacked)." });
    return sub;
  }

  /** Enable: link the unpacked assets to their dcs-studio.toml destinations. */
  async enable(repo: string): Promise<void> {
    const subs = await this.ports.ledger.load();
    const sub = subs[ledgerKey(repo)];
    if (!sub) throw new Error("Not subscribed.");
    if (sub.enabled) return;
    const model = this.ports.manifest.parseToml(await this.ports.fs.readText(path.join(sub.dir, MANIFEST)));
    const r = this.roots();
    const defs: LinkDefinition[] = [];
    model.symlink.forEach((rule, i) => {
      const resolved = this.ports.manifest.resolveDest(rule.dest, r);
      if (!resolved) throw new Error(`Cannot resolve ${rule.dest} — configure {GameInstall} in Settings.`);
      defs.push({ id: `${repo}:${i}`, src: path.join(sub.dir, rule.source), dest: resolved });
    });
    const res = await this.ports.linker.enable(defs);
    if (!res.ok) throw new Error(res.message);
    sub.enabled = true;
    sub.links = res.created.map((l) => ({ id: l.id, dest: l.dest }));
    await this.ports.ledger.save(subs);
  }

  /** Disable: remove the links (keep the unpacked files). */
  async disable(repo: string): Promise<void> {
    const subs = await this.ports.ledger.load();
    const sub = subs[ledgerKey(repo)];
    if (!sub || !sub.enabled) return;
    this.ports.linker.disable(sub.links.map((l) => ({ id: l.id, installedPath: l.dest })));
    sub.enabled = false;
    sub.links = [];
    await this.ports.ledger.save(subs);
  }

  /** One-click install: subscribe + enable (the Marketplace action). */
  async install(target: InstallTarget, token: string | undefined, onProgress: OnProgress): Promise<void> {
    await this.subscribe(target, token, onProgress);
    onProgress({ phase: "link", label: "Linking into DCS…" });
    await this.enable(target.repo);
    onProgress({ phase: "done", label: "Installed." });
  }

  /** Update to a newer release: re-download, preserving enabled state. */
  async update(target: InstallTarget, token: string | undefined, onProgress: OnProgress): Promise<void> {
    const wasEnabled = await this.isEnabled(target.repo);
    if (wasEnabled) await this.disable(target.repo);
    await this.subscribe(target, token, onProgress);
    // subscribe preserves the prior enabled flag; ensure it matches wasEnabled.
    if (wasEnabled) {
      onProgress({ phase: "link", label: "Re-linking updated files…" });
      await this.enable(target.repo);
    }
    onProgress({ phase: "done", label: `Updated to ${target.tag}.` });
  }

  /** Unsubscribe: disable + delete the unpacked files + drop the ledger entry. */
  async unsubscribe(repo: string): Promise<void> {
    const subs = await this.ports.ledger.load();
    const sub = subs[ledgerKey(repo)];
    if (!sub) return;
    if (sub.enabled) this.ports.linker.disable(sub.links.map((l) => ({ id: l.id, installedPath: l.dest })));
    await this.ports.fs.remove(sub.dir);
    delete subs[ledgerKey(repo)];
    await this.ports.ledger.save(subs);
  }
}
