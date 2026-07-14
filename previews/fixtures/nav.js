// Fixture for previews/nav.html. media/nav.js reads window.__LOGO__ at load
// (must be set before its <script> tag runs) and is otherwise a pure
// push target — it never posts a "refresh"; the host pushes {type:"status"},
// {type:"manifest"} and {type:"skills"} whenever it likes. nav.spec.ts drives
// all of that deterministically via hostSend(), so the only thing this
// fixture owns is the logo and a purely-cosmetic status-cycle demo for the
// human dev-loop preview — gated behind `!navigator.webdriver` so Playwright
// (which sets that flag) never races it.
window.__LOGO__ = "../media/icon.png";

(function () {
  window.__host.onPost((m) => {
    if (m && m.type === "run") window.__toast(`&rarr; runs command <b>${m.command}</b>`);
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
