import type { DualBridgeStatus } from "../domain/bridgeProtocol";
import type { DcsCandidate, SetupRole } from "../domain/dcsDetect";
import type { LogEntry, ModIdentity } from "../domain/dcsLog";
import type { LuaEnv, ReplVariable } from "../domain/debugProtocol";
import type { InstallManifestView } from "../domain/installManifestView";
import type { InitialForm } from "../domain/projectForm";
import type { TemplateMeta } from "../domain/projectTemplates";
import type { Check } from "../domain/publishChecks";
import type { RepoRef } from "../domain/repoRemote";
import type { SkillInfo } from "../domain/skillsStatus";
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
// ## Coverage is now total
//
// All ELEVEN webviews are covered: the nine panels cards 08, 09 and 14 rolled
// presenters out to (`console`, `marketplace`, `mymods`, `log`, `publish`,
// `setup`, `newproject`, `manifest`, `docs`), the Agent Skills panel, and the
// sidebar — which is a `WebviewView` rather than a panel and got here last on
// purpose, as a decision rather than a repetition (card 14's journal records the
// reasoning). `UNCOVERED_WEBVIEWS` is therefore empty, which is what makes the
// census assertion in `test/integration/webview/webviewContract.test.ts` TOTAL:
// the covered names equal the `previews/` directory, so a twelfth webview
// arriving fails until someone declares it or says out loud that it is not
// declared. The list is kept, empty, as the place that second answer would go.
//
// Coverage was reached one webview at a time and in that order for a reason:
// declaring a union for a panel whose host half is welded to `vscode` would
// leave that half unexecutable, so every entry below has a presenter behind it.
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
   * The result of a picker.
   *
   * `which` is REQUIRED here even though the `browse` that asked for it may name
   * no role: the host resolves an absent role (to userdata) and echoes what it
   * resolved, so the webview never has to guess. Both halves used to fall back
   * separately and to different roles, and the webview's answer was `install`
   * (card 23).
   *
   * `valid` is the host's probe of the role's witness path, and is what puts the
   * pill under a hand-browsed path — which is by definition not among the
   * detected candidates the webview can otherwise judge against.
   */
  | { type: "browsed"; which: SetupRole; path: string; valid: boolean }
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

// ── Manifest form ────────────────────────────────────────────────────────────

/**
 * The two DCS roots a `dest` resolves against, as the form is told them.
 *
 * `gameInstall` is `""` rather than absent when unconfigured: the form renders
 * `{GameInstall}` as *unresolvable on this machine* off exactly that emptiness,
 * which is a different message from "this dest is wrong" (`media/manifest.js`
 * keeps the two apart deliberately), so the falsy value is the declaration.
 */
export interface ManifestRoots {
  savedGames: string;
  gameInstall: string;
}

/**
 * The manifest form's opening state — declared here beside its messages because
 * it is this panel's `init`, and the only reason it is not one.
 *
 * `media/manifest.js` reads `window.__BOOTSTRAP__` synchronously at load, so
 * this crosses inside the DOCUMENT the host renders rather than over the message
 * channel. It is the one covered panel that therefore has no boot handshake and
 * cannot lose one to the load race (cards 22-24), which is also why the
 * `toWebview` union below has no `init` in it.
 */
export interface ManifestBootstrap {
  /** The bound document's text, as the form's model is parsed from. */
  rawText: string;
  /** The document's path; the form names itself after its basename. */
  targetPath: string;
  roots: ManifestRoots;
}

/**
 * A message `media/manifest.js` posts.
 *
 * One, and debounced: the form re-emits the WHOLE file 200ms after the last
 * keystroke, and the host applies it as a `WorkspaceEdit` so save, dirty state
 * and undo belong to VS Code rather than to the form.
 */
export type ManifestWebviewMessage = { type: "edit"; text?: string };

/** A message `ManifestPresenter` pushes to the manifest form. */
export type ManifestHostMessage =
  /** The document changed under the form (raw-text edit, undo, revert, git). */
  | { type: "external"; rawText: string }
  /** The DCS paths changed, so every resolved-dest line is stale. */
  | { type: "roots"; roots: ManifestRoots };

const MANIFEST_TO_HOST_KEYS: { readonly [K in ManifestWebviewMessage["type"]]: true } = {
  edit: true,
};

const MANIFEST_TO_WEBVIEW_KEYS: { readonly [K in ManifestHostMessage["type"]]: true } = {
  external: true,
  roots: true,
};

// ── Documentation ────────────────────────────────────────────────────────────

