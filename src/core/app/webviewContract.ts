import type { DualBridgeStatus } from "../domain/bridgeProtocol";
import type { DcsCandidate, SetupRole } from "../domain/dcsDetect";
import type { LogEntry, ModIdentity } from "../domain/dcsLog";
import type { LuaEnv, ReplVariable } from "../domain/debugProtocol";
import type { InstallManifestView } from "../domain/installManifestView";
import type { InitialForm } from "../domain/projectForm";
import type { TemplateMeta } from "../domain/projectTemplates";
import type { Check } from "../domain/publishChecks";
import type { RepoRef } from "../domain/repoRemote";
import type { ModDto } from "../domain/subscriptions";
import type { MarketListing, ProductDetail } from "../domain/types";
import type { ReleaseOpts, ReleaseResult, ShareOpts, ShareResult } from "./publishService";
import type { Progress } from "./subscriptionService";

// The **declared** webview ↔ panel message contract (testing-audit gap G3).
//
// Both halves of every webview protocol already execute under a gate, so a
// dropped handler fails a test. What was missing is a name both halves are
// checked against: rename a message type on one side and nothing knew the other
// side existed. This module is that name — one place where each covered panel's
// two message unions are written down, and the only place either side may take
// them from.
//
// The audit is explicit that the cheap version is the wrong one: deriving the
// table by scanning `media/*.js` produces false failures, because the webviews
// use several dispatch shapes. So nothing here is inferred from source text.
// The contract is declared, and three independent mechanisms check that the
// declaration is true:
//
//  1. **The compiler.** Each presenter's `post` is typed to its panel's
//     host-message union, so the host cannot emit a message this file does not
//     declare; each presenter's `handle` takes the webview-message union, so a
//     `case` for an undeclared type is a compile error. The `TO_HOST`/
//     `TO_WEBVIEW` arrays below are built from mapped types over those unions,
//     so a type added to a union and not to its array (or the reverse) does not
//     compile either.
//  2. **The unit layer** (`test/unit/core/webviewContract.test.ts`) drives the
//     presenter with every declared `toHost` message and asserts each one is
//     acted on, and scripts the presenter until it has produced every declared
//     `toWebview` message. Both directions of the HOST half, executed.
//  3. **The e2e layer** (`tests/webviewContract.spec.ts`) drives the real
//     `media/*.js` in Chromium and asserts the set of messages the webview
//     actually posted equals `toHost`, and that every `toWebview` message
//     pushed at it was consumed. Both directions of the WEBVIEW half, observed
//     — never read off the source.
//
// ## Coverage is deliberately partial
//
// Only the panels with a presenter (`console`, `marketplace`, `mymods`, `log`,
// `publish`, `setup`) are covered. The other five webviews still have both halves
// under their own gates but no declared contract between them; they are named in
// `publish`, `newproject`) are covered. The other five webviews still have both
// halves under their own gates but no declared contract between them; they are named in
// `UNCOVERED_WEBVIEWS` so the gap is visible in the table rather than silent,
// and the tests assert that list is exactly "every preview page minus the
// covered ones". Extending the contract to a panel means giving it a presenter
// first — an inferred contract for the remaining five would be worse than none.
//
// ## Why the payload fields are mostly optional
//
// These unions describe what may ARRIVE, not what is well-formed. A webview
// message crosses a process boundary from a document that may be stale or
// hostile, so `code?: string` on an `eval` is the honest declaration and the
// presenter's `typeof msg.code !== "string"` guard is the thing that decides.
// Making the field required would type away the guard the tests exist to cover.

// ── Console ──────────────────────────────────────────────────────────────────

/** Fields every console message carries, whatever its type. */
interface ConsoleEnvelope {
  /** The Lua environment the request targets; the host routes on it. */
  env?: LuaEnv;
}

/** A message `media/console.js` (or `media/console-explorer.js`) posts. */
export type ConsoleWebviewMessage = ConsoleEnvelope &
  (
    | { type: "ready" }
    | { type: "eval"; code?: string }
    | { type: "inspect"; expr?: string; id?: number }
    | { type: "expand"; ref?: number; nodeId?: number }
    | { type: "signature"; ref?: number; reqId?: number }
    | { type: "clearExplorer"; envs?: LuaEnv[] }
    | { type: "export"; ref?: number; expr?: string; label?: string; reqId?: number }
    | { type: "launch" }
  );

