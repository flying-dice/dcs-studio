import { describe, expect, it } from "vitest";
import type {
  ConsoleBridge,
  ConsoleEffect,
  ConsoleExportSave,
  ConsoleInbound,
} from "../../../src/core/app/consolePresenter";
import { ConsolePresenter } from "../../../src/core/app/consolePresenter";
import type { DocsEffect, DocsInbound } from "../../../src/core/app/docsPresenter";
import { DocsPresenter } from "../../../src/core/app/docsPresenter";
import type { LogEffect, LogInbound, LogPresenterDeps } from "../../../src/core/app/logPresenter";
import { LogPresenter } from "../../../src/core/app/logPresenter";
import type {
  ManifestInbound,
  ManifestPresenterDeps,
} from "../../../src/core/app/manifestPresenter";
import { ManifestPresenter } from "../../../src/core/app/manifestPresenter";
import type {
  MarketplaceEffect,
  MarketplaceInbound,
  MarketplacePresenterDeps,
} from "../../../src/core/app/marketplacePresenter";
import { MarketplacePresenter } from "../../../src/core/app/marketplacePresenter";
import type {
  MyModsEffect,
  MyModsInbound,
  MyModsPresenterDeps,
} from "../../../src/core/app/myModsPresenter";
import { MyModsPresenter } from "../../../src/core/app/myModsPresenter";
import type { NavEffect, NavInbound, NavPresenterDeps } from "../../../src/core/app/navPresenter";
import { NavPresenter } from "../../../src/core/app/navPresenter";
import type {
  NewProjectEffect,
  NewProjectInbound,
  NewProjectPresenterDeps,
} from "../../../src/core/app/newProjectPresenter";
import { NewProjectPresenter } from "../../../src/core/app/newProjectPresenter";
import type {
  PublishEffect,
  PublishInbound,
  PublishPresenterDeps,
} from "../../../src/core/app/publishPresenter";
import { PublishPresenter } from "../../../src/core/app/publishPresenter";
import type { ReleaseResult, ShareResult } from "../../../src/core/app/publishService";
import type {
  SetupEffect,
  SetupInbound,
  SetupPresenterDeps,
} from "../../../src/core/app/setupPresenter";
import { SetupPresenter } from "../../../src/core/app/setupPresenter";
import type {
  SkillsEffect,
  SkillsInbound,
  SkillsPresenterDeps,
} from "../../../src/core/app/skillsPresenter";
import { SkillsPresenter } from "../../../src/core/app/skillsPresenter";
import type {
  ConsoleHostMessage,
  DocsHostMessage,
  LogHostMessage,
  ManifestHostMessage,
  MarketplaceHostMessage,
  MyModsHostMessage,
  NavHostMessage,
  NewProjectHostMessage,
  PublishHostMessage,
  SetupHostMessage,
  SkillsHostMessage,
} from "../../../src/core/app/webviewContract";
import {
  CONSOLE_PROTOCOL,
  DOCS_PROTOCOL,
  LOG_PROTOCOL,
  MANIFEST_PROTOCOL,
  MARKETPLACE_PROTOCOL,
  MYMODS_PROTOCOL,
  NAV_PROTOCOL,
  NEWPROJECT_PROTOCOL,
  PUBLISH_PROTOCOL,
  SETUP_PROTOCOL,
  SKILLS_PROTOCOL,
  UNCOVERED_WEBVIEWS,
  WEBVIEW_PROTOCOLS,
} from "../../../src/core/app/webviewContract";
import type { DualBridgeStatus } from "../../../src/core/domain/bridgeProtocol";
import type { DcsCandidate } from "../../../src/core/domain/dcsDetect";
import type { Check } from "../../../src/core/domain/publishChecks";
import type { SkillInfo } from "../../../src/core/domain/skillsStatus";
import type { ManifestModel, ProductDetail, Subscription } from "../../../src/core/domain/types";

// The HOST half of the declared webview contract
// (`src/core/app/webviewContract.ts`), both directions, table-driven.
//
//   webview -> host : every declared message is ACTED ON by the presenter.
//   host -> webview : every declared message is PRODUCED by the presenter.
//
// The webview half — that `media/*.js` emits exactly the first set and consumes
// exactly the second — is observed in Chromium by tests/webviewContract.spec.ts.
// Neither half infers anything from source text; both drive real code and
// compare what happened against the one declaration.
//
// ## Why this test cannot pass against an empty table
//
// PR #67's lesson: the boundary check became complete and unfalsifiable in the
// same commit, because it asserted only an absence. Every assertion here is an
// equality between the declared set and a set produced by RUNNING the
// presenter, so emptying the table fails as loudly as breaking a handler:
//
//   - the drive plans below are exhaustive `Record`s over the message unions
//     (a missing key does not compile), and each is asserted key-for-key
//     against the protocol's `toHost` list, so removing one entry from either
//     side is a mismatch;
//   - the produced-message assertions are set equalities, so a declared message
//     the presenter never sends fails just as a sent message that was never
//     declared does;
//   - the negative controls prove "was acted on" can come back false, so the
//     positive results are not vacuous.

// ── Console harness ──────────────────────────────────────────────────────────

const CONNECTED = { connected: true, dcsTime: 0 };
const OFFLINE = { connected: false, dcsTime: null };
const STATUS: DualBridgeStatus = { gui: CONNECTED, mission: OFFLINE };

/** A bridge that answers everything successfully unless told to fail. */
class ContractBridge implements ConsoleBridge {
  current = { connected: true };
  readonly calls: string[] = [];
  /** When set, every RPC rejects — the path that produces the error replies. */
  failing = false;
  /** What `replEval` reports; `false` is the sim refusing the chunk. */
  evalOk = true;
  /** Lines the output ring hands back on the next poll. */
  lines: { seq: number; text: string }[] = [];

  async consoleRead(after: number) {
    this.calls.push("consoleRead");
    return { lines: this.lines, latest: after + this.lines.length };
  }
  replEval = this.rpc("replEval", () => ({ ok: this.evalOk, result: 1, err: "boom" }));
  replInspect = this.rpc("replInspect", () => ({ ok: true, type: "table", value: "table (1)" }));
  replExpand = this.rpc("replExpand", () => ({ variables: [] }));
  replSignature = this.rpc("replSignature", () => ({ ok: true, params: "a" }));
  replClear = this.rpc("replClear", () => ({}));
  replExport = this.rpc("replExport", () => ({ path: "/tmp/x.json", bytes: 1 }));

  private rpc(method: string, answer: () => unknown) {
    return async (...args: unknown[]): Promise<never> => {
      void args;
      this.calls.push(method);
      if (this.failing) throw new Error("bridge refused");
      return answer() as never;
    };
  }
}

