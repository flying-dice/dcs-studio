// Fixture for previews/manifest.html. media/manifest.js reads
// window.__BOOTSTRAP__ synchronously at load (raw TOML text, the target
// file path, and the resolved install roots) — ported from the old
// preview-author.html. `roots.gameInstall` is deliberately left blank so the
// {GameInstall}-not-configured warning renders by default (manifest.spec.ts
// asserts the unresolved-warning testid off this).
window.__BOOTSTRAP__ = {
  rawText:
    '[project]\nname = "f16-weapons-expansion"\nversion = "2.3.1"\nauthor = "viper-drivers"\ndescription = "Extra A/G stores for the F-16C, wired into the rearm menu."\n\n[[install]]\nsource = "dist/scripts"\ndest = "{SavedGames}/Scripts/WeaponsExpansion"\n\n[[install]]\nsource = "dist/mod"\ndest = "{SavedGames}/Mods/tech/F16Weapons"\n\n[[dependencies]]\nid = "utils/dcs-lua-common"\nversion = "*"\n\n[[requires_module]]\nid = "F-16C_50"\nname = "F-16C Viper"\n',
  targetPath: "E:\\projects\\f16-weapons-expansion\\dcs-studio.toml",
  roots: { savedGames: "C:\\Users\\jonat\\Saved Games\\DCS", gameInstall: "" },
};

window.__host.onPost((m) => {
  if (!m) return;
  if (m.type === "openExternal" && m.url) window.__toast(`Opening ${m.url} &hellip;`);
  // m.type === "edit": the real host applies this as a WorkspaceEdit to the
  // open document. Nothing to simulate here — the form is its own preview.
});