/** A message `ConsolePresenter` pushes to the console webview. */
export type ConsoleHostMessage =
  | { type: "status"; status: DualBridgeStatus }
  | { type: "explorerConfig"; wildcardDepth: number }
  | { type: "result"; value: unknown }
  | { type: "error"; message: string }
  | { type: "print"; lines: { seq: number; text: string }[] }
  | {
      type: "inspectResult";
      id?: number;
      env: LuaEnv;
      expr: string;
      ok: boolean;
      err?: string;
      /** The value's Lua type. Named `luaType` because `type` is the envelope's. */
      luaType?: string;
      value?: string;
      ref?: number;
    }
  | { type: "expandResult"; nodeId?: number; ok: boolean; variables?: ReplVariable[]; err?: string }
  | {
      type: "signatureResult";
      reqId?: number;
      ok: boolean;
      params?: string;
      native?: boolean;
      err?: string;
    }
  | { type: "exportDone"; reqId?: number; saved: boolean; error?: string };

// The mapped types below are the glue between the unions above and the runtime
// arrays below: `{ [K in Union["type"]]: true }` accepts exactly one key per
// member — a missing key and an extra key are both compile errors — so the
// arrays cannot drift from the types they claim to enumerate.
const CONSOLE_TO_HOST_KEYS: { readonly [K in ConsoleWebviewMessage["type"]]: true } = {
  ready: true,
  eval: true,
  inspect: true,
  expand: true,
  signature: true,
  clearExplorer: true,
  export: true,
  launch: true,
};

const CONSOLE_TO_WEBVIEW_KEYS: { readonly [K in ConsoleHostMessage["type"]]: true } = {
  status: true,
  explorerConfig: true,
  result: true,
  error: true,
  print: true,
  inspectResult: true,
  expandResult: true,
  signatureResult: true,
  exportDone: true,
};

// ── Marketplace ──────────────────────────────────────────────────────────────

/** A message `media/marketplace.js` posts. */
export type MarketplaceWebviewMessage =
  | { type: "ready" }
  | { type: "signIn" }
  | { type: "browseAnon" }
  | { type: "discover"; force?: boolean }
  | { type: "openProduct"; repo?: string }
  | { type: "openExternal"; url?: string }
  | { type: "openDocs"; page?: string }
  | { type: "install"; repo?: string }
  | { type: "uninstall"; repo?: string };

/** A message `MarketplacePresenter` pushes to the marketplace webview. */
export type MarketplaceHostMessage =
  | { type: "auth"; signedIn: boolean; browsing: boolean; login?: string; topic: string }
  | { type: "listings:busy" }
  | { type: "listings"; listings: MarketListing[]; force: boolean }
  | { type: "listings:error"; message: string }
  | { type: "product:busy"; repo: string }
  | {
      type: "product";
      product: ProductDetail;
      manifest: InstallManifestView;
      requires: { id: string }[];
      installed: boolean;
    }
  | { type: "product:error"; repo: string; message: string }
  | {
      type: "installProgress";
      repo: string;
      phase: Progress["phase"];
      label: string;
      pct: number | undefined;
    }
  | { type: "installed"; repo: string }
  | { type: "uninstalled"; repo: string }
  | { type: "installError"; repo: string; message: string };

const MARKETPLACE_TO_HOST_KEYS: { readonly [K in MarketplaceWebviewMessage["type"]]: true } = {
  ready: true,
  signIn: true,
  browseAnon: true,
  discover: true,
  openProduct: true,
  openExternal: true,
  openDocs: true,
  install: true,
  uninstall: true,
};

const MARKETPLACE_TO_WEBVIEW_KEYS: { readonly [K in MarketplaceHostMessage["type"]]: true } = {
  auth: true,
  "listings:busy": true,
  listings: true,
  "listings:error": true,
  "product:busy": true,
  product: true,
  "product:error": true,
  installProgress: true,
  installed: true,
  uninstalled: true,
  installError: true,
};

// ── My Mods ──────────────────────────────────────────────────────────────────

/** One installed mod as the My Mods list renders it: the DTO plus its breakdown. */
export type MyModsModView = ModDto & { manifest: InstallManifestView };

