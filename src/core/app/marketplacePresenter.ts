import { errorText } from "../domain/errorText";
import { deriveInstallManifestView, unsafeManifestMessage } from "../domain/installManifestView";
import type { ProductDetail } from "../domain/types";
import type { AuthPort } from "../ports/auth";
import type { MarketplacePort } from "../ports/marketplace";
import type { SubscriptionService } from "./subscriptionService";
import type { MarketplaceHostMessage, MarketplaceWebviewMessage } from "./webviewContract";

// The marketplace storefront's decision logic, lifted out of the VS Code panel.
//
// The panel that used to hold this was 255 lines of which ~16 touched `vscode`:
// the sign-in state machine, the product cache, the install guard rules and the
// error→message mapping were all real behaviour welded to a webview shell, and
// so were untestable without an extension host. This module owns that
// behaviour and knows nothing about VS Code; the panel is left holding the
// webview, the URI plumbing and the four side effects below.
//
// Outgoing webview messages go through `post`, and anything that needs the
// editor is described as an `MarketplaceEffect` for the adapter to perform —
// so a test asserts on values rather than on spies over a mocked API.

/** Something only the editor can do, described rather than done. */
export type MarketplaceEffect =
  | { kind: "openExternal"; url: string }
  | { kind: "openDocs"; page: string }
  | { kind: "info"; message: string }
  | { kind: "installFailed"; message: string; cause: unknown };

/**
 * The message shapes the marketplace webview sends the host — the declared
 * contract, not a local restatement of it. Named here as well so the panel
 * keeps importing its boundary type from the module it talks to; the union
 * itself lives in `webviewContract.ts`, where the webview half is checked
 * against the same declaration.
 */
export type MarketplaceInbound = MarketplaceWebviewMessage;

export interface MarketplacePresenterDeps {
  subs: Pick<SubscriptionService, "install" | "unsubscribe" | "fetchPlan" | "isSubscribed">;
  market: MarketplacePort;
  auth: AuthPort;
  /** The discovery topic, read fresh so a settings change takes effect live. */
  topic: () => string;
  /**
   * Deliver a message to the webview. Typed to the declared host union, so a
   * message `media/marketplace.js` has no case for cannot be sent from here
   * without the contract being updated first.
   */
  post: (msg: MarketplaceHostMessage) => void;
  /** Perform an editor-side effect. */
  effect: (effect: MarketplaceEffect) => void;
}

export class MarketplacePresenter {
  /** The signed-in token, cached for the subscription flows. */
  private token: string | undefined;
  /** The user chose to browse without signing in (public, rate-limited). */
  private browsing = false;
  /** Products loaded this session, keyed by lowercased repo. */
  private readonly products = new Map<string, ProductDetail>();
  /**
   * Why a loaded product may not be installed, keyed like `products`. Set when
   * its manifest declares a path reaching outside the DCS roots — the webview
   * hides the install action for those, and this makes an `install` message
   * arriving anyway (a stale page, a crafted post) refuse before downloading.
   */
  private readonly refusals = new Map<string, string>();

  constructor(private readonly deps: MarketplacePresenterDeps) {}

  async handle(msg: MarketplaceInbound): Promise<void> {
    switch (msg.type) {
      case "ready":
        await this.refreshAuth();
        break;
      case "signIn": {
        const session = await this.deps.auth.signIn();
        this.token = session?.token;
        // Signing in supersedes an earlier "browse anonymously" choice.
        this.browsing = false;
        await this.refreshAuth();
        break;
      }
      case "browseAnon":
        this.browsing = true;
        this.deps.post({
          type: "auth",
          signedIn: false,
          browsing: true,
          topic: this.deps.topic(),
        });
        await this.discover(false);
        break;
      case "discover":
        await this.discover(!!msg.force);
        break;
      case "openProduct":
        if (msg.repo) await this.openProduct(msg.repo);
        break;
      case "openExternal":
        if (msg.url) this.deps.effect({ kind: "openExternal", url: msg.url });
        break;
      case "openDocs":
        // The "Learn more" link on the Script Execution Notice routes here.
        this.deps.effect({ kind: "openDocs", page: msg.page ?? "sandbox" });
        break;
      case "install":
        if (msg.repo) await this.install(msg.repo);
        break;
      case "uninstall":
        if (msg.repo) await this.uninstall(msg.repo);
        break;
    }
  }

