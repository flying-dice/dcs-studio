// Fixture for previews/newproject.html. media/newproject.js posts nothing at
// load and renders only once the host pushes {type:"init"}; NewProjectPanel
// does that from its constructor (src/project/newProjectPanel.ts#pushInit), so
// this fixture sends it on DOMContentLoaded.
//
// `?scenario=` picks the two shapes the panel has to tell apart:
//   (default)  no workspace folder — you must pick a location to create under
//   folder     a folder is already open, so "bootstrap in place" is the default
//   bare       {type:"init"} with nothing set — no templates, no last location
//
// `create` is answered only for two reserved names — "taken" fails the way a
// real EEXIST does, "done" succeeds — because the interesting default is the
// one where the host has NOT replied yet: scaffolding takes long enough that
// the panel's Creating… latch is what stops a second submit.
(function () {
  const scenario = new URLSearchParams(location.search).get("scenario") || "";

  // Mirrors src/core/domain/projectTemplates.ts#TEMPLATES. "mission" is kept
  // last on purpose: newproject.js has no icon for that id, so it exercises
  // the ICONS fallback that stops an unknown template rendering an empty chip.
  const TEMPLATES = [
    {
      id: "blank",
      label: "Blank Project",
      description: "Just a dcs-studio.toml manifest — bring your own structure.",
    },
    {
      id: "lua-mission",
      label: "Lua Mission Script",
      description: "Runs in the mission scripting environment — loaded by a mission trigger.",
    },
    {
      id: "lua-hook",
      label: "Lua GameGUI Hook",
      description: "Runs in the GUI environment — auto-loaded from Scripts/Hooks at DCS start.",
    },
    {
      id: "rust-dll",
      label: "Rust DLL Mod",
      description: "Native mod: cargo project building a DLL, bundled and symlinked into DCS.",
    },
    {
      id: "mission",
      label: "Share a Mission",
      description: "Package a .miz and link it into your DCS user Missions folder.",
    },
  ];

  const INIT = {
    "": {
      type: "init",
      templates: TEMPLATES,
      sep: "\\",
      folder: null,
      location: "C:\\Users\\pilot\\Projects",
      name: "",
    },
    folder: {
      type: "init",
      templates: TEMPLATES,
      sep: "\\",
      folder: "C:\\Users\\pilot\\Projects\\my-open-mod",
      location: "C:\\Users\\pilot\\Projects",
      name: "my-open-mod",
    },
    bare: { type: "init" },
  };

  window.__FIXTURE__ = { init: INIT[scenario] || INIT[""] };

  window.__host.onPost((m) => {
    if (!m) return;
    if (m.type === "browse") {
      window.__host.receive({ type: "browsed", path: "D:\\DCS Projects" });
      return;
    }
    if (m.type === "create") {
      if (m.name === "taken") {
        window.__host.receive({
          type: "error",
          message: `EEXIST: ${m.location}\\${m.name} already exists`,
        });
      } else if (m.name === "done") {
        window.__host.receive({ type: "created" });
      }
      return;
    }
    window.__toast(`&rarr; posts <b>${m.type}</b>`);
  });

  document.addEventListener("DOMContentLoaded", () => {
    window.__host.receive(window.__FIXTURE__.init);
  });
})();