interface ConsoleHarness {
  presenter: ConsolePresenter;
  bridge: ContractBridge;
  posted: ConsoleHostMessage[];
  effects: ConsoleEffect[];
  saves: ConsoleExportSave[];
  /** How many observable things the presenter did — the "was it handled" probe. */
  interactions(): number;
}

function consoleHarness(): ConsoleHarness {
  const bridge = new ContractBridge();
  const posted: ConsoleHostMessage[] = [];
  const effects: ConsoleEffect[] = [];
  const saves: ConsoleExportSave[] = [];
  const presenter = new ConsolePresenter({
    bridges: { forEnv: () => bridge, current: STATUS },
    tailed: [bridge],
    wildcardDepth: () => 1,
    post: (msg) => posted.push(msg),
    effect: (e) => effects.push(e),
    saveExport: async (request) => {
      saves.push(request);
      return true;
    },
  });
  return {
    presenter,
    bridge,
    posted,
    effects,
    saves,
    interactions: () => posted.length + effects.length + saves.length + bridge.calls.length,
  };
}

// ── Marketplace harness ──────────────────────────────────────────────────────

function product(over: Partial<ProductDetail> = {}): ProductDetail {
  return {
    repo: "Owner/Repo",
    name: "My Mod",
    author: "Owner",
    description: "",
    repo_url: "https://github.com/Owner/Repo",
    avatar_url: "https://avatars.githubusercontent.com/Owner",
    stars: 0,
    readme: null,
    release_tag: "v1.0.0",
    release_url: "https://github.com/Owner/Repo/releases/tag/v1.0.0",
    release_date: "2026-01-02T03:04:05Z",
    assets: [],
    download_size: 0,
    installable: true,
    installs: [],
    requires: [],
    ...over,
  };
}

interface MarketplaceHarness {
  presenter: MarketplacePresenter;
  posted: MarketplaceHostMessage[];
  effects: MarketplaceEffect[];
  calls: string[];
  interactions(): number;
}

function marketplaceHarness(over: Partial<MarketplacePresenterDeps> = {}): MarketplaceHarness {
  const posted: MarketplaceHostMessage[] = [];
  const effects: MarketplaceEffect[] = [];
  const calls: string[] = [];
  const deps: MarketplacePresenterDeps = {
    subs: {
      install: async (_t, _tok, onProgress) => {
        calls.push("install");
        onProgress({ phase: "link", label: "Linking…", pct: 1 });
      },
      unsubscribe: async () => {
        calls.push("unsubscribe");
      },
      fetchPlan: async () => null,
      isSubscribed: async () => false,
    } as MarketplacePresenterDeps["subs"],
    market: {
      discover: async () => [],
      loadProduct: async () => product(),
    },
    auth: {
      getToken: async () => undefined,
      onDidChangeSessions: () => ({ dispose: () => {} }),
      currentSession: async () => undefined,
      signIn: async () => {
        calls.push("signIn");
        return undefined;
      },
    },
    topic: () => "dcs-studio",
    post: (msg) => posted.push(msg),
    effect: (e) => effects.push(e),
    ...over,
  };
  return {
    presenter: new MarketplacePresenter(deps),
    posted,
    effects,
    calls,
    interactions: () => posted.length + effects.length + calls.length,
  };
}

// ── My Mods harness ──────────────────────────────────────────────────────────

const REPO = "Owner/Mod";
const MOD_DIR = "D:\\mods\\owner-mod";

function subscription(over: Partial<Subscription> = {}): Subscription {
  return {
    repo: REPO,
    name: "Carrier Mod",
    tag: "v1.0.0",
    dir: MOD_DIR,
    enabled: true,
    links: [{ id: "l1", dest: "C:\\Saved Games\\DCS\\Mods\\Mod" }],
    entrypoints: [{ id: "gui", name: "Config GUI", exe: "bin\\config.exe" }],
    ...over,
  } as Subscription;
}

interface MyModsHarness {
  presenter: MyModsPresenter;
  posted: MyModsHostMessage[];
  effects: MyModsEffect[];
  calls: string[];
  interactions(): number;
}

/**
 * `consented` skips the launch modal (the consent rules have their own tests in
 * `test/unit/install/myModsPresenter.test.ts`); `answer` is what every modal
 * question resolves to, so `cleanUninstall` reaches its effect.
 */
function myModsHarness(over: Partial<MyModsPresenterDeps> = {}): MyModsHarness {
  const posted: MyModsHostMessage[] = [];
  const effects: MyModsEffect[] = [];
  const calls: string[] = [];
  const list = async () => [subscription()];
  const deps: MyModsPresenterDeps = {
    subs: {
      list,
      listWithRecovery: async () => ({ mods: await list() }),
      enable: async (repo) => void calls.push(`enable ${repo}`),
      disable: async (repo) => void calls.push(`disable ${repo}`),
      unsubscribe: async (repo) => void calls.push(`unsubscribe ${repo}`),
      update: async (target, _token, onProgress) => {
        calls.push(`update ${target.repo}`);
        onProgress({ phase: "download", label: "Downloading…", pct: 42 });
      },
    } as MyModsPresenterDeps["subs"],
    ledger: {
      ensureUninstallBat: () => {
        calls.push("ensureUninstallBat");
        return "D:\\mods\\uninstall-all.bat";
      },
      uninstallBatPath: () => "D:\\mods\\uninstall-all.bat",
    },
    market: {
      discover: async () => [],
      // A newer tag than the subscription's, so `update` runs rather than
      // short-circuiting on "already up to date".
      loadProduct: async () => product({ repo: REPO, release_tag: "v2.0.0" }),
    },
    launcher: {
      isRunning: () => false,
      launch: (key) => void calls.push(`launch ${key}`),
      stop: (key) => void calls.push(`stop ${key}`),
      setOnChange: () => {},
    },
    roots: {
      savedGames: () => "C:\\Saved Games\\DCS",
      gameInstall: () => "C:\\DCS World",
      dataDir: () => "D:\\mods",
    },
    auth: {
      getToken: async () => undefined,
      onDidChangeSessions: () => ({ dispose: () => {} }),
      currentSession: async () => undefined,
      signIn: async () => undefined,
    },
    consent: { granted: () => true, remember: async () => {} },
    dataDir: () => "D:\\mods",
    post: (msg) => posted.push(msg),
    effect: (e) => effects.push(e),
    confirm: async () => "Run uninstall-all.bat",
    ...over,
  };
  return {
    presenter: new MyModsPresenter(deps),
    posted,
    effects,
    calls,
    interactions: () => posted.length + effects.length + calls.length,
  };
}

// ── Log harness ──────────────────────────────────────────────────────────────

const LOG_TOML = '[project]\nname = "Super Carrier Tweaks"\n';
const LOG_LINE = "2026-07-13 12:00:00.001 INFO    DCS (Main): deck ready";