/** A message `media/mymods.js` posts. */
export type MyModsWebviewMessage =
  | { type: "refresh" }
  | { type: "enable"; repo?: string }
  | { type: "disable"; repo?: string }
  | { type: "uninstall"; repo?: string }
  | { type: "update"; repo?: string }
  | { type: "launch"; repo?: string; id?: string }
  | { type: "stop"; repo?: string; id?: string }
  | { type: "openDir"; repo?: string }
  | { type: "openExternal"; url?: string }
  | { type: "openDocs"; page?: string }
  | { type: "createShortcut" }
  | { type: "revealBat" }
  | { type: "cleanUninstall" };

/** A message `MyModsPresenter` pushes to the My Mods webview. */
export type MyModsHostMessage =
  | {
      type: "init";
      dataDir: string;
      uninstallBat: string;
      mods: MyModsModView[];
      /** Per-entrypoint running state, keyed exactly as the webview looks it up. */
      running: Record<string, boolean>;
    }
  | { type: "busy"; repo: string; busy: boolean }
  | { type: "progress"; repo: string; label: string; pct: number | undefined }
  | { type: "entrypoint"; repo: string; id: string; running: boolean; error?: string };

const MYMODS_TO_HOST_KEYS: { readonly [K in MyModsWebviewMessage["type"]]: true } = {
  refresh: true,
  enable: true,
  disable: true,
  uninstall: true,
  update: true,
  launch: true,
  stop: true,
  openDir: true,
  openExternal: true,
  openDocs: true,
  createShortcut: true,
  revealBat: true,
  cleanUninstall: true,
};

const MYMODS_TO_WEBVIEW_KEYS: { readonly [K in MyModsHostMessage["type"]]: true } = {
  init: true,
  busy: true,
  progress: true,
  entrypoint: true,
};

// ── Log ──────────────────────────────────────────────────────────────────────

/** Whether `dcs.log` is currently there to read. The tailer reports it and the
 * webview renders the "not found" pane off it, so the name lives with the
 * messages that carry it. */
export type LogFileState = "ok" | "missing";

/** A message `media/log.js` posts. */
export type LogWebviewMessage = { type: "ready" } | { type: "clear" } | { type: "openSettings" };

/** A message `LogPresenter` pushes to the log webview. */
export type LogHostMessage =
  /** The boot handshake's reply: the backlog tailed before the webview loaded. */
  | {
      type: "init";
      entries: readonly LogEntry[];
      mod: ModIdentity | null;
      file: string;
      state: LogFileState;
    }
  | {
      type: "append";
      entries: readonly LogEntry[];
      /** Continuation lines re-sent whole per entry, so a repeat cannot duplicate. */
      cont: { seq: number; cont: string[] }[];
      /** How many entries the buffer cap evicted since the last append. */
      dropped: number;
    }
  | { type: "reset" }
  | { type: "fileState"; state: LogFileState; file: string }
  | { type: "mod"; mod: ModIdentity | null };

const LOG_TO_HOST_KEYS: { readonly [K in LogWebviewMessage["type"]]: true } = {
  ready: true,
  clear: true,
  openSettings: true,
};

const LOG_TO_WEBVIEW_KEYS: { readonly [K in LogHostMessage["type"]]: true } = {
  init: true,
  append: true,
  reset: true,
  fileState: true,
  mod: true,
};

// ── Publish ──────────────────────────────────────────────────────────────────

/** Which button a `busy` latch belongs to. The webview looks the element up off
 * this, so the two spellings cannot drift apart. */
export type PublishBusyScope = "share" | "release";

/** The manifest-seeded values the publish form opens with. */
export interface PublishDefaults {
  name: string;
  description: string;
  version: string;
}

/** A message `media/publish.js` posts. */
export type PublishWebviewMessage =
  | { type: "refresh" }
  | { type: "share"; opts?: ShareOpts }
  | { type: "release"; opts?: ReleaseOpts }
  | { type: "openExternal"; url?: string };

/** A message `PublishPresenter` pushes to the publish webview. */
export type PublishHostMessage =
  /** No workspace folder — a different view entirely, with no form and no log. */
  | { type: "nofolder" }
  | { type: "init"; checks: Check[]; repo: RepoRef | null; defaults: PublishDefaults }
  /** One streamed progress line, or a refusal. Appended to the log pane. */
  | { type: "log"; line: string }
  | { type: "busy"; scope: PublishBusyScope; busy: boolean }
  | { type: "shareDone"; result: ShareResult }
  | { type: "releaseDone"; result: ReleaseResult };

const PUBLISH_TO_HOST_KEYS: { readonly [K in PublishWebviewMessage["type"]]: true } = {
  refresh: true,
  share: true,
  release: true,
  openExternal: true,
};

