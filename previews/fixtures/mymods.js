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
        },
        {
          repo: "Owner/Disabled-Mod",
          name: "Disabled Mod",
          tag: "v0.2.0",
          enabled: false,
          dir: "D:\\DCS Studio\\data\\Owner__Disabled-Mod",
          links: 0,
          entrypoints: [{ id: "hidden", name: "Hidden", exe: "app.exe" }],
        },
        {
          repo: "Owner/Plain-Mod",
          name: "Plain Mod",
          tag: "v3.0.0",
          enabled: true,
          dir: "D:\\DCS Studio\\data\\Owner__Plain-Mod",
          links: 2,
          entrypoints: [],
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