interface LogHarness {
  presenter: LogPresenter;
  posted: LogHostMessage[];
  effects: LogEffect[];
  /**
   * Everything observable about the presenter: what it has emitted, plus what it
   * WOULD replay if the webview handshook right now.
   *
   * `clear` is the first declared message whose whole job is to change host
   * state and answer nothing — counting posts and effects would score it as
   * ignored. The boot handshake is the presenter's own window onto that state,
   * so the probe asks it, diverting the reply away from `posted` so that reading
   * the state is not itself one of the interactions being measured.
   */
  fingerprint(): string;
}

function logHarness(over: Partial<LogPresenterDeps> = {}): LogHarness {
  const posted: LogHostMessage[] = [];
  const effects: LogEffect[] = [];
  let sink = posted;
  const presenter = new LogPresenter({
    roots: {
      savedGames: () => "C:\\Saved Games\\DCS",
      gameInstall: () => "C:\\DCS World",
      dataDir: () => "D:\\mods",
    },
    parseManifest: () => ({ project: { name: "Super Carrier Tweaks" } }),
    manifestText: async () => LOG_TOML,
    post: (msg) => sink.push(msg),
    effect: (e) => effects.push(e),
    ...over,
  });
  // The shell points the presenter at a file before any tick reaches it.
  presenter.retarget();
  return {
    presenter,
    posted,
    effects,
    fingerprint: () => {
      const probe: LogHostMessage[] = [];
      sink = probe;
      presenter.handle({ type: "ready" });
      sink = posted;
      return JSON.stringify([posted, effects, probe]);
    },
  };
}

// ── Publish harness ──────────────────────────────────────────────────────────

const PUBLISH_ROOT = "C:\\proj";

const PUBLISH_MANIFEST: ManifestModel = {
  project: { name: "my-mod", version: "1.2.3", author: "", description: "Does a thing" },
  bundle: [{ path: "Scripts" }],
  symlink: [],
  requires_module: [],
  entrypoint: [],
  mission_script: [],
  extras: [],
};

interface PublishHarness {
  presenter: PublishPresenter;
  posted: PublishHostMessage[];
  effects: PublishEffect[];
  calls: string[];
  interactions(): number;
}

/**
 * A publish presenter whose world is green: preflight passes, so `share` and
 * `release` reach the service rather than being refused by the re-check. The
 * refusal paths have their own tests in
 * `test/unit/publish/publishPresenter.test.ts`.
 */
function publishHarness(over: Partial<PublishPresenterDeps> = {}): PublishHarness {
  const posted: PublishHostMessage[] = [];
  const effects: PublishEffect[] = [];
  const calls: string[] = [];
  const ok: Check[] = [{ label: "7-Zip", level: "ok", detail: "C:\\7z\\7z.exe" }];
  const deps: PublishPresenterDeps = {
    root: PUBLISH_ROOT,
    preflight: async () => {
      calls.push("preflight");
      return ok;
    },
    readManifest: () => PUBLISH_MANIFEST,
    remoteUrl: async () => "https://github.com/Owner/my-mod.git",
    share: async (_root, _opts, log): Promise<ShareResult> => {
      calls.push("share");
      log("Creating repository…");
      return { owner: "Owner", name: "my-mod", url: "https://github.com/Owner/my-mod" };
    },
    cutRelease: async (_root, opts, log): Promise<ReleaseResult> => {
      calls.push("release");
      log("Packaging payload…");
      return {
        assets: ["dcs-studio.toml"],
        url: `https://github.com/Owner/my-mod/releases/tag/${opts.tag}`,
        packaged: { volumes: [], totalBytes: 1, split: false },
      };
    },
    post: (msg) => posted.push(msg),
    effect: (e) => effects.push(e),
    ...over,
  };
  return {
    presenter: new PublishPresenter(deps),
    posted,
    effects,
    calls,
    interactions: () => posted.length + effects.length + calls.length,
  };
}

// ── Setup harness ────────────────────────────────────────────────────────────

const SETUP_CANDIDATE: DcsCandidate = {
  path: "C:\\Users\\pilot\\Saved Games\\DCS",
  name: "DCS",
  valid: true,
  detail: "has Config",
};

interface SetupHarness {
  presenter: SetupPresenter;
  posted: SetupHostMessage[];
  effects: SetupEffect[];
  calls: string[];
  interactions(): number;
}

/**
 * A setup presenter whose browse dialog always answers, so `browse` reaches its
 * reply rather than being a cancellation. The validation rules have their own
 * tests in `test/unit/setup/setupPresenter.test.ts`.
 */
function setupHarness(over: Partial<SetupPresenterDeps> = {}): SetupHarness {
  const posted: SetupHostMessage[] = [];
  const effects: SetupEffect[] = [];
  const calls: string[] = [];
  const deps: SetupPresenterDeps = {
    detectSavedGames: async () => {
      calls.push("detectSavedGames");
      return [SETUP_CANDIDATE];
    },
    detectGameInstalls: async () => [],
    settings: () => ({
      savedGamesPath: SETUP_CANDIDATE.path,
      gameInstallPath: undefined,
      dataDir: undefined,
      sevenZipPath: undefined,
    }),
    saveSetting: async (key) => void calls.push(`save ${key}`),
    defaultDataDir: () => "C:\\Users\\pilot\\DCSStudio\\mods",
    detectedSevenZip: async () => "C:\\Program Files\\7-Zip\\7z.exe",
    browse: async () => "D:\\SG\\DCS",
    exists: () => true,
    post: (msg) => posted.push(msg),
    effect: (e) => effects.push(e),
    ...over,
  };
  return {
    presenter: new SetupPresenter(deps),
    posted,
    effects,
    calls,
    interactions: () => posted.length + effects.length + calls.length,
  };
}

// ── New Project harness ──────────────────────────────────────────────────────

interface NewProjectHarness {
  presenter: NewProjectPresenter;
  posted: NewProjectHostMessage[];
  effects: NewProjectEffect[];
  calls: string[];
  interactions(): number;
}

/**
 * A New Project presenter whose world succeeds: the picker answers a folder and
 * both scaffolds return. The refusal and failure paths have their own tests in
 * `test/unit/project/newProjectPresenter.test.ts`.
 */
function newProjectHarness(over: Partial<NewProjectPresenterDeps> = {}): NewProjectHarness {
  const posted: NewProjectHostMessage[] = [];
  const effects: NewProjectEffect[] = [];
  const calls: string[] = [];
  const deps: NewProjectPresenterDeps = {
    folder: () => undefined,
    homeDir: "C:\\Users\\pilot",
    lastLocation: () => "E:\\Projects",
    rememberLocation: async () => void calls.push("remember"),
    setPendingOpen: async () => void calls.push("pending"),
    pickFolder: async () => {
      calls.push("pick");
      return "E:\\Chosen";
    },
    scaffoldInPlace: async () => {
      calls.push("inPlace");
      return { skipped: [] };
    },
    scaffoldNewFolder: async () => {
      calls.push("newFolder");
      return { root: "E:\\Projects\\my-mod" };
    },
    post: (msg) => posted.push(msg),
    effect: (e) => effects.push(e),
    ...over,
  };
  return {
    presenter: new NewProjectPresenter(deps),
    posted,
    effects,
    calls,
    interactions: () => posted.length + effects.length + calls.length,
  };
}

