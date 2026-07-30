// Fixture for previews/newproject.html. media/newproject.js renders only once
// the host pushes {type:"init"}; NewProjectPanel does that unprompted from its
// constructor (src/project/newProjectPanel.ts#pushInit), so this fixture sends
// it on DOMContentLoaded — and the webview also posts {type:"ready"} at the
// bottom of its IIFE, which the host answers with the same push (card 24), so
// this fixture answers that too.
//
// `?scenario=` picks the shapes the panel has to tell apart:
//   (default)  no workspace folder — you must pick a location to create under
//   folder     a folder is already open, so "bootstrap in place" is the default
//   bare       {type:"init"} with nothing set — no templates, no last location
//   lostinit   the card 24 race: the unprompted DOMContentLoaded push is
//              WITHHELD, so the handshake's answer is the only `init` the form
//              ever gets — without it the page stays a blank <div id="app">.
//
// `create` is answered only for the reserved name "taken", which fails the way
// a real EEXIST does. Every other name goes UNANSWERED, and that is not a gap
// in the fixture — it is what success looks like on this protocol: the host
// posts nothing and closes the panel or reloads the window (card 25), so the
// Creating… latch staying latched is the whole of the webview's success state.
(() => {
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

  // `lostinit` is the default shape's payload; only its DELIVERY differs.
  window.__FIXTURE__ = { init: INIT[scenario] || INIT[""] };

  window.__host.onPost((m) => {
    if (!m) return;
    if (m.type === "ready") {
      window.__host.receive(window.__FIXTURE__.init);
      return;
    }
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
      }
      // No success reply exists to send.
      return;
    }
    window.__toast(`&rarr; posts <b>${m.type}</b>`);
  });

  document.addEventListener("DOMContentLoaded", () => {
    // Withheld under `lostinit`: that scenario is the load race, where the
    // constructor's push landed before the webview was listening.
    if (scenario !== "lostinit") window.__host.receive(window.__FIXTURE__.init);
  });
})();