const PUBLISH_TO_WEBVIEW_KEYS: { readonly [K in PublishHostMessage["type"]]: true } = {
  nofolder: true,
  init: true,
  log: true,
  busy: true,
  shareDone: true,
  releaseDone: true,
};

// ── Setup ────────────────────────────────────────────────────────────────────

/**
 * The four `dcsStudio` path settings the Setup panel owns, keyed by their real
 * setting ids. Declared here because the panel's `save` writes exactly these and
 * its `init` echoes exactly these back — under shorter names, which is itself a
 * mapping worth having one home for.
 */
export interface SetupPaths {
  savedGamesPath: string;
  gameInstallPath: string;
  dataDir: string;
  sevenZipPath: string;
}

/** A message `media/setup.js` posts. */
export type SetupWebviewMessage =
  | { type: "redetect" }
  /** Open a picker for one role. `which` may be absent, and the host decides
   *  what a nameless browse means. */
  | { type: "browse"; which?: SetupRole }
  | {
      type: "save";
      savedGames?: string;
      gameInstall?: string;
      dataDir?: string;
      sevenZip?: string;
    };

/** A message `SetupPresenter` pushes to the setup webview. */
export type SetupHostMessage =
  /**
   * The whole form's state. Pushed unprompted — `media/setup.js` renders an empty
   * form at load and posts no handshake, so this is the only thing that fills it.
   */
  | {
      type: "init";
      /** The four configured paths, trimmed, `""` rather than absent. */
      savedGames: string;
      gameInstall: string;
      dataDir: string;
      sevenZip: string;
      /** The data-dir input's placeholder, so it is never blank. */
      dataDirDefault: string;
      /** Where the archiver was found, or `""` for "not found". */
      sevenZipDetected: string;
      savedCandidates: DcsCandidate[];
      installCandidates: DcsCandidate[];
    }
  /**
   * The result of a picker. `valid` is the host's probe of the role's witness
   * path — declared because the host sends it, though see card 14's journal:
   * `media/setup.js` currently ignores it.
   */
  | { type: "browsed"; which?: SetupRole; path: string; valid: boolean }
  /** Settings written. The webview flashes "Saved ✓" for two seconds. */
  | { type: "saved" };

const SETUP_TO_HOST_KEYS: { readonly [K in SetupWebviewMessage["type"]]: true } = {
  redetect: true,
  browse: true,
  save: true,
};

const SETUP_TO_WEBVIEW_KEYS: { readonly [K in SetupHostMessage["type"]]: true } = {
  init: true,
  browsed: true,
  saved: true,
};

// ── New Project ─────────────────────────────────────────────────────

/** A message `media/newproject.js` posts. */
export type NewProjectWebviewMessage =
  | { type: "browse"; location?: string }
  | { type: "create"; template?: string; name?: string; location?: string; inPlace?: boolean };

/**
 * A message `NewProjectPresenter` pushes to the New Project webview.
 *
 * `init` is the only one the form needs, and the only one it cannot ask for:
 * this is the one covered panel whose webview posts NOTHING at load, so the
 * host's unprompted push is the whole handshake (card 23).
 */
export type NewProjectHostMessage =
  | ({
      type: "init";
      /** The template tiles, in the order they are offered. */
      templates: readonly TemplateMeta[];
      /** The separator the webview joins location + name with for its preview. */
      sep: string;
    } & InitialForm)
  | { type: "browsed"; path: string }
  /**
   * The scaffold finished. Declared because both halves implement it, and
   * `silent` in `NEWPROJECT_PROTOCOL` because all it does is drop the webview's
   * "Creating…" latch — a latch nothing can outlive, since the host closes the
   * panel or reloads the window immediately after (card 24).
   */
  | { type: "created" }
  | { type: "error"; message: string };

const NEWPROJECT_TO_HOST_KEYS: { readonly [K in NewProjectWebviewMessage["type"]]: true } = {
  browse: true,
  create: true,
};

const NEWPROJECT_TO_WEBVIEW_KEYS: { readonly [K in NewProjectHostMessage["type"]]: true } = {
  init: true,
  browsed: true,
  created: true,
  error: true,
};

// ── The table ────────────────────────────────────────────────────────────────