// ── Manifest harness ─────────────────────────────────────────────────────────

const MANIFEST_TOML = '[project]\nname = "my-mod"\n';

interface ManifestHarness {
  presenter: ManifestPresenter;
  posted: ManifestHostMessage[];
  calls: string[];
  /** The bound document, mutable the way a real one is while the form is open. */
  setText: (text: string) => void;
  interactions(): number;
}

/**
 * A manifest presenter over a document that starts as `MANIFEST_TOML`. The write
 * lands in that document, as the real `WorkspaceEdit` does — an `edit` whose
 * write went nowhere would make the echo rule pass for the wrong reason. The
 * guards and the watermark have their own tests in
 * `test/unit/manifest/manifestPresenter.test.ts`.
 */
function manifestHarness(over: Partial<ManifestPresenterDeps> = {}): ManifestHarness {
  let text = MANIFEST_TOML;
  const posted: ManifestHostMessage[] = [];
  const calls: string[] = [];
  const deps: ManifestPresenterDeps = {
    text: () => text,
    targetPath: "C:\\proj\\dcs-studio.toml",
    installRoots: {
      savedGames: () => "C:\\Users\\pilot\\Saved Games\\DCS",
      gameInstall: () => "C:\\DCS World",
    },
    write: async (next) => {
      calls.push("write");
      text = next;
    },
    post: (msg) => posted.push(msg),
    ...over,
  };
  return {
    presenter: new ManifestPresenter(deps),
    posted,
    calls,
    setText: (next) => {
      text = next;
    },
    interactions: () => posted.length + calls.length,
  };
}

// ── Docs harness ─────────────────────────────────────────────────────────────

interface DocsHarness {
  presenter: DocsPresenter;
  posted: DocsHostMessage[];
  effects: DocsEffect[];
  interactions(): number;
}

/**
 * The simplest harness in the file, and deliberately so: the docs presenter has
 * no state and no dependency beyond its two outputs. The guards and the
 * reveal-without-navigating rule have their own tests in
 * `test/unit/docs/docsPresenter.test.ts`.
 */
function docsHarness(): DocsHarness {
  const posted: DocsHostMessage[] = [];
  const effects: DocsEffect[] = [];
  return {
    presenter: new DocsPresenter({
      post: (msg) => posted.push(msg),
      effect: (e) => effects.push(e),
    }),
    posted,
    effects,
    interactions: () => posted.length + effects.length,
  };
}

// ── Agent Skills harness ─────────────────────────────────────────────────────

const SKILL_ID = "dcs-studio";
const SKILL_REF = "file:///c%3A/proj/.claude/skills/dcs-studio/SKILL.md";

/**
 * A skill the user has EDITED, so the overwrite gate is in play for `install` —
 * the case that takes the most to make happen, and therefore the one worth
 * driving here. The per-status rules have their own tests in
 * `test/unit/skills/skillsPresenter.test.ts`.
 */
const EDITED_SKILL: SkillInfo = {
  id: SKILL_ID,
  name: SKILL_ID,
  description: "",
  bundledVersion: "1.2.0",
  installedVersion: "1.2.0",
  status: "modified",
};

interface SkillsHarness {
  presenter: SkillsPresenter;
  posted: SkillsHostMessage[];
  effects: SkillsEffect[];
  calls: string[];
  interactions(): number;
}

/** A skills presenter over a repo that accepts writes and a user who says yes. */
function skillsHarness(over: Partial<SkillsPresenterDeps> = {}): SkillsHarness {
  const posted: SkillsHostMessage[] = [];
  const effects: SkillsEffect[] = [];
  const calls: string[] = [];
  const deps: SkillsPresenterDeps = {
    list: async () => [EDITED_SKILL],
    hasWorkspace: () => true,
    install: async (id) => {
      calls.push(`install ${id}`);
      return { ref: SKILL_REF, label: `.claude\\skills\\${id}\\SKILL.md` };
    },
    remove: async (id) => void calls.push(`remove ${id}`),
    installedRef: () => SKILL_REF,
    bundledRef: () => "file:///c%3A/ext/skills/dcs-studio/SKILL.md",
    confirm: async (question) => {
      calls.push("confirm");
      return question.confirmLabel;
    },
    post: (msg) => posted.push(msg),
    effect: (e) => effects.push(e),
    ...over,
  };
  return {
    presenter: new SkillsPresenter(deps),
    posted,
    effects,
    calls,
    interactions: () => posted.length + effects.length + calls.length,
  };
}

// ── Sidebar nav harness ──────────────────────────────────────────────────────

interface NavHarness {
  presenter: NavPresenter;
  posted: NavHostMessage[];
  effects: NavEffect[];
  interactions(): number;
}

/**
 * The sidebar's presenter. Like the docs panel's it holds no state — the sidebar
 * pushes what its three subscriptions tell it and keeps nothing — so the harness
 * is its two outputs and the two questions it asks.
 */
function navHarness(over: Partial<NavPresenterDeps> = {}): NavHarness {
  const posted: NavHostMessage[] = [];
  const effects: NavEffect[] = [];
  const deps: NavPresenterDeps = {
    updatesAvailable: async () => [EDITED_SKILL],
    manifestExists: async () => true,
    post: (msg) => posted.push(msg),
    effect: (e) => effects.push(e),
    ...over,
  };
  return {
    presenter: new NavPresenter(deps),
    posted,
    effects,
    interactions: () => posted.length + effects.length,
  };
}

/** The message types a run of the presenter actually pushed, de-duplicated. */
function typesOf(posted: { type: string }[]): string[] {
  return [...new Set(posted.map((m) => m.type))].sort();
}

// ── Drive plans ──────────────────────────────────────────────────────────────

/**
 * One declared webview -> host message, and what it takes to make the host act
 * on it. `before` is the state the message needs to be meaningful at all — an
 * `install` for a product the user never opened is silently ignored by design,
 * so the plan opens it first and only counts what the `send` itself did.
 */
interface Drive<M> {
  before?: readonly M[];
  send: M;
}

// Exhaustive by construction: `Record<Union["type"], …>` will not compile with
// a key missing, so a message type added to the contract lands here as a type
// error rather than as a silently untested entry.
const CONSOLE_DRIVES: Record<ConsoleInbound["type"], Drive<ConsoleInbound>> = {
  ready: { send: { type: "ready" } },
  eval: { send: { type: "eval", code: "return 1" } },
  inspect: { send: { type: "inspect", expr: "_G", id: 1 } },
  expand: { send: { type: "expand", ref: 2, nodeId: 3 } },
  signature: { send: { type: "signature", ref: 2, reqId: 4 } },
  clearExplorer: { send: { type: "clearExplorer", envs: ["gui"] } },
  export: { send: { type: "export", ref: 2, label: "_G/db", reqId: 5 } },
  launch: { send: { type: "launch" } },
};

