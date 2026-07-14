// Fixture for previews/skills.html. media/skills.js posts {type:"refresh"}
// synchronously at load and expects a {type:"skills", skills, installDir,
// hasWorkspace} reply — one card per status so every variant is visible by
// default. Tests that need other shapes (hasWorkspace:false, empty list)
// push a fresh {type:"skills", ...} message directly via hostSend().
(function () {
  window.__FIXTURE__ = {
    skills: {
      type: "skills",
      installDir: ".claude/skills",
      hasWorkspace: true,
      skills: [
        { id: "dcs-studio", name: "dcs-studio", description: "How to build, run, debug and publish DCS World mods in a DCS Studio project — manifest format, install roots, mission vs GUI scripting environments, the live bridge console, the Lua debugger, and the publish flow.", bundledVersion: "1.0.0", status: "not-installed" },
        { id: "dcs-studio-2", name: "dcs-studio (outdated)", description: "Same skill shown with an older installed copy — the update path.", bundledVersion: "1.2.0", installedVersion: "1.0.0", status: "outdated" },
        { id: "dcs-studio-3", name: "dcs-studio (current)", description: "Installed and matching the bundled version.", bundledVersion: "1.0.0", installedVersion: "1.0.0", status: "up-to-date" },
        { id: "dcs-studio-4", name: "dcs-studio (edited)", description: "Installed at the same version but with local edits.", bundledVersion: "1.0.0", installedVersion: "1.0.0", status: "modified" },
      ],
    },
  };

  window.__host.onPost((m) => {
    if (!m) return;
    if (m.type === "refresh") {
      window.__host.receive(window.__FIXTURE__.skills);
      return;
    }
    window.__toast(`&rarr; posts <b>${m.type}</b> for skill <b>${m.id || "?"}</b>`);
  });
})();
