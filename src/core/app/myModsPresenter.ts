import type { EntrypointLaunchPlan } from "../domain/entrypointLaunch";
import {
  entrypointConsentKey,
  entrypointRunKey,
  resolveEntrypointLaunch,
} from "../domain/entrypointLaunch";
import { errorText } from "../domain/errorText";
import { deriveInstallManifestView } from "../domain/installManifestView";
import { isUpToDate, toModDto } from "../domain/subscriptions";
import type { InstallRoots } from "../domain/types";
import type { AuthPort } from "../ports/auth";
import type { InstallRootsPort } from "../ports/installRoots";
import type { MarketplacePort } from "../ports/marketplace";
import type { SubscriptionService } from "./subscriptionService";

// The "My Mods" decision logic, lifted out of the VS Code panel.
//
// My Mods is the only place a user can take back what a mod did to their DCS
// install, and every one of those rules — which mods are actionable, what the
// launch prompt says, what a refused launch does, update-vs-reinstall, the
// entrypoint consent rules — used to live welded to a webview shell, so none of
// them could be asserted without an extension host. This module owns them and
// knows nothing about VS Code; the panel is left holding the webview, the URI
// plumbing and the effects below.
//
// Outgoing webview messages go through `post`; anything that needs the editor is
// described as a `MyModsEffect` for the adapter to perform, so a test asserts on
// values rather than on spies over a mocked API. The one exception is `confirm`:
// a modal question has an answer the rules branch on, so it is a dependency
// (asked and awaited), not a fire-and-forget effect.

/** Something only the editor can do, described rather than done. */
export type MyModsEffect =
  | { kind: "info"; message: string }
  | { kind: "warn"; message: string }
  | { kind: "failed"; message: string; cause: unknown }
  | { kind: "openExternal"; url: string }
  | { kind: "openDocs"; page: string }
  | { kind: "reveal"; path: string }
  | { kind: "createShortcut" }
  | { kind: "runUninstallScript"; path: string };

/** A modal question, and the actions offered as answers (dismissal is absent). */
export interface MyModsConfirm {
  message: string;
  detail?: string;
  actions: string[];
}

/** The message shapes the My Mods webview sends the host. */
export interface MyModsInbound {
  type: string;
  repo?: string;
  url?: string;
  id?: string;
  page?: string;
}

/**
 * The ledger surface My Mods consumes. Deliberately NOT `SubscriptionLedgerStore`:
 * that port declares `load`/`save`, and none of the three below — the panel never
 * reads or writes the ledger itself, it asks the service. Kept narrow so a
 * different ledger backend implements exactly what this consumer needs.
 */
export interface MyModsLedger {
  /** Write `uninstall-all.bat` if missing and answer its path. */
  ensureUninstallBat(): string;
  /** Where `uninstall-all.bat` lives, without writing it. */
  uninstallBatPath(): string;
  /** The path an unreadable ledger was preserved at, once per corruption. */
  takeCorruptNotice(): string | undefined;
}

/**
 * The tracked-process launcher, as My Mods drives it.
 *
 * `setOnChange` is the panel's half rather than the presenter's: a tracked
 * process exiting on its own is the one input neither the user nor the webview
 * produces, and the panel turns it into a redraw. It belongs here anyway,
 * because the alternative was the panel naming the concrete `ProcessLauncher`
 * to get at it — the crossing #61 tracks.
 */
export interface EntrypointLauncher {
  isRunning(key: string): boolean;
  launch(key: string, plan: EntrypointLaunchPlan): void;
  stop(key: string): void;
  /** Register the listener told (with the key) when a tracked process ends. */
  setOnChange(fn: (key: string, error?: string) => void): void;
}

/** Persisted "always allow this mod's executable" consent, keyed opaquely. */
export interface ConsentStore {
  granted(key: string): boolean;
  remember(key: string): Promise<void>;
}

export interface MyModsPresenterDeps {
  subs: Pick<SubscriptionService, "list" | "enable" | "disable" | "unsubscribe" | "update">;
  ledger: MyModsLedger;
  market: MarketplacePort;
  launcher: EntrypointLauncher;
  roots: InstallRootsPort;
  auth: AuthPort;
  consent: ConsentStore;
  /** The data dir, read fresh so a settings change shows up on the next redraw. */
  dataDir: () => string;
  /** Deliver a message to the webview. */
  post: (msg: unknown) => void;
  /** Perform an editor-side effect. */
  effect: (effect: MyModsEffect) => void;
  /** Ask the user a modal question; resolves to the chosen action, or undefined. */
  confirm: (request: MyModsConfirm) => Promise<string | undefined>;
}