const MARKETPLACE_DRIVES: Record<MarketplaceInbound["type"], Drive<MarketplaceInbound>> = {
  ready: { send: { type: "ready" } },
  signIn: { send: { type: "signIn" } },
  browseAnon: { send: { type: "browseAnon" } },
  discover: { send: { type: "discover", force: true } },
  openProduct: { send: { type: "openProduct", repo: "Owner/Repo" } },
  openExternal: { send: { type: "openExternal", url: "https://github.com/Owner/Repo" } },
  openDocs: { send: { type: "openDocs", page: "sandbox" } },
  // Install acts on the cached product, so the page has to have been opened.
  install: {
    before: [{ type: "openProduct", repo: "Owner/Repo" }],
    send: { type: "install", repo: "Owner/Repo" },
  },
  uninstall: { send: { type: "uninstall", repo: "Owner/Repo" } },
};

const MYMODS_DRIVES: Record<MyModsInbound["type"], Drive<MyModsInbound>> = {
  refresh: { send: { type: "refresh" } },
  enable: { send: { type: "enable", repo: REPO } },
  disable: { send: { type: "disable", repo: REPO } },
  uninstall: { send: { type: "uninstall", repo: REPO } },
  update: { send: { type: "update", repo: REPO } },
  launch: { send: { type: "launch", repo: REPO, id: "gui" } },
  stop: { send: { type: "stop", repo: REPO, id: "gui" } },
  openDir: { send: { type: "openDir", repo: REPO } },
  openExternal: { send: { type: "openExternal", url: `https://github.com/${REPO}` } },
  openDocs: { send: { type: "openDocs", page: "sandbox" } },
  createShortcut: { send: { type: "createShortcut" } },
  revealBat: { send: { type: "revealBat" } },
  cleanUninstall: { send: { type: "cleanUninstall" } },
};

/**
 * The log's plan needs a different `before` to the others: `clear` empties the
 * tailed backlog, and lines reach the presenter from the TAILER, not from a
 * webview message — so the setup is a call, not a list of inbound messages.
 */
interface LogDrive {
  setup?: (p: LogPresenter) => void;
  send: LogInbound;
}

const LOG_DRIVES: Record<LogInbound["type"], LogDrive> = {
  ready: { send: { type: "ready" } },
  clear: { setup: (p) => p.onLines([LOG_LINE]), send: { type: "clear" } },
  openSettings: { send: { type: "openSettings" } },
};

const PUBLISH_DRIVES: Record<PublishInbound["type"], Drive<PublishInbound>> = {
  refresh: { send: { type: "refresh" } },
  share: { send: { type: "share", opts: { name: "my-mod", description: "A mod" } } },
  release: {
    send: {
      type: "release",
      opts: { owner: "Owner", name: "my-mod", tag: "v1.2.3", notes: "" },
    },
  },
  openExternal: { send: { type: "openExternal", url: "https://github.com/Owner/my-mod" } },
};

const SETUP_DRIVES: Record<SetupInbound["type"], Drive<SetupInbound>> = {
  redetect: { send: { type: "redetect" } },
  browse: { send: { type: "browse", which: "saved" } },
  save: { send: { type: "save", savedGames: "D:\\SG\\DCS" } },
};

const NEWPROJECT_DRIVES: Record<NewProjectInbound["type"], Drive<NewProjectInbound>> = {
  browse: { send: { type: "browse", location: "E:\\Projects" } },
  create: {
    send: { type: "create", template: "blank", name: "my-mod", location: "E:\\Projects" },
  },
};

const MANIFEST_DRIVES: Record<ManifestInbound["type"], Drive<ManifestInbound>> = {
  // Deliberately not the document's current text: an identical buffer is refused
  // by design, so driving with one would test the refusal, not the handler.
  edit: { send: { type: "edit", text: '[project]\nname = "renamed-in-the-form"\n' } },
};

const DOCS_DRIVES: Record<DocsInbound["type"], Drive<DocsInbound>> = {
  run: { send: { type: "run", command: "dcs.marketplace.open" } },
  openExternal: {
    send: { type: "openExternal", url: "https://www.digitalcombatsimulator.com/" },
  },
};

const SKILLS_DRIVES: Record<SkillsInbound["type"], Drive<SkillsInbound>> = {
  refresh: { send: { type: "refresh" } },
  install: { send: { type: "install", id: SKILL_ID } },
  open: { send: { type: "open", id: SKILL_ID } },
  viewBundled: { send: { type: "viewBundled", id: SKILL_ID } },
  remove: { send: { type: "remove", id: SKILL_ID } },
};

const NAV_DRIVES: Record<NavInbound["type"], Drive<NavInbound>> = {
  run: { send: { type: "run", command: "dcs.marketplace.open" } },
};

// ── The contract table itself ────────────────────────────────────────────────

describe("the declared webview contract", () => {
  it("names a protocol for every presenter-backed webview and nothing else", () => {
    expect(Object.keys(WEBVIEW_PROTOCOLS).sort()).toEqual([
      "console",
      "docs",
      "log",
      "manifest",
      "marketplace",
      "mymods",
      "nav",
      "newproject",
      "publish",
      "setup",
      "skills",
    ]);
  });

  it("leaves nothing uncovered", () => {
    // The end of card 14's rollout, asserted rather than described: every webview
    // in `previews/` is now declared, which is what makes the census in
    // `test/integration/webview/webviewContract.test.ts` a total assertion. The
    // list survives, empty, as the honest place to name a twelfth webview that
    // arrives without a presenter — so this is not the same test as the census.
    expect(UNCOVERED_WEBVIEWS).toEqual([]);
  });

  it("declares a non-empty message set in both directions", () => {
    // Guards the guard: every assertion below is an equality against these
    // lists, and an equality against nothing is satisfied by nothing.
    for (const [name, p] of Object.entries(WEBVIEW_PROTOCOLS)) {
      expect(p.toHost.length, `${name}.toHost`).toBeGreaterThan(0);
      expect(p.toWebview.length, `${name}.toWebview`).toBeGreaterThan(0);
    }
  });

  it("only calls a message silent if it is one the host actually pushes", () => {
    for (const [name, p] of Object.entries(WEBVIEW_PROTOCOLS)) {
      for (const s of p.silent) expect(p.toWebview, `${name}.silent`).toContain(s);
    }
  });

  it("does not name a covered panel as uncovered", () => {
    for (const name of Object.keys(WEBVIEW_PROTOCOLS))
      expect(UNCOVERED_WEBVIEWS).not.toContain(name);
  });
});