  /** Push current auth state to the webview; auto-discover once we have access. */
  async refreshAuth(): Promise<void> {
    const session = await this.deps.auth.currentSession();
    this.token = session?.token;
    const signedIn = !!session;
    this.deps.post({
      type: "auth",
      signedIn,
      browsing: this.browsing,
      login: session?.accountLabel,
      topic: this.deps.topic(),
    });
    if (signedIn || this.browsing) await this.discover(false);
  }

  async discover(force: boolean): Promise<void> {
    this.deps.post({ type: "listings:busy" });
    try {
      const listings = await this.deps.market.discover(this.deps.topic());
      this.deps.post({ type: "listings", listings, force });
    } catch (e) {
      this.deps.post({ type: "listings:error", message: errorText(e) });
    }
  }

  private async openProduct(repo: string): Promise<void> {
    this.deps.post({ type: "product:busy", repo });
    try {
      const product = await this.deps.market.loadProduct(repo);
      this.products.set(product.repo.toLowerCase(), product);
      let plan = null;
      try {
        plan = await this.deps.subs.fetchPlan(product.assets, this.token);
      } catch {
        // A missing or unreadable manifest just means no plan preview — shown
        // as the explicit "install actions unknown" state, never a silent gap.
      }
      const manifest = deriveInstallManifestView(plan);
      const key = product.repo.toLowerCase();
      if (manifest.unsafePaths.length)
        this.refusals.set(key, unsafeManifestMessage(manifest.unsafePaths));
      else this.refusals.delete(key);
      this.deps.post({
        type: "product",
        product,
        manifest,
        requires: plan?.requires ?? [],
        installed: await this.deps.subs.isSubscribed(product.repo),
      });
    } catch (e) {
      this.deps.post({ type: "product:error", repo, message: errorText(e) });
    }
  }

  private async install(repo: string): Promise<void> {
    // Install acts on the cached product, so a repo the user never opened is
    // silently ignored rather than installed from a half-known descriptor.
    const product = this.products.get(repo.toLowerCase());
    if (!product) return;
    // A manifest that reaches outside the DCS roots is refused here, before the
    // payload is even downloaded — the same verdict the product page rendered
    // in place of the install button, enforced rather than assumed.
    const refusal = this.refusals.get(repo.toLowerCase());
    if (refusal) {
      this.deps.post({ type: "installError", repo, message: refusal });
      return;
    }
    if (!product.release_tag) {
      this.deps.post({
        type: "installError",
        repo,
        message: "This mod has no release to install.",
      });
      return;
    }
    this.deps.post({
      type: "installProgress",
      repo,
      phase: "download",
      label: "Starting…",
      pct: 0,
    });
    try {
      await this.deps.subs.install(
        {
          repo: product.repo,
          name: product.name,
          tag: product.release_tag,
          assets: product.assets,
        },
        this.token,
        (p) =>
          this.deps.post({
            type: "installProgress",
            repo,
            phase: p.phase,
            label: p.label,
            pct: p.pct,
          }),
      );
      this.deps.post({ type: "installed", repo });
      this.deps.effect({
        kind: "info",
        message: `Installed ${product.name} into your DCS folders.`,
      });
    } catch (e) {
      const message = errorText(e);
      // Both surfaces: inline in the card, and a toast with Report Issue —
      // the card may be scrolled out of view when a long install fails.
      this.deps.post({ type: "installError", repo, message });
      this.deps.effect({ kind: "installFailed", message: `Install failed: ${message}`, cause: e });
    }
  }

  private async uninstall(repo: string): Promise<void> {
    try {
      await this.deps.subs.unsubscribe(repo);
      this.deps.post({ type: "uninstalled", repo });
      this.deps.effect({ kind: "info", message: `Uninstalled ${repo}.` });
    } catch (e) {
      this.deps.post({ type: "installError", repo, message: errorText(e) });
    }
  }
}