export class MyModsPresenter {
  constructor(private readonly deps: MyModsPresenterDeps) {}

  async handle(msg: MyModsInbound): Promise<void> {
    const repo = msg.repo;
    switch (msg.type) {
      case "refresh":
        await this.refresh();
        break;
      case "enable":
        if (repo) await this.act(repo, () => this.deps.subs.enable(repo), "Enabled");
        break;
      case "disable":
        if (repo) {
          await this.stopRepoEntrypoints(repo); // stop running exes before unlinking
          await this.act(repo, () => this.deps.subs.disable(repo), "Disabled");
        }
        break;
      case "uninstall":
        if (repo) {
          await this.stopRepoEntrypoints(repo);
          await this.act(repo, () => this.deps.subs.unsubscribe(repo), "Uninstalled");
        }
        break;
      case "launch":
        if (repo && msg.id) await this.launchEntrypoint(repo, msg.id);
        break;
      case "stop":
        if (repo && msg.id) this.stopEntrypoint(repo, msg.id);
        break;
      case "update":
        if (repo) await this.runUpdate(repo);
        break;
      case "openDir":
        if (repo) {
          const sub = (await this.deps.subs.list()).find((s) => s.repo === repo);
          if (sub) this.deps.effect({ kind: "reveal", path: sub.dir });
        }
        break;
      case "openExternal":
        if (msg.url) this.deps.effect({ kind: "openExternal", url: msg.url });
        break;
      case "openDocs":
        this.deps.effect({ kind: "openDocs", page: msg.page ?? "sandbox" });
        break;
      case "createShortcut":
        this.deps.effect({ kind: "createShortcut" });
        break;
      case "revealBat":
        this.deps.effect({ kind: "reveal", path: this.deps.ledger.ensureUninstallBat() });
        break;
      case "cleanUninstall":
        await this.cleanUninstall();
        break;
    }
  }

  /** Redraw the list: what is installed, what it declared, and what is running. */
  async refresh(): Promise<void> {
    this.deps.ledger.ensureUninstallBat(); // keep the script present so Reveal/Run always work
    // Each mod carries its launch DTO plus the same install-manifest breakdown
    // the product page shows, derived from the ledger snapshot (dests shown as
    // declared tokens — My Mods does not resolve them). Read defensively so
    // ledgers written before bundles/symlinks existed still render.
    const mods = (await this.deps.subs.list()).map((s) => ({
      ...toModDto(s),
      manifest: deriveInstallManifestView({
        bundles: s.bundles ?? [],
        symlinks: (s.symlinks ?? []).map((x) => ({
          source: x.source,
          dest: x.dest,
          resolved: null,
        })),
        entrypoints: s.entrypoints ?? [],
        missionScripts: s.missionScripts ?? [],
      }),
    }));
    // An unreadable ledger reads as empty, so the list below is about to claim
    // nothing is installed while the links are still in the DCS folders. Say so,
    // and point at the file that was preserved — it is the only record of them.
    const corrupt = this.deps.ledger.takeCorruptNotice();
    if (corrupt) {
      this.deps.effect({
        kind: "warn",
        message: `Your DCS Studio mod list could not be read and was preserved as ${corrupt}. My Mods will look empty until it is restored; uninstall-all.bat was left as it was, so it still removes the links already in your DCS folders.`,
      });
    }
    // Running state keyed exactly as the webview looks it up (`<repo>::<id>`),
    // translated here to the launcher's (lowercased) tracking keys.
    const running: Record<string, boolean> = {};
    for (const m of mods) {
      for (const ep of m.entrypoints) {
        running[`${m.repo}::${ep.id}`] = this.deps.launcher.isRunning(
          entrypointRunKey(m.repo, ep.id),
        );
      }
    }
    this.deps.post({
      type: "init",
      dataDir: this.deps.dataDir(),
      uninstallBat: this.deps.ledger.uninstallBatPath(),
      mods,
      running,
    });
  }

  /** Run one lifecycle action against a mod, reporting it and redrawing after. */
  private async act(repo: string, fn: () => Promise<void> | void, verb: string): Promise<void> {
    this.deps.post({ type: "busy", repo, busy: true });
    try {
      await fn();
      this.deps.effect({ kind: "info", message: `${verb} ${repo}.` });
    } catch (e) {
      this.deps.effect({ kind: "failed", message: `${verb} failed: ${errorText(e)}`, cause: e });
    } finally {
      // A half-applied change is exactly when the list has to show the truth.
      await this.refresh();
    }
  }

