import { type DcsCandidate, roleProbePath, type SetupRole } from "../domain/dcsDetect";
import type { SetupHostMessage, SetupPaths, SetupWebviewMessage } from "./webviewContract";

// The DCS Setup panel's decision logic, lifted out of the VS Code panel.
//
// This is the first-run gate: everything else in the extension resolves through
// the paths chosen here, and a user who cannot get past this screen sees a
// product that appears not to work at all. `core/app/detectService.ts` already
// owned the detection sweep and `core/domain/dcsDetect.ts` the per-role path
// rules — but the decisions BETWEEN them were welded to the panel:
//
//  - the init payload: which four settings seed the form, each trimmed and each
//    falling back to `""` rather than `undefined` (the webview binds them
//    straight into inputs, where `undefined` renders as the literal text
//    "undefined"), plus the data-dir default and the auto-detected 7-Zip whose
//    "not found" is also `""` rather than null;
//  - which role a browse dialog is FOR — file versus folder, its open label,
//    and its file filter — and what an absent role falls back to;
//  - validating a hand-picked path by probing the role's own witness path, with
//    a probe the OS refuses treated as invalid rather than thrown;
//  - saving: all four settings written, an omitted field written as `""` so
//    clearing a box actually reaches the settings file, then the acknowledgement.
//
// None of it knows about VS Code. What stays in the shell (`src/setup/panel.ts`)
// is the panel, the settings read/write, the open dialog, the existence probe
// and the one effect below.

/** Something only the editor can do, described rather than done. */
export type SetupEffect = { kind: "notify"; message: string };

/**
 * The message shapes the setup webview sends the host — the declared contract,
 * not a local restatement of it. Named here as well so the panel keeps importing
 * its boundary type from the module it talks to.
 */
export type SetupInbound = SetupWebviewMessage;

/** What a browse dialog should ask for, decided here and performed by the shell. */
export interface SetupBrowseRequest {
  /** A single file (`7z.exe`) rather than a folder. */
  file: boolean;
  /** The dialog's confirm-button label, naming the role in the user's terms. */
  openLabel: string;
  /** Extensions to filter to, or `null` for a folder pick. */
  extensions: readonly string[] | null;
}

export interface SetupPresenterDeps {
  /** Detected DCS Saved Games write dirs, in preference order. */
  detectSavedGames: () => Promise<DcsCandidate[]>;
  /** Detected DCS game installs, deduped. */
  detectGameInstalls: () => Promise<DcsCandidate[]>;
  /**
   * The four `dcsStudio` path settings as currently configured. Raw, untrimmed
   * and possibly absent — the trimming and the `""` fallback are decisions, and
   * they are made below rather than by whatever reads the settings file.
   */
  settings: () => { [K in keyof SetupPaths]: string | undefined };
  /** Write one `dcsStudio` path setting globally. */
  saveSetting: (key: keyof SetupPaths, value: string) => Promise<void>;
  /** Where mods are unpacked when the user has set no `dataDir`. */
  defaultDataDir: () => string;
  /**
   * Where the archiver would be found, or `null`/`undefined` when nowhere. The
   * port's own answer, so what the panel displays is what the installer gets.
   */
  detectedSevenZip: () => Promise<string | null | undefined>;
  /**
   * Ask the user to pick a path, or `null` if they cancelled. Welded to the
   * editor on the other side; WHAT to ask for is decided here.
   */
  browse: (request: SetupBrowseRequest) => Promise<string | null>;
  /**
   * Whether `path` exists. The per-role rule that turns a picked folder into the
   * path worth probing is pure and applied here; only the probe is a dep.
   *
   * Windows rejects some paths at the syscall level, so this may throw — and a
   * path the OS refuses to look at is reported invalid rather than crashing the
   * panel, which is the difference between a red pill and a dead screen.
   */
  exists: (path: string) => boolean;
  /**
   * Deliver a message to the webview. Typed to the declared host union, so a
   * message `media/setup.js` has no case for cannot be sent from here without
   * the contract being updated first.
   */
  post: (msg: SetupHostMessage) => void;
  /** Perform an editor-side effect. */
  effect: (effect: SetupEffect) => void;
}