/**
 * The docs panel's opening state — one field, and, like the manifest form's
 * bootstrap, deliberately NOT a message.
 *
 * `media/docs.js` reads `window.__INITIAL_PAGE__` synchronously at the top of its
 * IIFE, so a deep link into a page crosses inside the DOCUMENT the host renders.
 * That is why the `toWebview` union below has no `init`, and why an opening deep
 * link cannot be lost to the load race the way publish (card 22) and New Project
 * (card 23) can lose their opening push.
 *
 * `""` rather than an absent field is the declaration: it is what "no page named,
 * open where the reader left off" looks like, and the value the webview's own
 * page-id test is written against.
 */
export interface DocsBootstrap {
  page: string;
}

/** A message `media/docs.js` posts. */
export type DocsWebviewMessage =
  /** A page body's "try it" button naming an extension command. */
  | { type: "run"; command?: string }
  /** An `https:` link in a page body. */
  | { type: "openExternal"; url?: string };

/**
 * A message `DocsPresenter` pushes to the docs webview.
 *
 * One, and it exists only for the panel that is ALREADY OPEN: opening the panel
 * on a page puts that page in the document instead (`DocsBootstrap`), so this is
 * the reveal-and-navigate half of the same rule.
 */
export type DocsHostMessage = { type: "goto"; page: string };

const DOCS_TO_HOST_KEYS: { readonly [K in DocsWebviewMessage["type"]]: true } = {
  run: true,
  openExternal: true,
};

const DOCS_TO_WEBVIEW_KEYS: { readonly [K in DocsHostMessage["type"]]: true } = {
  goto: true,
};

// ── Agent Skills ─────────────────────────────────────────────────────────────

/**
 * A message `media/skills.js` posts.
 *
 * Four of the five come from ONE listener, and the type is not a literal
 * anywhere in the script: every button carries a `data-act`, and the click
 * handler posts `{ type: el.dataset.act, id: el.dataset.id }`
 * (`media/skills.js:101-105`). The enumeration lives in the DOM the script
 * builds, which is exactly the dispatch shape the audit says a regex contract
 * gets wrong — a scanner would find no `install` at all.
 */
export type SkillsWebviewMessage =
  /** The boot handshake, posted at the bottom of the IIFE. */
  | { type: "refresh" }
  /** Install, update or reset-to-bundled — one `data-act` for all three buttons. */
  | { type: "install"; id?: string }
  /** Open the installed copy for editing. */
  | { type: "open"; id?: string }
  /** Peek at the copy the extension ships. */
  | { type: "viewBundled"; id?: string }
  /** Delete the installed copy from the repo. */
  | { type: "remove"; id?: string };

/**
 * A message `SkillsPresenter` pushes to the skills webview.
 *
 * One, and it is the whole screen: `media/skills.js` re-renders every card from
 * scratch off this, so there is no partial update in this protocol at all.
 */
export type SkillsHostMessage = {
  type: "skills";
  skills: readonly SkillInfo[];
  /** Where installs land, named on screen so the user knows what to commit. */
  installDir: string;
  /** Whether there is a repo to install into; with none the cards lose Install. */
  hasWorkspace: boolean;
};

const SKILLS_TO_HOST_KEYS: { readonly [K in SkillsWebviewMessage["type"]]: true } = {
  refresh: true,
  install: true,
  open: true,
  viewBundled: true,
  remove: true,
};

const SKILLS_TO_WEBVIEW_KEYS: { readonly [K in SkillsHostMessage["type"]]: true } = {
  skills: true,
};

// ── Sidebar nav ──────────────────────────────────────────────────────────────

/**
 * The bridge status as the SIDEBAR is told it — one dot, one clock, both
 * bridges collapsed into them.
 *
 * Deliberately not `DualBridgeStatus`, which is what the console's `status`
 * carries. The sidebar's footer has room for neither bridge separately, so
 * "connected" is either of them being up and `dcsTime` is `displayTime`'s pick
 * between them. `null` is "no time to show", and the webview reads `> 0` as a
 * mission running.
 */
export interface NavStatus {
  connected: boolean;
  dcsTime: number | null;
}

/**
 * A message `media/nav.js` posts.
 *
 * `run` comes from one delegated wiring over every row: each row carries its own
 * `data-command` and the click handler posts it (`media/nav.js`). So the command
 * id is one the DOM chose — which is why the presenter guards it.
 *
 * `ready` is the boot handshake, and the sidebar was the last webview without
 * one (card 29). It carries nothing: what it asks for is the whole opening
 * state, and the presenter already knows all three parts.
 */
export type NavWebviewMessage = { type: "run"; command?: string } | { type: "ready" };

