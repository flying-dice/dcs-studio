// Fixture for previews/mymods.html. media/mymods.js posts {type:"refresh"}
// synchronously at load and expects an {type:"init", dataDir, uninstallBat,
// mods, running} reply. Each mod carries its declared `entrypoints`; the panel
// shows Launch/Stop rows only for ENABLED mods that declare entrypoints.
//
// This fixture scripts the host side of the launch lifecycle so the webview's
// running/error state transitions are testable without a real process:
//   - launch of a normal entrypoint  -> {entrypoint, running:true}
//   - launch of the "broken" entrypoint -> {entrypoint, running:false, error}
//   - stop                            -> {entrypoint, running:false}
(function () {
  // JS mirror of src/core/domain/installManifestView.ts — the host derives this
  // from the ledger snapshot and posts it; the fixture reproduces the shape so
  // the webview renders exactly what production would.
  function deriveManifest(surface) {
    const bundles = (surface.bundles || []).map((b) => ({ path: b.path }));
    const symlinks = (surface.symlinks || []).map((s) => ({ source: s.source, dest: s.dest, resolved: s.resolved == null ? null : s.resolved }));
    const entrypoints = (surface.entrypoints || []).map((e) => ({ id: e.id, name: e.name, exe: e.exe, args: e.args || [], cwd: e.cwd == null ? null : e.cwd }));
    const missionScripts = (surface.missionScripts || []).map((m) => ({ name: m.name, purpose: m.purpose == null ? null : m.purpose, path: m.path, run_on: m.run_on, beforeSanitize: m.run_on === "before-sanitize" }));
    const beforeSanitize = missionScripts.filter((m) => m.beforeSanitize).length;
    const counts = { bundles: bundles.length, symlinks: symlinks.length, entrypoints: entrypoints.length, missionScripts: missionScripts.length, beforeSanitize };
    const risks = [];
    if (symlinks.length) risks.push("links-files");
    if (entrypoints.length) risks.push("runs-executable");
    if (beforeSanitize) risks.push("pre-sanitize-script");
    return { known: true, bundles, symlinks, entrypoints, missionScripts, counts, risks };
  }

  window.__FIXTURE__ = {
    init: {
      type: "init",
      dataDir: "D:\\DCS Studio\\data",
      uninstallBat: "D:\\DCS Studio\\data\\uninstall-all.bat",
      running: {},
      mods: [
        {
          repo: "Owner/DCS-SRS",
          name: "DCS-SRS",
          tag: "v1.0.0",
          enabled: true,
          dir: "D:\\DCS Studio\\data\\Owner__DCS-SRS",
          links: 1,
          entrypoints: [
            { id: "srs-server", name: "SRS Server", exe: "Server/SR-Server.exe", args: ["--minimized"], cwd: "Server" },
            { id: "broken", name: "Broken Tool", exe: "missing/tool.exe" },
          ],
          // Privileged: links files, runs an exe, injects a pre-sanitize script.
          manifest: deriveManifest({
            bundles: [{ path: "Server" }, { path: "Scripts/SRS" }],
            symlinks: [{ source: "Scripts/SRS/hook.lua", dest: "{SavedGames}/Scripts/Hooks/srs.lua" }],
            entrypoints: [
              { id: "srs-server", name: "SRS Server", exe: "Server/SR-Server.exe", args: ["--minimized"], cwd: "Server" },
              { id: "broken", name: "Broken Tool", exe: "missing/tool.exe" },
            ],
            missionScripts: [{ name: "SRS radio bridge", purpose: "Bridges radio state", path: "Scripts/SRS/radio.lua", run_on: "before-sanitize" }],
          }),
        },
        {
          repo: "Owner/Disabled-Mod",
          name: "Disabled Mod",
          tag: "v0.2.0",
          enabled: false,
          dir: "D:\\DCS Studio\\data\\Owner__Disabled-Mod",
          links: 0,
          entrypoints: [{ id: "hidden", name: "Hidden", exe: "app.exe" }],
          // Breakdown shows even for a disabled mod (transparency is independent
          // of the Launch/Stop rows, which only show for enabled mods).
          manifest: deriveManifest({
            bundles: [{ path: "app.exe" }],
            symlinks: [],
            entrypoints: [{ id: "hidden", name: "Hidden", exe: "app.exe" }],
            missionScripts: [],
          }),
        },
        {
          repo: "Owner/Plain-Mod",
          name: "Plain Mod",
          tag: "v3.0.0",
          enabled: true,
          dir: "D:\\DCS Studio\\data\\Owner__Plain-Mod",
          links: 2,
          entrypoints: [],
          // Benign: only links files + a sandboxed after-sanitize script.
          manifest: deriveManifest({
            bundles: [{ path: "Liveries" }],
            symlinks: [
              { source: "Liveries/A", dest: "{SavedGames}/Liveries/A" },
              { source: "Liveries/B", dest: "{SavedGames}/Liveries/B" },
            ],
            entrypoints: [],
            missionScripts: [{ name: "Livery loader", path: "Scripts/loader.lua", run_on: "after-sanitize" }],
          }),
        },
      ],
    },
  };

  window.__host.onPost((m) => {
    if (!m) return;
    if (m.type === "refresh") {
      window.__host.receive(window.__FIXTURE__.init);
      return;
    }
    if (m.type === "launch") {
      if (m.id === "broken") {
        window.__host.receive({
          type: "entrypoint",
          repo: m.repo,
          id: m.id,
          running: false,
          error: "Executable not found: missing/tool.exe",
        });
      } else {
        window.__host.receive({ type: "entrypoint", repo: m.repo, id: m.id, running: true });
      }
      return;
    }
    if (m.type === "stop") {
      window.__host.receive({ type: "entrypoint", repo: m.repo, id: m.id, running: false });
      return;
    }
    window.__toast(`&rarr; posts <b>${m.type}</b>`);
  });
})();
