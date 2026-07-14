// Fixture for previews/marketplace.html. Ports the __PREVIEW__ data blob +
// fake-host reply logic from the old preview.html, upgraded to simulate the
// real install/uninstall lifecycle media/marketplace.js now drives
// (installProgress -> installed / uninstalled), so marketplace.spec.ts can
// exercise it without a live GitHub API or 7-Zip.
//
// Canonical shape: this data mirrors the {listings, product} messages the
// real extension host sends (see src/marketplace's GitHub-backed producers) —
// it is a hand-authored stand-in, not generated from source, so the two can
// drift; keep it roughly in sync when the host's message shape changes.
// avatar_urls point at ../media/icon.png (not github.com) so the suite runs
// fully offline with no network 404s in the console.
(function () {
  const ICON = "../media/icon.png";

  const listings = [
    { repo: "viper-drivers/f16-weapons-expansion", name: "F-16C Weapons Expansion", author: "viper-drivers", description: "Adds JSOW-C1, GBU-53/B StormBreaker and an expanded HARM tables loadout to the Viper. Ships a rearm-menu integration script.", labels: ["script", "weapons", "aircraft"], repo_url: "https://github.com/viper-drivers/f16-weapons-expansion", avatar_url: ICON, stars: 342 },
    { repo: "syria-collective/syria-4k-textures", name: "Syria 4K Terrain Textures", author: "syria-collective", description: "High-resolution ground textures for the Syria map — reworked farmland, urban tiling and coastline detail. Big download, big payoff.", labels: ["texture", "terrain"], repo_url: "https://github.com/syria-collective/syria-4k-textures", avatar_url: ICON, stars: 512 },
    { repo: "hoggit-liveries/usaf-aggressors", name: "USAF Aggressor Liveries Pack", author: "hoggit-liveries", description: "16 accurate Aggressor schemes (Flanker, Splinter, Ghost) for the F-16C and F-15E, with roughmet maps.", labels: ["livery", "aircraft"], repo_url: "https://github.com/hoggit-liveries/usaf-aggressors", avatar_url: ICON, stars: 289 },
    { repo: "dcs-scripting/moose-lite", name: "MOOSE Lite", author: "dcs-scripting", description: "A trimmed MOOSE toolkit for mission scripting — spawning, zones and scheduling without the full framework weight.", labels: ["script", "framework"], repo_url: "https://github.com/dcs-scripting/moose-lite", avatar_url: ICON, stars: 1203 },
    { repo: "kneeboard-lab/dynamic-kneeboards", name: "Dynamic Kneeboards", author: "kneeboard-lab", description: "Generates per-flight kneeboard pages (comms ladder, bullseye, weather) at mission start from the briefing data.", labels: ["kneeboard", "script"], repo_url: "https://github.com/kneeboard-lab/dynamic-kneeboards", avatar_url: ICON, stars: 176 },
    { repo: "carrier-ops/supercarrier-plus", name: "Supercarrier Plus", author: "carrier-ops", description: "Deck crew callouts, case I/II/III recovery marshal automation and an LSO grade log for the Supercarrier module.", labels: ["mission", "script", "naval"], repo_url: "https://github.com/carrier-ops/supercarrier-plus", avatar_url: ICON, stars: 431 },
    { repo: "sound-mods/immersive-cockpit-audio", name: "Immersive Cockpit Audio", author: "sound-mods", description: "Re-sampled switch, relay and hydraulic sounds for the Hornet and Viper pits. Drop-in sound folder, no scripting.", labels: ["sound"], repo_url: "https://github.com/sound-mods/immersive-cockpit-audio", avatar_url: ICON, stars: 98 },
    { repo: "mission-makers/operation-eastern-storm", name: "Operation Eastern Storm", author: "mission-makers", description: "A 12-mission dynamic campaign over Syria for the F/A-18C. Persistent frontline, randomized threats and a branching storyline.", labels: ["campaign", "mission"], repo_url: "https://github.com/mission-makers/operation-eastern-storm", avatar_url: ICON, stars: 254 },
    { repo: "utils/dcs-lua-common", name: "dcs-lua-common", author: "utils", description: "Shared Lua helpers (vec math, table utils, logging) for mission scripting.", labels: ["script"], repo_url: "https://github.com/utils/dcs-lua-common", avatar_url: ICON, stars: 67 },
    { repo: "weather-systems/real-weather-injector", name: "Real Weather Injector", author: "weather-systems", description: "Pulls live METAR at mission start and sets DCS weather, wind layers and QNH to match a chosen real-world airfield.", labels: ["weather", "script"], repo_url: "https://github.com/weather-systems/real-weather-injector", avatar_url: ICON, stars: 388 },
    { repo: "viper-drivers/hud-color-tweaks", name: "HUD Color Tweaks", author: "viper-drivers", description: "Adjustable HUD and MFD phosphor colors for the F-16C. Simple texture swap with a few presets.", labels: ["texture", "aircraft"], repo_url: "https://github.com/viper-drivers/hud-color-tweaks", avatar_url: ICON, stars: 143 },
    { repo: "training/bfm-trainer", name: "BFM Trainer", author: "training", description: "An adaptive dogfight trainer: the AI adversary scales its aggression to your last three engagements and logs your Ps.", labels: ["mission", "training", "script"], repo_url: "https://github.com/training/bfm-trainer", avatar_url: ICON, stars: 201 },
  ];

  const products = {
    "viper-drivers/f16-weapons-expansion": {
      repo: "viper-drivers/f16-weapons-expansion", name: "F-16C Weapons Expansion", author: "viper-drivers",
      description: "Adds JSOW-C1, GBU-53/B StormBreaker and an expanded HARM tables loadout to the Viper.",
      repo_url: "https://github.com/viper-drivers/f16-weapons-expansion", avatar_url: ICON, stars: 342,
      release_tag: "v2.3.1", release_url: "https://github.com/viper-drivers/f16-weapons-expansion/releases/tag/v2.3.1",
      release_date: new Date(Date.now() - 5 * 86400000).toISOString(),
      readme: "# F-16C Weapons Expansion\n\nExtra air-to-ground stores for the DCS **F-16C Viper**, wired into the rearm\nmenu so you can load them from the ground crew.\n\n## What you get\n\n- **AGM-154C JSOW-C1** — moving-target capable glide bomb\n- **GBU-53/B StormBreaker** — 40nm standoff, tri-mode seeker\n- Expanded **HARM** threat tables (updated emitter list)\n- A rearm-menu integration script (no mission editing required)\n",
      assets: [{ name: "f16-weapons-expansion-v2.3.1.zip", size: 4404019.2 }, { name: "dcs-studio.toml", size: 1126.4 }],
      download_size: 4404019.2, installable: true,
      installs: [{ source: "Scripts/WeaponsExpansion", dest: "Saved Games/DCS/Scripts/WeaponsExpansion" }, { source: "Mods/tech/F16Weapons", dest: "Saved Games/DCS/Mods/tech/F16Weapons" }],
      // A privileged mod: launches an exe AND injects a pre-sanitization script.
      entrypoints: [{ id: "rearm-daemon", name: "Rearm Daemon", exe: "Server/rearm.exe", args: ["--port", "9100"], cwd: "Server" }],
      missionScripts: [
        { name: "Rearm menu hook", purpose: "Adds stores to the ground-crew rearm menu", path: "Scripts/WeaponsExpansion/rearm.lua", run_on: "after-sanitize" },
        { name: "HARM table injector", purpose: "Patches emitter tables at load", path: "Scripts/WeaponsExpansion/harm.lua", run_on: "before-sanitize" },
      ],
      requires: [{ id: "ed/f16c", name: "F-16C Viper", installed: true }],
    },
    "dcs-scripting/moose-lite": {
      repo: "dcs-scripting/moose-lite", name: "MOOSE Lite", author: "dcs-scripting",
      description: "A trimmed MOOSE toolkit for mission scripting.",
      repo_url: "https://github.com/dcs-scripting/moose-lite", avatar_url: ICON, stars: 1203,
      release_tag: "v0.9.0", release_url: "https://github.com/dcs-scripting/moose-lite/releases/tag/v0.9.0",
      release_date: new Date(Date.now() - 120 * 86400000).toISOString(),
      readme: "# MOOSE Lite\n\nA trimmed MOOSE core for mission scripting — spawning, zones and scheduling\nwithout the full framework weight.\n",
      assets: [{ name: "moose-lite-v0.9.0.zip", size: 629145.6 }, { name: "dcs-studio.toml", size: 614.4 }],
      download_size: 629145.6, installable: true,
      installs: [{ source: "Scripts/MooseLite", dest: "Saved Games/DCS/Scripts/MooseLite" }],
      // Only a sandboxed (after-sanitize) mission script — no pre-sanitize risk.
      missionScripts: [{ name: "MOOSE loader", purpose: "Boots the framework at mission start", path: "Scripts/MooseLite/loader.lua", run_on: "after-sanitize" }],
      requires: [],
    },
    "sound-mods/immersive-cockpit-audio": {
      repo: "sound-mods/immersive-cockpit-audio", name: "Immersive Cockpit Audio", author: "sound-mods",
      description: "Re-sampled switch, relay and hydraulic sounds for the Hornet and Viper pits.",
      repo_url: "https://github.com/sound-mods/immersive-cockpit-audio", avatar_url: ICON, stars: 98,
      release_tag: "v1.1.0", release_url: "https://github.com/sound-mods/immersive-cockpit-audio/releases/tag/v1.1.0",
      release_date: new Date(Date.now() - 12 * 86400000).toISOString(),
      readme: "# Immersive Cockpit Audio\n\nDrop-in sound folder, no scripting.\n",
      assets: [{ name: "immersive-cockpit-audio-v1.1.0.zip", size: 88080384 }, { name: "dcs-studio.toml", size: 400 }],
      download_size: 88080384, installable: true,
      // Manifest asset present, but its contents can't be read — the marketplace
      // must show the explicit "install actions unknown" state, not a clean page.
      manifestUnknown: true,
      installs: [], requires: [],
    },
    "mission-makers/operation-eastern-storm": {
      repo: "mission-makers/operation-eastern-storm", name: "Operation Eastern Storm", author: "mission-makers",
      description: "A 12-mission dynamic campaign over Syria for the F/A-18C.",
      repo_url: "https://github.com/mission-makers/operation-eastern-storm", avatar_url: ICON, stars: 254,
      release_tag: "1.4.0", release_url: "https://github.com/mission-makers/operation-eastern-storm/releases/tag/1.4.0",
      readme: "# Operation Eastern Storm\n\nA branching 12-mission campaign for the **F/A-18C Hornet** over the Syria map.\n",
      assets: [{ name: "operation-eastern-storm-1.4.0.zip", size: 134217728 }, { name: "dcs-studio.toml", size: 921.6 }],
      download_size: 134217728, installable: true,
      installs: [{ source: "Campaigns/EasternStorm", dest: "Saved Games/DCS/Missions/Campaigns/EasternStorm" }],
      requires: [{ id: "ed/syria", name: "Syria Map", installed: false }, { id: "ed/fa18c", name: "F/A-18C Hornet", installed: true }],
    },
    "syria-collective/syria-4k-textures": {
      repo: "syria-collective/syria-4k-textures", name: "Syria 4K Terrain Textures", author: "syria-collective",
      description: "High-resolution ground textures for the Syria map.",
      repo_url: "https://github.com/syria-collective/syria-4k-textures", avatar_url: ICON, stars: 512,
      release_tag: "2026.02", release_url: "https://github.com/syria-collective/syria-4k-textures/releases/tag/2026.02",
      readme: "# Syria 4K Terrain Textures\n\nReworked ground textures for the **Syria** map.\n\n> This is a large download (~1.8 GB unpacked). Make sure you have the Syria map\n> installed before applying.\n",
      assets: [{ name: "syria-4k-2026.02.zip", size: 1932735283.2 }, { name: "dcs-studio.toml", size: 716.8 }],
      download_size: 1932735283.2, installable: true,
      installs: [{ source: "Textures/Syria4K", dest: "Saved Games/DCS/Mods/terrains/Syria/Textures" }],
      requires: [{ id: "ed/syria", name: "Syria Map", installed: false }],
    },
  };

  window.__FIXTURE__ = { listings, products };

  function reply(msg, delay) {
    setTimeout(() => window.__host.receive(msg), delay || 0);
  }

  function productFor(repo) {
    if (products[repo]) return products[repo];
    const l = listings.find((x) => x.repo === repo);
    return {
      repo: l.repo, name: l.name, author: l.author, description: l.description,
      repo_url: l.repo_url, avatar_url: l.avatar_url, stars: l.stars,
      readme: "# " + l.name + "\n\n" + l.description,
      release_tag: "v1.0.0", release_url: l.repo_url + "/releases",
      release_date: new Date(Date.now() - 40 * 86400000).toISOString(),
      assets: [{ name: l.name.replace(/\s+/g, "-").toLowerCase() + ".zip", size: 6291456 }, { name: "dcs-studio.toml", size: 900 }],
      download_size: 6292356,
      installable: true,
      installs: [], requires: [],
    };
  }

  // JS mirror of src/core/domain/installManifestView.ts — the host derives this
  // and posts it; the fixture reproduces the same shape so the webview renders
  // exactly what production would. (The derivation logic itself is unit-tested in
  // vitest; this stand-in only needs to match the output shape.)
  function deriveManifest(surface) {
    if (!surface) {
      return { known: false, bundles: [], symlinks: [], entrypoints: [], missionScripts: [], counts: { bundles: 0, symlinks: 0, entrypoints: 0, missionScripts: 0, beforeSanitize: 0 }, risks: [] };
    }
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

  function manifestFor(p) {
    if (p.manifestUnknown) return deriveManifest(null);
    return deriveManifest({
      bundles: (p.installs || []).map((r) => ({ path: r.source })),
      symlinks: (p.installs || []).map((r) => ({ source: r.source, dest: r.dest, resolved: r.dest })),
      entrypoints: p.entrypoints || [],
      missionScripts: p.missionScripts || [],
    });
  }

  function requiresFor(p) {
    return (p.requires || []).map((r) => ({ id: r.id }));
  }

  // repos the fixture currently considers "installed" — drives the
  // install/uninstall lifecycle across openProduct calls.
  const installed = new Set();

  window.__host.onPost((m) => {
    if (!m) return;
    switch (m.type) {
      case "ready":
        reply({ type: "auth", signedIn: false, browsing: false, topic: "dcs-studio" });
        break;
      case "signIn":
        reply({ type: "auth", signedIn: true, browsing: false, login: "you (preview)", topic: "dcs-studio" });
        reply({ type: "listings:busy" }, 10);
        reply({ type: "listings", listings }, 500);
        break;
      case "browseAnon":
        reply({ type: "auth", signedIn: false, browsing: true, topic: "dcs-studio" });
        reply({ type: "listings:busy" }, 10);
        reply({ type: "listings", listings }, 500);
        break;
      case "discover":
        reply({ type: "listings:busy" });
        reply({ type: "listings", listings }, 450);
        break;
      case "openProduct": {
        const repo = m.repo;
        reply({ type: "product:busy", repo });
        const product = productFor(repo);
        reply({ type: "product", product, manifest: manifestFor(product), requires: requiresFor(product), installed: installed.has(repo) }, 450);
        break;
      }
      case "openExternal":
        if (m.url) window.__toast("Opening " + m.url.replace(/^https?:\/\//, "") + " &hellip;");
        break;
      case "install": {
        const repo = m.repo;
        reply({ type: "installProgress", repo, phase: "download", label: "Downloading…", pct: 0.15 }, 50);
        reply({ type: "installProgress", repo, phase: "download", label: "Downloading…", pct: 0.7 }, 100);
        reply({ type: "installProgress", repo, phase: "link", label: "Linking into DCS…", pct: 1 }, 130);
        setTimeout(() => {
          installed.add(repo);
          window.__host.receive({ type: "installed", repo });
        }, 150);
        break;
      }
      case "uninstall": {
        const repo = m.repo;
        setTimeout(() => {
          installed.delete(repo);
          window.__host.receive({ type: "uninstalled", repo });
        }, 90);
        break;
      }
    }
  });
})();
