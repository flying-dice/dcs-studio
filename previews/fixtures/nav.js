// Fixture for previews/nav.html. media/nav.js reads window.__LOGO__ at load
// (must be set before its <script> tag runs) and posts {type:"ready"} at the
// bottom of its IIFE, which the host answers with all three pushes —
// {type:"status"}, {type:"skills"} and {type:"manifest"} — the way
// NavPresenter.ready does. The host also volunteers those three whenever it
// likes, and nav.spec.ts drives THAT deterministically via hostSend().
//
// `?scenario=modproject` is the card 29 race: a workspace that IS a mod project
// whose unprompted opening pushes were lost, so the handshake answer is the only
// thing that reveals Publish Mod and the skills badge.
//
// The status-cycle demo at the bottom is purely cosmetic for the human dev-loop
// preview — gated behind `!navigator.webdriver` so Playwright (which sets that
// flag) never races it.
window.__LOGO__ = "../media/icon.png";

(() => {
  const modProject = new URLSearchParams(location.search).get("scenario") === "modproject";

  window.__host.onPost((m) => {
    if (!m) return;
    if (m.type === "run") {
      window.__toast(`&rarr; runs command <b>${m.command}</b>`);
      return;
    }
    if (m.type === "ready") {
      window.__host.receive({ type: "status", status: { connected: false, dcsTime: null } });
      window.__host.receive({ type: "skills", updates: modProject ? 1 : 0 });
      window.__host.receive({ type: "manifest", hasManifest: modProject });
    }
  });

  if (navigator.webdriver) return;

  const states = [
    { connected: false, dcsTime: null },
    { connected: true, dcsTime: 0 },
    { connected: true, dcsTime: 213 },
  ];
  let i = 0;
  setInterval(() => {
    i = (i + 1) % states.length;
    window.__host.receive({ type: "status", status: states[i] });
  }, 2200);
})();