// ── Console: the host half ───────────────────────────────────────────────────

describe("console — webview -> host", () => {
  it("drives exactly the declared message set", () => {
    expect(Object.keys(CONSOLE_DRIVES).sort()).toEqual([...CONSOLE_PROTOCOL.toHost].sort());
  });

  it.each(CONSOLE_PROTOCOL.toHost)("%s is acted on", async (type) => {
    const plan = CONSOLE_DRIVES[type as ConsoleInbound["type"]];
    const h = consoleHarness();
    for (const m of plan.before ?? []) await h.presenter.handle(m);
    const before = h.interactions();
    await h.presenter.handle(plan.send);
    expect(h.interactions()).toBeGreaterThan(before);
  });

  it("does nothing at all for a message type the contract does not declare", () => {
    // The negative control. Without it, "the presenter did something" could be
    // true for every input and the test above would prove nothing.
    const h = consoleHarness();
    void h.presenter.handle({ type: "notInTheContract" } as unknown as ConsoleInbound);
    expect(h.interactions()).toBe(0);
  });
});

describe("console — host -> webview", () => {
  it("produces exactly the declared message set", async () => {
    const h = consoleHarness();
    h.presenter.pushStatus(STATUS);
    h.presenter.pushConfig();
    await h.presenter.handle({ type: "eval", code: "return 1" });
    h.bridge.evalOk = false;
    await h.presenter.handle({ type: "eval", code: "boom" });
    await h.presenter.handle({ type: "inspect", expr: "_G", id: 1 });
    await h.presenter.handle({ type: "expand", ref: 2, nodeId: 3 });
    await h.presenter.handle({ type: "signature", ref: 2, reqId: 4 });
    await h.presenter.handle({ type: "export", ref: 2, reqId: 5 });
    // The tail loop is the only producer of `print`, and only once a bridge has
    // gone from disconnected to connected with lines waiting in its ring.
    h.bridge.lines = [{ seq: 1, text: "hello from the sim" }];
    await h.presenter.poll();

    expect(typesOf(h.posted)).toEqual([...CONSOLE_PROTOCOL.toWebview].sort());
  });
});

// ── Marketplace: the host half ───────────────────────────────────────────────

describe("marketplace — webview -> host", () => {
  it("drives exactly the declared message set", () => {
    expect(Object.keys(MARKETPLACE_DRIVES).sort()).toEqual([...MARKETPLACE_PROTOCOL.toHost].sort());
  });

  it.each(MARKETPLACE_PROTOCOL.toHost)("%s is acted on", async (type) => {
    const plan = MARKETPLACE_DRIVES[type as MarketplaceInbound["type"]];
    const h = marketplaceHarness();
    for (const m of plan.before ?? []) await h.presenter.handle(m);
    const before = h.interactions();
    await h.presenter.handle(plan.send);
    expect(h.interactions()).toBeGreaterThan(before);
  });

  it("does nothing at all for a message type the contract does not declare", () => {
    const h = marketplaceHarness();
    void h.presenter.handle({ type: "notInTheContract" } as unknown as MarketplaceInbound);
    expect(h.interactions()).toBe(0);
  });
});

describe("marketplace — host -> webview", () => {
  it("produces exactly the declared message set", async () => {
    const posted: MarketplaceHostMessage[] = [];
    /** Run one scripted session and fold its posts into the observed set. */
    const session = async (
      over: Partial<MarketplacePresenterDeps>,
      drive: (p: MarketplacePresenter) => Promise<void>,
    ): Promise<void> => {
      const h = marketplaceHarness(over);
      await drive(h.presenter);
      posted.push(...h.posted);
    };

    // Signed in and discovering: auth, listings:busy, listings.
    await session(
      {
        auth: {
          getToken: async () => "tok",
          onDidChangeSessions: () => ({ dispose: () => {} }),
          currentSession: async () => ({ token: "tok", accountLabel: "pilot" }),
          signIn: async () => ({ token: "tok", accountLabel: "pilot" }),
        },
      },
      (p) => p.handle({ type: "ready" }),
    );

    // Discovery that fails: listings:error.
    await session(
      {
        market: {
          discover: async () => {
            throw new Error("rate limited");
          },
          loadProduct: async () => product(),
        },
      },
      (p) => p.discover(false),
    );

    // A product that loads: product:busy, product.
    await session({}, (p) => p.handle({ type: "openProduct", repo: "Owner/Repo" }));

    // A product that does not: product:error.
    await session(
      {
        market: {
          discover: async () => [],
          loadProduct: async () => {
            throw new Error("502 Bad Gateway");
          },
        },
      },
      (p) => p.handle({ type: "openProduct", repo: "Owner/Repo" }),
    );

    // A successful install: installProgress, installed.
    await session({}, async (p) => {
      await p.handle({ type: "openProduct", repo: "Owner/Repo" });
      await p.handle({ type: "install", repo: "Owner/Repo" });
    });

    // A failed install: installError.
    await session(
      {
        subs: {
          install: async () => {
            throw new Error("network down");
          },
          unsubscribe: async () => {},
          fetchPlan: async () => null,
          isSubscribed: async () => false,
        } as MarketplacePresenterDeps["subs"],
      },
      async (p) => {
        await p.handle({ type: "openProduct", repo: "Owner/Repo" });
        await p.handle({ type: "install", repo: "Owner/Repo" });
      },
    );

    // Removing it again: uninstalled.
    await session({}, (p) => p.handle({ type: "uninstall", repo: "Owner/Repo" }));

    expect(typesOf(posted)).toEqual([...MARKETPLACE_PROTOCOL.toWebview].sort());
  });
});

// ── My Mods: the host half ───────────────────────────────────────────────────

describe("mymods — webview -> host", () => {
  it("drives exactly the declared message set", () => {
    expect(Object.keys(MYMODS_DRIVES).sort()).toEqual([...MYMODS_PROTOCOL.toHost].sort());
  });

  it.each(MYMODS_PROTOCOL.toHost)("%s is acted on", async (type) => {
    const plan = MYMODS_DRIVES[type as MyModsInbound["type"]];
    const h = myModsHarness();
    for (const m of plan.before ?? []) await h.presenter.handle(m);
    const before = h.interactions();
    await h.presenter.handle(plan.send);
    expect(h.interactions()).toBeGreaterThan(before);
  });

  it("does nothing at all for a message type the contract does not declare", async () => {
    const h = myModsHarness();
    await h.presenter.handle({ type: "notInTheContract" } as unknown as MyModsInbound);
    expect(h.interactions()).toBe(0);
  });
});

// ── Log: the host half ───────────────────────────────────────────────────────

