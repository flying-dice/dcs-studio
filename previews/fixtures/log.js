// Fixture for previews/log.html. media/log.js posts {type:"ready"}
// synchronously at load and expects a {type:"init", entries, mod, file,
// state} reply — one entry per level, a "mine" row, and an ERROR row with a
// stack-trace continuation, all visible by default. Tests that need other
// shapes (missing file, empty log, more append batches) push fresh messages
// directly via hostSend().
(function () {
  window.__FIXTURE__ = {
    init: {
      type: "init",
      mod: { slug: "my-mod", name: "My Mod" },
      file: "C:\\Users\\test\\Saved Games\\DCS\\Logs\\dcs.log",
      state: "ok",
      entries: [
        {
          seq: 1,
          time: "2026-07-13 12:00:00.001",
          level: "INFO",
          subsystem: "my-mod",
          thread: "Main",
          message: "loaded v0.1.0",
          mine: true,
          cont: [],
        },
        {
          seq: 2,
          time: "2026-07-13 12:00:01.002",
          level: "WARNING",
          subsystem: "other-mod",
          thread: "Main",
          message: "something looked odd",
          mine: false,
          cont: [],
        },
        {
          seq: 3,
          time: "2026-07-13 12:00:02.003",
          level: "ERROR",
          subsystem: "my-mod",
          thread: "Main",
          message: "boom: nil value",
          mine: true,
          cont: ["    at my-mod/init.lua:42: in function 'start'", "    at my-mod/init.lua:7: in main chunk"],
        },
        {
          seq: 4,
          time: "2026-07-13 12:00:03.004",
          level: "DEBUG",
          subsystem: "SCRIPTING",
          thread: "Main",
          message: "[My Mod] debug detail",
          mine: true,
          cont: [],
        },
        {
          seq: 5,
          time: "2026-07-13 12:00:04.005",
          level: "ALERT",
          subsystem: "engine",
          thread: "Render",
          message: "critical alert from the engine",
          mine: false,
          cont: [],
        },
      ],
    },
  };

  window.__host.onPost((m) => {
    if (!m) return;
    if (m.type === "ready") {
      window.__host.receive(window.__FIXTURE__.init);
      return;
    }
    window.__toast(`&rarr; posts <b>${m.type}</b>`);
  });
})();