/** One covered panel's half of the contract, as data the tests iterate. */
export interface WebviewProtocol {
  /** The preview page standing in for the panel, as `previews/<page>`. */
  readonly preview: string;
  /** The media script that implements the webview half. */
  readonly scripts: readonly string[];
  /** Every message type the webview posts to the host. */
  readonly toHost: readonly string[];
  /** Every message type the host pushes to the webview. */
  readonly toWebview: readonly string[];
  /**
   * `toWebview` types the webview consumes WITHOUT changing the document.
   *
   * The e2e half detects consumption by diffing the rendered document around a
   * push, which cannot see a message that only updates a script-local variable.
   * Listing those here rather than dropping them keeps the claim explicit and
   * falsifiable in both directions: the test asserts a listed message never
   * changes the document, so one that starts rendering something fails here
   * until the list is corrected.
   */
  readonly silent: readonly string[];
}

export const CONSOLE_PROTOCOL: WebviewProtocol = {
  preview: "console.html",
  scripts: ["explorer-core.js", "console-explorer.js", "console.js"],
  toHost: Object.keys(CONSOLE_TO_HOST_KEYS),
  toWebview: Object.keys(CONSOLE_TO_WEBVIEW_KEYS),
  // `explorerConfig` only moves the explorer's `**` sweep budget, which is read
  // when a sweep runs and rendered nowhere.
  silent: ["explorerConfig"],
};

export const MARKETPLACE_PROTOCOL: WebviewProtocol = {
  preview: "marketplace.html",
  scripts: ["marketplace.js"],
  toHost: Object.keys(MARKETPLACE_TO_HOST_KEYS),
  toWebview: Object.keys(MARKETPLACE_TO_WEBVIEW_KEYS),
  silent: [],
};

export const MYMODS_PROTOCOL: WebviewProtocol = {
  preview: "mymods.html",
  scripts: ["mymods.js"],
  toHost: Object.keys(MYMODS_TO_HOST_KEYS),
  toWebview: Object.keys(MYMODS_TO_WEBVIEW_KEYS),
  silent: [],
};

export const LOG_PROTOCOL: WebviewProtocol = {
  preview: "log.html",
  scripts: ["log.js"],
  toHost: Object.keys(LOG_TO_HOST_KEYS),
  toWebview: Object.keys(LOG_TO_WEBVIEW_KEYS),
  silent: [],
};

export const PUBLISH_PROTOCOL: WebviewProtocol = {
  preview: "publish.html",
  scripts: ["publish.js"],
  toHost: Object.keys(PUBLISH_TO_HOST_KEYS),
  toWebview: Object.keys(PUBLISH_TO_WEBVIEW_KEYS),
  silent: [],
};

export const SETUP_PROTOCOL: WebviewProtocol = {
  preview: "setup.html",
  scripts: ["setup.js"],
  toHost: Object.keys(SETUP_TO_HOST_KEYS),
  toWebview: Object.keys(SETUP_TO_WEBVIEW_KEYS),
  silent: [],
};

export const NEWPROJECT_PROTOCOL: WebviewProtocol = {
  preview: "newproject.html",
  scripts: ["newproject.js"],
  toHost: Object.keys(NEWPROJECT_TO_HOST_KEYS),
  toWebview: Object.keys(NEWPROJECT_TO_WEBVIEW_KEYS),
  // `created` only clears the script-local `creating` flag; the form it would
  // re-enable is about to be closed or reloaded away, so it renders nothing.
  silent: ["created"],
};

/** Every panel whose protocol is declared, keyed by preview page basename. */
export const WEBVIEW_PROTOCOLS: Readonly<Record<string, WebviewProtocol>> = {
  console: CONSOLE_PROTOCOL,
  log: LOG_PROTOCOL,
  marketplace: MARKETPLACE_PROTOCOL,
  mymods: MYMODS_PROTOCOL,
  newproject: NEWPROJECT_PROTOCOL,
  publish: PUBLISH_PROTOCOL,
  setup: SETUP_PROTOCOL,
};

/**
 * The webviews with NO declared contract, named so the gap is data rather than
 * an absence. Each still has both halves under a coverage gate; what none of
 * them has is a shared name for the messages crossing between them.
 *
 * A panel joins `WEBVIEW_PROTOCOLS` by growing a presenter first — the unions
 * above are only worth anything because a `vscode`-free object on the host side
 * can be driven through every one of them.
 */
export const UNCOVERED_WEBVIEWS: readonly string[] = ["docs", "manifest", "nav", "skills"];