/** The confirm-button label per browse role, in the user's own terms. */
const BROWSE_LABELS: Readonly<Record<SetupRole, string>> = {
  saved: "Use as DCS userdata",
  install: "Use as DCS install",
  data: "Use as data dir",
  sevenzip: "Use this 7z.exe",
};

/**
 * The role a browse with no `which` is treated as. The union declares what may
 * ARRIVE and a stale document may name no role at all; userdata is the panel's
 * first and most important field, so it is the one a nameless browse means.
 */
const DEFAULT_ROLE: SetupRole = "saved";

export class SetupPresenter {
  constructor(private readonly deps: SetupPresenterDeps) {}

  /** The panel's opening state, pushed unprompted: `media/setup.js` renders an
   * empty form at load and posts no handshake, so nothing asks for this. */
  async refresh(): Promise<void> {
    const [saved, installs, sevenZipDetected] = await Promise.all([
      this.deps.detectSavedGames(),
      this.deps.detectGameInstalls(),
      this.deps.detectedSevenZip(),
    ]);
    const cfg = this.deps.settings();
    this.deps.post({
      type: "init",
      // Trimmed, and `""` rather than `undefined` for every one of the four: the
      // webview binds these straight into `value="…"`.
      savedGames: cfg.savedGamesPath?.trim() ?? "",
      gameInstall: cfg.gameInstallPath?.trim() ?? "",
      dataDir: cfg.dataDir?.trim() ?? "",
      sevenZip: cfg.sevenZipPath?.trim() ?? "",
      // Shown as the data-dir input's placeholder, so it is never blank.
      dataDirDefault: this.deps.defaultDataDir(),
      sevenZipDetected: sevenZipDetected ?? "",
      savedCandidates: saved,
      installCandidates: installs,
    });
  }

  async handle(msg: SetupInbound): Promise<void> {
    switch (msg.type) {
      case "redetect":
        await this.refresh();
        break;
      case "browse":
        await this.browse(msg.which);
        break;
      case "save":
        await this.save(msg);
        break;
    }
  }

  /** Ask for a path for one role, and answer with it and its validity. */
  private async browse(which: SetupRole | undefined): Promise<void> {
    // Only 7-Zip is a file; every other role is a folder, and asking for the
    // wrong kind makes the right answer unpickable.
    const file = which === "sevenzip";
    const picked = await this.deps.browse({
      file,
      openLabel: BROWSE_LABELS[which ?? DEFAULT_ROLE],
      extensions: file ? ["exe"] : null,
    });
    // A cancelled dialog is not a choice: nothing is posted, so the form keeps
    // whatever the user had typed.
    if (picked === null) return;
    this.deps.post({ type: "browsed", which, path: picked, valid: this.validate(which, picked) });
  }

  /**
   * Whether a hand-picked path looks right for its role. The per-role witness
   * path is pure (`core/domain/dcsDetect`); the presenter performs the probe and
   * owns the two judgements around it — a role with no witness (`data`, where any
   * writable folder is fine) is valid by default, and a path the OS refuses to
   * probe is invalid rather than fatal.
   */
  private validate(which: SetupRole | undefined, target: string): boolean {
    try {
      const probe = roleProbePath(which, target);
      return probe === null ? true : this.deps.exists(probe);
    } catch {
      return false;
    }
  }

  /**
   * Write all four settings and acknowledge. Every field is written even when the
   * message omitted it, as `""`: leaving the old value in place would make
   * clearing a box look like a broken button.
   */
  private async save(msg: Extract<SetupInbound, { type: "save" }>): Promise<void> {
    await this.deps.saveSetting("savedGamesPath", msg.savedGames ?? "");
    await this.deps.saveSetting("gameInstallPath", msg.gameInstall ?? "");
    await this.deps.saveSetting("dataDir", msg.dataDir ?? "");
    await this.deps.saveSetting("sevenZipPath", msg.sevenZip ?? "");
    this.deps.post({ type: "saved" });
    this.deps.effect({ kind: "notify", message: "DCS paths saved." });
  }
}