  private async runUpdate(repo: string): Promise<void> {
    this.deps.post({ type: "busy", repo, busy: true });
    try {
      const session = await this.deps.auth.currentSession(); // token feeds the payload download
      const product = await this.deps.market.loadProduct(repo);
      const sub = (await this.deps.subs.list()).find((s) => s.repo === repo);
      if (!product.release_tag) throw new Error("No release found on GitHub.");
      // Re-downloading the installed tag would tear the mod's links down and
      // rebuild them for no gain, briefly breaking a working DCS install.
      if (sub && isUpToDate(sub, product.release_tag)) {
        this.deps.effect({ kind: "info", message: `${repo} is already up to date (${sub.tag}).` });
        return;
      }
      await this.deps.subs.update(
        {
          repo: product.repo,
          name: product.name,
          tag: product.release_tag,
          assets: product.assets,
        },
        session?.token,
        (p) => this.deps.post({ type: "progress", repo, label: p.label, pct: p.pct }),
      );
      this.deps.effect({ kind: "info", message: `Updated ${repo} to ${product.release_tag}.` });
    } catch (e) {
      this.deps.effect({ kind: "failed", message: `Update failed: ${errorText(e)}`, cause: e });
    } finally {
      await this.refresh();
    }
  }

  /**
   * Launch a mod entrypoint as a tracked process. First launch of a given
   * mod+entrypoint asks a modal confirm naming the exe; "Always allow for this
   * mod" persists consent. Declining does not launch. Errors (missing exe, spawn
   * failure) surface both as a notification and inline in the card.
   */
  private async launchEntrypoint(repo: string, id: string): Promise<void> {
    const sub = (await this.deps.subs.list()).find((s) => s.repo === repo);
    const ep = sub?.entrypoints?.find((e) => e.id === id);
    // A stale webview can still hold a card for a mod, or an entrypoint, that a
    // later update dropped; there is nothing to resolve a plan against.
    if (!sub || !ep) return;
    const plan = resolveEntrypointLaunch(ep, sub.dir, this.installRoots());

    const consentKey = entrypointConsentKey(repo, id);
    if (!this.deps.consent.granted(consentKey)) {
      // Arbitrary third-party code: the exe path is the only thing the user has
      // to judge it by, so the prompt carries it.
      const choice = await this.deps.confirm({
        message: `Launch "${ep.name}" from ${repo}?`,
        detail: `This runs a mod-shipped executable:\n${plan.exe}`,
        actions: ["Launch", "Always allow for this mod"],
      });
      if (!choice) return; // declined — do not launch
      if (choice === "Always allow for this mod") await this.deps.consent.remember(consentKey);
    }

    try {
      this.deps.launcher.launch(entrypointRunKey(repo, id), plan);
      this.deps.post({ type: "entrypoint", repo, id, running: true });
    } catch (e) {
      const message = errorText(e);
      // Both surfaces: the card has to fall back out of "running", or Stop is
      // the only button left for a process that never started.
      this.deps.effect({ kind: "failed", message: `Launch failed: ${message}`, cause: e });
      this.deps.post({ type: "entrypoint", repo, id, running: false, error: message });
    }
  }

  /** Stop a single tracked entrypoint (kills its process tree). */
  private stopEntrypoint(repo: string, id: string): void {
    this.deps.launcher.stop(entrypointRunKey(repo, id));
    this.deps.post({ type: "entrypoint", repo, id, running: false });
  }

  /** Stop every declared entrypoint of a mod (used before disable/uninstall). */
  private async stopRepoEntrypoints(repo: string): Promise<void> {
    const sub = (await this.deps.subs.list()).find((s) => s.repo === repo);
    for (const ep of sub?.entrypoints ?? []) this.deps.launcher.stop(entrypointRunKey(repo, ep.id));
  }

  /** The clean-uninstall script, behind a modal — it is irreversible. */
  private async cleanUninstall(): Promise<void> {
    const choice = await this.deps.confirm({
      message:
        "Run the clean-uninstall script? This removes ALL DCS Studio mod links from your DCS folders and deletes the unpacked mod data.",
      actions: ["Run uninstall-all.bat"],
    });
    if (choice) {
      this.deps.effect({
        kind: "runUninstallScript",
        path: this.deps.ledger.ensureUninstallBat(),
      });
    }
  }

  private installRoots(): InstallRoots {
    return {
      savedGames: this.deps.roots.savedGames(),
      gameInstall: this.deps.roots.gameInstall() || "",
    };
  }
}