describe("log — webview -> host", () => {
  it("drives exactly the declared message set", () => {
    expect(Object.keys(LOG_DRIVES).sort()).toEqual([...LOG_PROTOCOL.toHost].sort());
  });

  it.each(LOG_PROTOCOL.toHost)("%s is acted on", (type) => {
    const plan = LOG_DRIVES[type as LogInbound["type"]];
    const h = logHarness();
    plan.setup?.(h.presenter);
    const before = h.fingerprint();
    h.presenter.handle(plan.send);
    expect(h.fingerprint()).not.toBe(before);
  });

  it("does nothing at all for a message type the contract does not declare", () => {
    // The negative control, and the one that matters most here: the fingerprint
    // includes replayed state, so without this "something changed" could be true
    // for any input at all.
    const h = logHarness();
    h.presenter.onLines([LOG_LINE]);
    const before = h.fingerprint();
    h.presenter.handle({ type: "notInTheContract" } as unknown as LogInbound);
    expect(h.fingerprint()).toBe(before);
  });
});

describe("log — host -> webview", () => {
  it("produces exactly the declared message set", async () => {
    const h = logHarness();
    // `mod` — the manifest read the panel does before its first tail.
    await h.presenter.loadModIdentity();
    // The three tailer callbacks: `fileState`, `append`, `reset`.
    h.presenter.onState("ok");
    h.presenter.onLines([LOG_LINE]);
    h.presenter.onReset();
    // `init` — the webview's boot handshake.
    h.presenter.handle({ type: "ready" });

    expect(typesOf(h.posted)).toEqual([...LOG_PROTOCOL.toWebview].sort());
  });
});

// ── Publish: the host half ───────────────────────────────────────────────────

describe("publish — webview -> host", () => {
  it("drives exactly the declared message set", () => {
    expect(Object.keys(PUBLISH_DRIVES).sort()).toEqual([...PUBLISH_PROTOCOL.toHost].sort());
  });

  it.each(PUBLISH_PROTOCOL.toHost)("%s is acted on", async (type) => {
    const plan = PUBLISH_DRIVES[type as PublishInbound["type"]];
    const h = publishHarness();
    for (const m of plan.before ?? []) await h.presenter.handle(m);
    const before = h.interactions();
    await h.presenter.handle(plan.send);
    expect(h.interactions()).toBeGreaterThan(before);
  });

  it("does nothing at all for a message type the contract does not declare", async () => {
    const h = publishHarness();
    await h.presenter.handle({ type: "notInTheContract" } as unknown as PublishInbound);
    expect(h.interactions()).toBe(0);
  });
});

describe("publish — host -> webview", () => {
  it("produces exactly the declared message set", async () => {
    const posted: PublishHostMessage[] = [];

    // `init` — the opening render; `busy`, `log` and `shareDone`/`releaseDone` —
    // the two long actions, bracketed.
    const h = publishHarness();
    await h.presenter.refresh();
    await h.presenter.handle({ type: "share", opts: { name: "my-mod", description: "" } });
    await h.presenter.handle({
      type: "release",
      opts: { owner: "Owner", name: "my-mod", tag: "v1.2.3", notes: "" },
    });
    posted.push(...h.posted);

    // `nofolder` — a different presenter entirely, because a folderless window
    // is a state the panel is CONSTRUCTED in rather than one it can reach.
    const none = publishHarness({ root: null });
    await none.presenter.refresh();
    posted.push(...none.posted);

    expect(typesOf(posted)).toEqual([...PUBLISH_PROTOCOL.toWebview].sort());
  });
});

// ── Setup: the host half ─────────────────────────────────────────────────────

describe("setup — webview -> host", () => {
  it("drives exactly the declared message set", () => {
    expect(Object.keys(SETUP_DRIVES).sort()).toEqual([...SETUP_PROTOCOL.toHost].sort());
  });

  it.each(SETUP_PROTOCOL.toHost)("%s is acted on", async (type) => {
    const plan = SETUP_DRIVES[type as SetupInbound["type"]];
    const h = setupHarness();
    for (const m of plan.before ?? []) await h.presenter.handle(m);
    const before = h.interactions();
    await h.presenter.handle(plan.send);
    expect(h.interactions()).toBeGreaterThan(before);
  });

  it("does nothing at all for a message type the contract does not declare", async () => {
    const h = setupHarness();
    await h.presenter.handle({ type: "notInTheContract" } as unknown as SetupInbound);
    expect(h.interactions()).toBe(0);
  });
});

describe("setup — host -> webview", () => {
  it("produces exactly the declared message set", async () => {
    const h = setupHarness();
    // `init` — the opening push, which is the only thing that fills the form:
    // media/setup.js renders empty at load and posts no handshake.
    await h.presenter.refresh();
    // `browsed` — a picker that answered.
    await h.presenter.handle({ type: "browse", which: "saved" });
    // `saved` — the acknowledgement the "Saved ✓" note flashes off.
    await h.presenter.handle({ type: "save" });

    expect(typesOf(h.posted)).toEqual([...SETUP_PROTOCOL.toWebview].sort());
  });
});

// ── New Project: the host half ───────────────────────────────────────────────

describe("newproject — webview -> host", () => {
  it("drives exactly the declared message set", () => {
    expect(Object.keys(NEWPROJECT_DRIVES).sort()).toEqual([...NEWPROJECT_PROTOCOL.toHost].sort());
  });

  it.each(NEWPROJECT_PROTOCOL.toHost)("%s is acted on", async (type) => {
    const plan = NEWPROJECT_DRIVES[type as NewProjectInbound["type"]];
    const h = newProjectHarness();
    for (const m of plan.before ?? []) await h.presenter.handle(m);
    const before = h.interactions();
    await h.presenter.handle(plan.send);
    expect(h.interactions()).toBeGreaterThan(before);
  });

  it("does nothing at all for a message type the contract does not declare", async () => {
    const h = newProjectHarness();
    await h.presenter.handle({ type: "notInTheContract" } as unknown as NewProjectInbound);
    expect(h.interactions()).toBe(0);
  });
});

describe("newproject — host -> webview", () => {
  it("produces exactly the declared message set", async () => {
    const posted: NewProjectHostMessage[] = [];

    // `init` — the unprompted opening render; `browsed` — the picker's answer;
    // `created` — a scaffold that worked.
    const h = newProjectHarness();
    h.presenter.pushInit();
    await h.presenter.handle({ type: "browse", location: "E:\\Projects" });
    await h.presenter.handle({ type: "create", name: "my-mod", location: "E:\\Projects" });
    posted.push(...h.posted);

    // `error` — the one path the panel survives, so it needs a world where the
    // scaffold refuses rather than a second message.
    const failing = newProjectHarness({
      scaffoldNewFolder: async () => {
        throw new Error("Folder already exists and is not empty.");
      },
    });
    await failing.presenter.handle({ type: "create", name: "my-mod", location: "E:\\Projects" });
    posted.push(...failing.posted);

    expect(typesOf(posted)).toEqual([...NEWPROJECT_PROTOCOL.toWebview].sort());
  });
});

