// Fixture for previews/setup.html. media/setup.js renders an empty form at load
// and posts nothing — SetupPanel pushes {type:"init"} unprompted from its
// constructor (src/setup/panel.ts#pushInit), so this fixture does the same on
// DOMContentLoaded (which fires after setup.js has attached its listener).
//
// `?scenario=none` sends a bare {type:"init"} with every field absent — the
// real shape on a machine where nothing is detected and no setting is set.
// That's the state first-run users land in, and it's what every `|| ""` /
// `|| []` fallback in the panel exists for.
//
// Browse and Save are answered the way the host answers them: `browse`
// resolves to a scripted pick, `save` acknowledges with {type:"saved"}.
(() => {
  const scenario = new URLSearchParams(location.search).get("scenario") || "";

  // Deliberately mixed validity: a green candidate and a red one, so the pill
  // and the status line have both variants to render.
  const SAVED_CANDIDATES = [
    { path: "C:\\Users\\pilot\\Saved Games\\DCS", name: "DCS", valid: true, detail: "has Config" },
    {
      path: "C:\\Users\\pilot\\Saved Games\\DCS.openbeta",
      name: "DCS.openbeta",
      valid: false,
      detail: "no Config yet — run DCS once",
    },
  ];
  const INSTALL_CANDIDATES = [
    {
      path: "C:\\Program Files\\Eagle Dynamics\\DCS World",
      name: "DCS World",
      valid: true,
      detail: "has bin\\DCS.exe",
    },
    {
      path: "D:\\Games\\DCS World OpenBeta",
      name: "DCS World OpenBeta",
      valid: false,
      detail: "no bin\\DCS.exe",
    },
  ];

  // savedGames intentionally differs in case from the candidate it matches:
  // Windows paths are case-insensitive, and the panel's selected/validity
  // matching has to agree with that or a detected folder reads as un-picked.
  const FULL = {
    type: "init",
    savedGames: "c:\\users\\pilot\\saved games\\dcs",
    gameInstall: "",
    dataDir: "",
    dataDirDefault: "C:\\Users\\pilot\\DCSStudio\\mods",
    sevenZip: "",
    sevenZipDetected: "C:\\Program Files\\7-Zip\\7z.exe",
    savedCandidates: SAVED_CANDIDATES,
    installCandidates: INSTALL_CANDIDATES,
  };

  window.__FIXTURE__ = { init: scenario === "none" ? { type: "init" } : FULL };

  const BROWSED = {
    saved: "E:\\Saved Games\\DCS",
    install: "E:\\Games\\DCS World",
    data: "E:\\DCSStudio\\mods",
    sevenzip: "E:\\Tools\\7-Zip\\7z.exe",
  };

  window.__host.onPost((m) => {
    if (!m) return;
    if (m.type === "redetect") {
      window.__host.receive(window.__FIXTURE__.init);
      return;
    }
    if (m.type === "browse") {
      // `valid` is the host's probe of the role's witness path, and the panel
      // now renders the pill off it (card 23). The install pick is deliberately
      // invalid so browsing shows the warning variant too.
      window.__host.receive({
        type: "browsed",
        which: m.which,
        path: BROWSED[m.which],
        valid: m.which !== "install",
      });
      return;
    }
    if (m.type === "save") {
      window.__host.receive({ type: "saved" });
      return;
    }
    window.__toast(`&rarr; posts <b>${m.type}</b>`);
  });

  document.addEventListener("DOMContentLoaded", () => {
    window.__host.receive(window.__FIXTURE__.init);
  });
})();
