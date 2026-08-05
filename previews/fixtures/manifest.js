// Fixture for previews/manifest.html. media/manifest.js reads
// window.__BOOTSTRAP__ synchronously at load (raw TOML text, the target
// file path, and the resolved install roots) — ported from the old
// preview-author.html. `roots.gameInstall` is deliberately left blank so the
// {GameInstall}-not-configured warning renders by default (manifest.spec.ts
// asserts the unresolved-warning testid off this).
//
// The bootstrap deliberately mixes several things so the preview exercises the
// full parse surface: an explicit [[bundle]]/[[symlink]] pair (the new schema,
// the only source the Bundled content / Symlinks cards render from), an
// [[entrypoint]] block (the Executables card, incl. args/cwd), a
// [[mission_script]] block (the Mission scripts card), and two unmodeled
// sections — [[install]] (pre-release breaking change, 2026-07: no longer
// normalized into bundle/symlink, kept here only to prove it passes through
// extras like any other unknown section) and [[dependencies]] — both proving
// the extras round-trip is preserved through emit.
const FULL =
  '[project]\nname = "f16-weapons-expansion"\nversion = "2.3.1"\nauthor = "viper-drivers"\ndescription = "Extra A/G stores for the F-16C, wired into the rearm menu."\n\n[[bundle]]\npath = "Mods/tech/F16Weapons"\n\n[[symlink]]\nsource = "Mods/tech/F16Weapons/entry.lua"\ndest = "{SavedGames}/Mods/tech/F16Weapons/entry.lua"\n\n[[entrypoint]]\nid = "f16-tool"\nname = "F16 Config Tool"\nexe = "Mods/tech/F16Weapons/tool.exe"\nargs = ["--quiet"]\ncwd = "Mods/tech/F16Weapons"\n\n[[mission_script]]\nname = "F16 Weapons init"\npurpose = "Registers the extra stores at mission start"\npath = "Mods/tech/F16Weapons/init.lua"\nrun_on = "after-sanitize"\n\n[[install]]\nsource = "dist/scripts"\ndest = "{SavedGames}/Scripts/WeaponsExpansion"\n\n[[dependencies]]\nid = "utils/dcs-lua-common"\nversion = "*"\n\n[[requires_module]]\nid = "F-16C_50"\nname = "F-16C Viper"\n';

// `?project=numeric` — a [project] block whose scalars are written as bare
// TOML numbers rather than quoted strings. Valid TOML that used to reach the
// form as JS numbers and throw out of the validation pass, leaving the form
// drawn but inert (issue #22).
const NUMERIC = '[project]\nname = 2024\nversion = 3\n\n[[bundle]]\npath = "Scripts"\n';

window.__BOOTSTRAP__ = {
  rawText: new URLSearchParams(location.search).get("project") === "numeric" ? NUMERIC : FULL,
  // `?target=unsaved` drops the path entirely — the shape the form gets when
  // the document it's bound to has no file on disk yet.
  targetPath:
    new URLSearchParams(location.search).get("target") === "unsaved"
      ? ""
      : "E:\\projects\\f16-weapons-expansion\\dcs-studio.toml",
  roots: { savedGames: "C:\\Users\\jonat\\Saved Games\\DCS", gameInstall: "" },
};

// {edit} needs no simulation — the real host applies it as a WorkspaceEdit to
// the open document, and the form is its own preview of that.
//
// {bundlePreview} does: it is the form's one round trip, and only the host can
// answer it because only the host can look at the disk. The reply below is what
// a real BundlePreviewService would return for the FULL bootstrap above —
// manifest first and flagged always-included, the [[bundle]] folder measured as
// a tree, and one path that is not there yet, which is the state a project with
// an unbuilt DLL is in and the row the preview exists to show.
//
// `?bundle=` picks a different answer:
//   split   — a payload over the volume threshold, so the split warning renders
//   error   — the host failed to measure (a tree being rewritten under the walk)
//   minimal — nothing declared at all, which is a brand-new form: the archive is
//             the manifest and only the manifest, and it is the one state where
//             the totals are singular
const BUNDLE_MODE = new URLSearchParams(location.search).get("bundle");

const MANIFEST_ROW = { path: "dcs-studio.toml", always: true, kind: "file", files: 1, bytes: 812 };

const ROWS = [
  MANIFEST_ROW,
  { path: "Mods/tech/F16Weapons", always: false, kind: "dir", files: 12, bytes: 34 * 1024 },
  // A plain file entry beside the folder, because they read differently: a file
  // gets its size, a folder says what it drags in with it.
  { path: "Mods/tech/F16Weapons.lua", always: false, kind: "file", files: 1, bytes: 4096 },
  { path: "target/release/f16_weapons.dll", always: false, kind: "missing", files: 0, bytes: 0 },
];

const GIB = 1024 * 1024 * 1024;

window.__host.onPost((m) => {
  if (m.type !== "bundlePreview") return;
  if (BUNDLE_MODE === "error") {
    window.__host.receive({
      type: "bundlePreviewResult",
      error: "EBUSY: resource busy or locked, scandir 'target\\release'",
    });
    return;
  }
  const split = BUNDLE_MODE === "split";
  const minimal = BUNDLE_MODE === "minimal";
  window.__host.receive({
    type: "bundlePreviewResult",
    preview: {
      // Derived from the posted [project] fields, exactly as previewArchiveName
      // does — so typing in the Name box moves the archive name on screen.
      archiveName: `dcs-studio-${(m.name || "your-mod").toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}-${m.version || "0.1.0"}.7z`,
      rows: minimal ? [MANIFEST_ROW] : ROWS,
      totalFiles: minimal ? 1 : split ? 4200 : 14,
      totalBytes: minimal ? 812 : split ? 2 * GIB : 812 + 34 * 1024 + 4096,
      missing: minimal ? 0 : 1,
      volumeBytes: Math.round(1.5 * GIB),
      likelySplit: split,
    },
  });
});
