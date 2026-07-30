// Fixture for previews/publish.html. media/publish.js posts {type:"refresh"}
// synchronously at load and expects either {type:"init", checks, repo,
// defaults} or {type:"nofolder"} back — the same two replies PublishPanel
// makes (src/publish/publishPanel.ts#pushInit).
//
// `?scenario=` picks which one, because publish is the flow where the
// interesting states are the ones that must NOT let you through:
//   (default)  preflight green, repo not yet on GitHub — the first-publish path
//   blocked    a red check, so Share/Release are disabled
//   shared     origin already points at a GitHub repo — the re-push path
//   bare       an empty manifest, so every `|| default` fallback shows
//   nofolder   no workspace folder open at all
//   nofolder-late  no workspace folder, but the fixture withholds its reply to
//                  the boot `refresh` — the test pushes `nofolder` itself, to
//                  prove a late reply still renders correctly rather than the
//                  panel staying stuck empty (card 22's handshake race).
//
// Share/Release replies are scripted end-to-end (busy on -> log -> done ->
// busy off) exactly as PublishPanel#guard sequences them, so clicking through
// the preview shows the real result panes. Tests that need to hold the page in
// a mid-flight state push {type:"busy"} themselves via hostSend().
(() => {
  const scenario = new URLSearchParams(location.search).get("scenario") || "";

  const OK_CHECKS = [
    { level: "ok", label: "Manifest", detail: "dcs-studio.toml parses" },
    { level: "ok", label: "git", detail: "git 2.43.0 on PATH" },
    {
      level: "warn",
      label: "Bundle sources",
      detail: "1 source is a symlink",
      items: ["bin/mymod.dll → ../target/release/mymod.dll"],
    },
  ];

  const BLOCKED_CHECKS = [
    { level: "ok", label: "Manifest", detail: "dcs-studio.toml parses" },
    {
      level: "error",
      label: "Bundle sources",
      detail: "2 paths are missing — build first",
      items: ["bin/mymod.dll", "Scripts/init.lua"],
    },
    { level: "error", label: "7-Zip", detail: "7z.exe not found" },
  ];

  const INIT = {
    "": {
      type: "init",
      checks: OK_CHECKS,
      repo: null,
      defaults: { name: "my-cool-mod", description: "A cool DCS mod", version: "1.2.0" },
    },
    blocked: {
      type: "init",
      checks: BLOCKED_CHECKS,
      repo: null,
      defaults: { name: "my-cool-mod", description: "A cool DCS mod", version: "1.2.0" },
    },
    shared: {
      type: "init",
      checks: OK_CHECKS,
      repo: { owner: "flying-dice", name: "my-cool-mod" },
      defaults: { name: "my-cool-mod", description: "A cool DCS mod", version: "1.2.0" },
    },
    bare: {
      type: "init",
      checks: [],
      repo: null,
      defaults: { name: "", description: "", version: "" },
    },
  };

  window.__FIXTURE__ = { init: INIT[scenario] || INIT[""] };

  window.__host.onPost((m) => {
    if (!m) return;
    if (m.type === "refresh") {
      // "nofolder-late" withholds the reply on purpose — the test drives the
      // late `nofolder` push itself via hostSend, to prove the panel does not
      // stay stuck on its empty initial `<div id="app">` forever.
      if (scenario === "nofolder-late") return;
      window.__host.receive(
        scenario === "nofolder" ? { type: "nofolder" } : window.__FIXTURE__.init,
      );
      return;
    }
    if (m.type === "share") {
      window.__host.receive({ type: "busy", scope: "share", busy: true });
      window.__host.receive({ type: "log", line: `→ creating repo ${m.opts.name}` });
      window.__host.receive({
        type: "shareDone",
        result: { owner: "flying-dice", name: m.opts.name },
      });
      window.__host.receive({ type: "busy", scope: "share", busy: false });
      return;
    }
    if (m.type === "release") {
      window.__host.receive({ type: "busy", scope: "release", busy: true });
      window.__host.receive({ type: "log", line: `→ packaging ${m.opts.tag}` });
      window.__host.receive({
        type: "releaseDone",
        result: {
          url: `https://github.com/${m.opts.owner}/${m.opts.name}/releases/tag/${m.opts.tag}`,
          assets: ["mymod.7z.001", "mymod.7z.002", "dcs-studio.toml"],
        },
      });
      window.__host.receive({ type: "busy", scope: "release", busy: false });
      return;
    }
    window.__toast(`&rarr; posts <b>${m.type}</b>`);
  });
})();