/**
 * A message `NavPresenter` pushes to the sidebar.
 *
 * All three are pushed unprompted when the view resolves AND in answer to the
 * webview's `ready` — the shape cards 22-24 converged on, with the unprompted
 * push kept as the first chance rather than replaced. The sidebar needed it
 * least and still needed it: it renders its rows and its "Bridge offline" footer
 * from static data at load, so a lost push leaves a page that is complete but
 * stale — and two of those stale states are user-visible, the worst being
 * Publish Mod staying hidden in a workspace that IS a mod project (card 29).
 */
export type NavHostMessage =
  | { type: "status"; status: NavStatus }
  /** How many installed skill files the extension ships a newer version of. */
  | { type: "skills"; updates: number }
  /** Whether the workspace is already a mod project. */
  | { type: "manifest"; hasManifest: boolean };

const NAV_TO_HOST_KEYS: { readonly [K in NavWebviewMessage["type"]]: true } = {
  run: true,
  ready: true,
};

const NAV_TO_WEBVIEW_KEYS: { readonly [K in NavHostMessage["type"]]: true } = {
  status: true,
  skills: true,
  manifest: true,
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

export const MANIFEST_PROTOCOL: WebviewProtocol = {
  preview: "manifest.html",
  // Two scripts, and the only covered panel with more than one that is not the
  // console: `manifest-core.js` is the parse/emit/resolve core the form and the
  // extension host BOTH run, so it is part of the webview half by being loaded
  // beside `manifest.js`, not by dispatching anything itself.
  scripts: ["manifest-core.js", "manifest.js"],
  toHost: Object.keys(MANIFEST_TO_HOST_KEYS),
  toWebview: Object.keys(MANIFEST_TO_WEBVIEW_KEYS),
  // Both pushes re-render the whole form — there is nothing the form keeps that
  // it does not draw.
  silent: [],
};

export const DOCS_PROTOCOL: WebviewProtocol = {
  preview: "docs.html",
  // Two scripts, and neither dispatches on its own behalf: `docs-content.js` is
  // the manual itself (`window.__DOCS__`), read synchronously by `docs.js`, which
  // owns every listener. It is part of the webview half by being what the page
  // renders — a docs panel with no content posts nothing at all.
  scripts: ["docs-content.js", "docs.js"],
  toHost: Object.keys(DOCS_TO_HOST_KEYS),
  toWebview: Object.keys(DOCS_TO_WEBVIEW_KEYS),
  // `goto` re-renders the page pane and re-marks the TOC's active row.
  silent: [],
};

export const SKILLS_PROTOCOL: WebviewProtocol = {
  preview: "skills.html",
  scripts: ["skills.js"],
  toHost: Object.keys(SKILLS_TO_HOST_KEYS),
  toWebview: Object.keys(SKILLS_TO_WEBVIEW_KEYS),
  // The one push is the whole screen; there is nothing it does not draw.
  silent: [],
};

export const NAV_PROTOCOL: WebviewProtocol = {
  preview: "nav.html",
  scripts: ["nav.js"],
  toHost: Object.keys(NAV_TO_HOST_KEYS),
  toWebview: Object.keys(NAV_TO_WEBVIEW_KEYS),
  // All three change a row or the footer. `manifest` changes two rows at once.
  silent: [],
};

/** Every webview whose protocol is declared, keyed by preview page basename. */
export const WEBVIEW_PROTOCOLS: Readonly<Record<string, WebviewProtocol>> = {
  console: CONSOLE_PROTOCOL,
  docs: DOCS_PROTOCOL,
  log: LOG_PROTOCOL,
  manifest: MANIFEST_PROTOCOL,
  marketplace: MARKETPLACE_PROTOCOL,
  mymods: MYMODS_PROTOCOL,
  nav: NAV_PROTOCOL,
  newproject: NEWPROJECT_PROTOCOL,
  publish: PUBLISH_PROTOCOL,
  setup: SETUP_PROTOCOL,
  skills: SKILLS_PROTOCOL,
};

/**
 * The webviews with NO declared contract — now none of them.
 *
 * The list is kept rather than deleted, and that is the point of it: the census
 * (`test/integration/webview/webviewContract.test.ts`) asserts that the covered
 * names plus this one equal the `previews/` directory exactly, so a TWELFTH
 * webview arriving has to be put on one side of the line or the other. An empty
 * array makes that assertion total — every webview in the repo is covered — while
 * still leaving somewhere honest to name a new one that is not yet.
 *
 * A webview joins `WEBVIEW_PROTOCOLS` by growing a presenter first — the unions
 * above are only worth anything because a `vscode`-free object on the host side
 * can be driven through every one of them.
 */
export const UNCOVERED_WEBVIEWS: readonly string[] = [];