// ── Manifest: the host half ──────────────────────────────────────────────────

describe("manifest — webview -> host", () => {
  it("drives exactly the declared message set", () => {
    expect(Object.keys(MANIFEST_DRIVES).sort()).toEqual([...MANIFEST_PROTOCOL.toHost].sort());
  });

  it.each(MANIFEST_PROTOCOL.toHost)("%s is acted on", async (type) => {
    const plan = MANIFEST_DRIVES[type as ManifestInbound["type"]];
    const h = manifestHarness();
    for (const m of plan.before ?? []) await h.presenter.handle(m);
    const before = h.interactions();
    await h.presenter.handle(plan.send);
    expect(h.interactions()).toBeGreaterThan(before);
  });

  it("does nothing at all for a message type the contract does not declare", async () => {
    const h = manifestHarness();
    await h.presenter.handle({ type: "notInTheContract" } as unknown as ManifestInbound);
    expect(h.interactions()).toBe(0);
  });
});

describe("manifest — host -> webview", () => {
  it("produces exactly the declared message set", async () => {
    // One presenter is enough, and the reason is worth recording: this panel has
    // no `init` to produce, because its opening state crosses inside the document
    // as `window.__BOOTSTRAP__` rather than as a message. So both declared pushes
    // are reachable from the state the form opens in.
    const h = manifestHarness();
    // `external` — the document changed under the form, and not by the form.
    h.setText("[project]\nname = 'edited-in-editor'\n");
    h.presenter.onDocumentChanged();
    // `roots` — the DCS paths changed while the form was open.
    h.presenter.pushRoots();

    expect(typesOf(h.posted)).toEqual([...MANIFEST_PROTOCOL.toWebview].sort());
  });
});

// ── Docs: the host half ──────────────────────────────────────────────────────

describe("docs — webview -> host", () => {
  it("drives exactly the declared message set", () => {
    expect(Object.keys(DOCS_DRIVES).sort()).toEqual([...DOCS_PROTOCOL.toHost].sort());
  });

  it.each(DOCS_PROTOCOL.toHost)("%s is acted on", (type) => {
    const plan = DOCS_DRIVES[type as DocsInbound["type"]];
    const h = docsHarness();
    for (const m of plan.before ?? []) h.presenter.handle(m);
    const before = h.interactions();
    h.presenter.handle(plan.send);
    expect(h.interactions()).toBeGreaterThan(before);
  });

  it("does nothing at all for a message type the contract does not declare", () => {
    const h = docsHarness();
    h.presenter.handle({ type: "notInTheContract" } as unknown as DocsInbound);
    expect(h.interactions()).toBe(0);
  });
});

describe("docs — host -> webview", () => {
  it("produces exactly the declared message set", () => {
    // One presenter and one call, because this panel pushes one message. Its
    // opening state is not among them: like the manifest form's bootstrap, the
    // deep link crosses inside the DOCUMENT rather than over the channel, so the
    // only thing the host ever sends is the navigate half of that same rule.
    const h = docsHarness();
    h.presenter.navigate("sandbox");

    expect(typesOf(h.posted)).toEqual([...DOCS_PROTOCOL.toWebview].sort());
  });
});

// ── Agent Skills: the host half ──────────────────────────────────────────────

describe("skills — webview -> host", () => {
  it("drives exactly the declared message set", () => {
    expect(Object.keys(SKILLS_DRIVES).sort()).toEqual([...SKILLS_PROTOCOL.toHost].sort());
  });

  it.each(SKILLS_PROTOCOL.toHost)("%s is acted on", async (type) => {
    const plan = SKILLS_DRIVES[type as SkillsInbound["type"]];
    const h = skillsHarness();
    for (const m of plan.before ?? []) await h.presenter.handle(m);
    const before = h.interactions();
    await h.presenter.handle(plan.send);
    expect(h.interactions()).toBeGreaterThan(before);
  });

  it("does nothing at all for a message type the contract does not declare", async () => {
    const h = skillsHarness();
    await h.presenter.handle({ type: "notInTheContract" } as unknown as SkillsInbound);
    expect(h.interactions()).toBe(0);
  });
});

describe("skills — host -> webview", () => {
  it("produces exactly the declared message set", async () => {
    // One presenter and one call, because this panel pushes one message — and that
    // one message is the whole screen, which is why there is no second state to
    // reach for the way publish and New Project need a second world.
    const h = skillsHarness();
    await h.presenter.refresh();

    expect(typesOf(h.posted)).toEqual([...SKILLS_PROTOCOL.toWebview].sort());
  });
});

// ── Sidebar nav: the host half ───────────────────────────────────────────────

describe("nav — webview -> host", () => {
  it("drives exactly the declared message set", () => {
    expect(Object.keys(NAV_DRIVES).sort()).toEqual([...NAV_PROTOCOL.toHost].sort());
  });

  it.each(NAV_PROTOCOL.toHost)("%s is acted on", (type) => {
    const plan = NAV_DRIVES[type as NavInbound["type"]];
    const h = navHarness();
    for (const m of plan.before ?? []) h.presenter.handle(m);
    const before = h.interactions();
    h.presenter.handle(plan.send);
    expect(h.interactions()).toBeGreaterThan(before);
  });

  it("does nothing at all for a message type the contract does not declare", () => {
    const h = navHarness();
    h.presenter.handle({ type: "notInTheContract" } as unknown as NavInbound);
    expect(h.interactions()).toBe(0);
  });
});

describe("nav — host -> webview", () => {
  it("produces exactly the declared message set", async () => {
    // Three pushes from three independent signals, and none of them is a reply:
    // the sidebar's webview posts nothing but `run`, so every message here is the
    // host volunteering. One presenter is enough — unlike publish, the sidebar has
    // no state it is CONSTRUCTED in that it cannot also reach.
    const h = navHarness();
    h.presenter.pushStatus(STATUS);
    await h.presenter.pushSkills();
    await h.presenter.pushManifest();

    expect(typesOf(h.posted)).toEqual([...NAV_PROTOCOL.toWebview].sort());
  });
});

describe("mymods — host -> webview", () => {
  it("produces exactly the declared message set", async () => {
    const h = myModsHarness();
    // `init` — every redraw; `busy` — any lifecycle action latching the row.
    await h.presenter.handle({ type: "enable", repo: REPO });
    // `progress` — only the update path, and only for a tag newer than the
    // installed one (an up-to-date mod is deliberately not re-downloaded).
    await h.presenter.handle({ type: "update", repo: REPO });
    // `entrypoint` — the Launch/Stop pair.
    await h.presenter.handle({ type: "launch", repo: REPO, id: "gui" });
    await h.presenter.handle({ type: "stop", repo: REPO, id: "gui" });

    expect(typesOf(h.posted)).toEqual([...MYMODS_PROTOCOL.toWebview].sort());
  });
});
