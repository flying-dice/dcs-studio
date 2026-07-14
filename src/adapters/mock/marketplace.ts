import type { MarketplacePort } from "../../core/ports/marketplace";
import type { MarketListing, ProductDetail } from "../../core/domain/types";

// Mock adapter for `MarketplacePort` — sample Marketplace data for the
// consumer-UX preview, previously src/marketplace/mockData.ts. The shapes are
// the core domain contracts (MarketListing feeds the storefront grid,
// ProductDetail feeds the product page); in dcs-studio these come from a
// headless Rust sidecar over JSON-RPC. This adapter is static so the
// mod-consumer experience runs with no DCS install and no network — and proves
// the marketplace backend swaps behind the port with one composition-root line.

const KB = 1024;
const MB = 1024 * 1024;

function avatar(seed: string): string {
  // GitHub identicon-style avatar; falls back to an inline SVG in the webview if
  // the network is unavailable.
  return `https://avatars.githubusercontent.com/${seed}?s=96`;
}

/** A plausible release-asset download URL for a mock repo. */
function assetUrl(repo: string, tag: string, name: string): string {
  return `https://github.com/${repo}/releases/download/${tag}/${name}`;
}

export const LISTINGS: MarketListing[] = [
  {
    repo: "viper-drivers/f16-weapons-expansion",
    name: "F-16C Weapons Expansion",
    author: "viper-drivers",
    description:
      "Adds JSOW-C1, GBU-53/B StormBreaker and an expanded HARM tables loadout to the Viper. Ships a rearm-menu integration script.",
    labels: ["script", "weapons", "aircraft"],
    repo_url: "https://github.com/viper-drivers/f16-weapons-expansion",
    avatar_url: avatar("u/9919"),
    stars: 342,
  },
  {
    repo: "syria-collective/syria-4k-textures",
    name: "Syria 4K Terrain Textures",
    author: "syria-collective",
    description:
      "High-resolution ground textures for the Syria map — reworked farmland, urban tiling and coastline detail. Big download, big payoff.",
    labels: ["texture", "terrain"],
    repo_url: "https://github.com/syria-collective/syria-4k-textures",
    avatar_url: avatar("u/1024"),
    stars: 512,
  },
  {
    repo: "hoggit-liveries/usaf-aggressors",
    name: "USAF Aggressor Liveries Pack",
    author: "hoggit-liveries",
    description:
      "16 accurate Aggressor schemes (Flanker, Splinter, Ghost) for the F-16C and F-15E, with roughmet maps.",
    labels: ["livery", "aircraft"],
    repo_url: "https://github.com/hoggit-liveries/usaf-aggressors",
    avatar_url: avatar("u/2048"),
    stars: 289,
  },
  {
    repo: "dcs-scripting/moose-lite",
    name: "MOOSE Lite",
    author: "dcs-scripting",
    description:
      "A trimmed MOOSE toolkit for mission scripting — spawning, zones and scheduling without the full framework weight.",
    labels: ["script", "framework"],
    repo_url: "https://github.com/dcs-scripting/moose-lite",
    avatar_url: avatar("u/3072"),
    stars: 1203,
  },
  {
    repo: "kneeboard-lab/dynamic-kneeboards",
    name: "Dynamic Kneeboards",
    author: "kneeboard-lab",
    description:
      "Generates per-flight kneeboard pages (comms ladder, bullseye, weather) at mission start from the briefing data.",
    labels: ["kneeboard", "script"],
    repo_url: "https://github.com/kneeboard-lab/dynamic-kneeboards",
    avatar_url: avatar("u/4096"),
    stars: 176,
  },
  {
    repo: "carrier-ops/supercarrier-plus",
    name: "Supercarrier Plus",
    author: "carrier-ops",
    description:
      "Deck crew callouts, case I/II/III recovery marshal automation and an LSO grade log for the Supercarrier module.",
    labels: ["mission", "script", "naval"],
    repo_url: "https://github.com/carrier-ops/supercarrier-plus",
    avatar_url: avatar("u/5120"),
    stars: 431,
  },
  {
    repo: "sound-mods/immersive-cockpit-audio",
    name: "Immersive Cockpit Audio",
    author: "sound-mods",
    description:
      "Re-sampled switch, relay and hydraulic sounds for the Hornet and Viper pits. Drop-in sound folder, no scripting.",
    labels: ["sound"],
    repo_url: "https://github.com/sound-mods/immersive-cockpit-audio",
    avatar_url: avatar("u/6144"),
    stars: 98,
  },
  {
    repo: "mission-makers/operation-eastern-storm",
    name: "Operation Eastern Storm",
    author: "mission-makers",
    description:
      "A 12-mission dynamic campaign over Syria for the F/A-18C. Persistent frontline, randomized threats and a branching storyline.",
    labels: ["campaign", "mission"],
    repo_url: "https://github.com/mission-makers/operation-eastern-storm",
    avatar_url: avatar("u/7168"),
    stars: 254,
  },
  {
    repo: "utils/dcs-lua-common",
    name: "dcs-lua-common",
    author: "utils",
    description: "Shared Lua helpers (vec math, table utils, logging) for mission scripting.",
    labels: ["script"],
    repo_url: "https://github.com/utils/dcs-lua-common",
    avatar_url: avatar("u/8192"),
    stars: 67,
  },
  {
    repo: "weather-systems/real-weather-injector",
    name: "Real Weather Injector",
    author: "weather-systems",
    description:
      "Pulls live METAR at mission start and sets DCS weather, wind layers and QNH to match a chosen real-world airfield.",
    labels: ["weather", "script"],
    repo_url: "https://github.com/weather-systems/real-weather-injector",
    avatar_url: avatar("u/9216"),
    stars: 388,
  },
  {
    repo: "viper-drivers/hud-color-tweaks",
    name: "HUD Color Tweaks",
    author: "viper-drivers",
    description:
      "Adjustable HUD and MFD phosphor colors for the F-16C. Simple texture swap with a few presets.",
    labels: ["texture", "aircraft"],
    repo_url: "https://github.com/viper-drivers/hud-color-tweaks",
    avatar_url: avatar("u/10240"),
    stars: 143,
  },
  {
    repo: "training/bfm-trainer",
    name: "BFM Trainer",
    author: "training",
    description:
      "An adaptive dogfight trainer: the AI adversary scales its aggression to your last three engagements and logs your Ps.",
    labels: ["mission", "training", "script"],
    repo_url: "https://github.com/training/bfm-trainer",
    avatar_url: avatar("u/11264"),
    stars: 201,
  },
];

// Hand-authored product pages for a few mods. Any listing without an explicit
// entry gets a synthesized page so every card is browsable.
export const PRODUCTS: Record<string, ProductDetail> = {
  "viper-drivers/f16-weapons-expansion": {
    repo: "viper-drivers/f16-weapons-expansion",
    name: "F-16C Weapons Expansion",
    author: "viper-drivers",
    description:
      "Adds JSOW-C1, GBU-53/B StormBreaker and an expanded HARM tables loadout to the Viper.",
    repo_url: "https://github.com/viper-drivers/f16-weapons-expansion",
    avatar_url: avatar("u/9919"),
    stars: 342,
    release_tag: "v2.3.1",
    release_url: "https://github.com/viper-drivers/f16-weapons-expansion/releases/tag/v2.3.1",
    release_date: "2026-06-01T00:00:00Z",
    readme: `# F-16C Weapons Expansion

Extra air-to-ground stores for the DCS **F-16C Viper**, wired into the rearm
menu so you can load them from the ground crew.

## What you get

- **AGM-154C JSOW-C1** — moving-target capable glide bomb
- **GBU-53/B StormBreaker** — 40nm standoff, tri-mode seeker
- Expanded **HARM** threat tables (updated emitter list)
- A rearm-menu integration script (no mission editing required)

## How it works

The mod links a Lua script into your Saved Games \`Scripts\` folder and a small
loadout definition into the aircraft's mod tree. On mission start it registers
the new pylons:

\`\`\`lua
local wx = require("weapons_expansion")
wx.register({ jsow = true, stormbreaker = true })
\`\`\`

## Notes

Multiplayer: all clients need the mod installed for the loadouts to sync.
`,
    assets: [
      {
        name: "f16-weapons-expansion-v2.3.1.zip",
        size: 4.2 * MB,
        url: assetUrl("viper-drivers/f16-weapons-expansion", "v2.3.1", "f16-weapons-expansion-v2.3.1.zip"),
      },
      {
        name: "dcs-studio.toml",
        size: 1.1 * KB,
        url: assetUrl("viper-drivers/f16-weapons-expansion", "v2.3.1", "dcs-studio.toml"),
      },
    ],
    download_size: 4.2 * MB,
    installable: true,
    installs: [
      { source: "Scripts/WeaponsExpansion", dest: "Saved Games/DCS/Scripts/WeaponsExpansion" },
      { source: "Mods/tech/F16Weapons", dest: "Saved Games/DCS/Mods/tech/F16Weapons" },
    ],
    requires: [{ id: "ed/f16c", name: "F-16C Viper", installed: true }],
  },
  "dcs-scripting/moose-lite": {
    repo: "dcs-scripting/moose-lite",
    name: "MOOSE Lite",
    author: "dcs-scripting",
    description: "A trimmed MOOSE core for mission scripting.",
    repo_url: "https://github.com/dcs-scripting/moose-lite",
    avatar_url: avatar("u/3072"),
    stars: 1203,
    release_tag: "v0.9.0",
    release_url: "https://github.com/dcs-scripting/moose-lite/releases/tag/v0.9.0",
    release_date: "2026-06-01T00:00:00Z",
    readme: `# MOOSE Lite

A trimmed MOOSE core for mission scripting — spawning, zones and scheduling
without the full framework weight. Drop it into your Saved Games \`Scripts\`
folder and \`require\` the pieces you need.

## Modules

- \`Spawn\` — group spawning with schedules
- \`Zone\` — trigger/polygon zones
- \`Scheduler\` — frame-accurate timers

## Usage

\`\`\`lua
local Spawn = require("moose_lite.spawn")
Spawn.new("Red CAP"):Schedule(300)
\`\`\`
`,
    assets: [
      {
        name: "moose-lite-v0.9.0.zip",
        size: 0.6 * MB,
        url: assetUrl("dcs-scripting/moose-lite", "v0.9.0", "moose-lite-v0.9.0.zip"),
      },
      {
        name: "dcs-studio.toml",
        size: 0.6 * KB,
        url: assetUrl("dcs-scripting/moose-lite", "v0.9.0", "dcs-studio.toml"),
      },
    ],
    download_size: 0.6 * MB,
    installable: true,
    installs: [{ source: "Scripts/MooseLite", dest: "Saved Games/DCS/Scripts/MooseLite" }],
    requires: [],
  },
  "mission-makers/operation-eastern-storm": {
    repo: "mission-makers/operation-eastern-storm",
    name: "Operation Eastern Storm",
    author: "mission-makers",
    description: "A 12-mission dynamic campaign over Syria for the F/A-18C.",
    repo_url: "https://github.com/mission-makers/operation-eastern-storm",
    avatar_url: avatar("u/7168"),
    stars: 254,
    release_tag: "1.4.0",
    release_url: "https://github.com/mission-makers/operation-eastern-storm/releases/tag/1.4.0",
    release_date: "2026-06-01T00:00:00Z",
    readme: `# Operation Eastern Storm

A branching 12-mission campaign for the **F/A-18C Hornet** over the Syria map.

- Persistent frontline that moves with your success
- Randomized SAM and CAP placement each replay
- Voiced briefings and a running intel picture

Install, then find it under **Campaigns** in the DCS main menu.
`,
    assets: [
      {
        name: "operation-eastern-storm-1.4.0.zip",
        size: 128 * MB,
        url: assetUrl("mission-makers/operation-eastern-storm", "1.4.0", "operation-eastern-storm-1.4.0.zip"),
      },
      {
        name: "dcs-studio.toml",
        size: 0.9 * KB,
        url: assetUrl("mission-makers/operation-eastern-storm", "1.4.0", "dcs-studio.toml"),
      },
    ],
    download_size: 128 * MB,
    installable: true,
    installs: [
      { source: "Campaigns/EasternStorm", dest: "Saved Games/DCS/Missions/Campaigns/EasternStorm" },
    ],
    requires: [
      { id: "ed/syria", name: "Syria Map", installed: false },
      { id: "ed/fa18c", name: "F/A-18C Hornet", installed: true },
    ],
  },
  "syria-collective/syria-4k-textures": {
    repo: "syria-collective/syria-4k-textures",
    name: "Syria 4K Terrain Textures",
    author: "syria-collective",
    description: "High-resolution ground textures for the Syria map.",
    repo_url: "https://github.com/syria-collective/syria-4k-textures",
    avatar_url: avatar("u/1024"),
    stars: 512,
    release_tag: "2026.02",
    release_url: "https://github.com/syria-collective/syria-4k-textures/releases/tag/2026.02",
    release_date: "2026-06-01T00:00:00Z",
    readme: `# Syria 4K Terrain Textures

Reworked ground textures for the **Syria** map. Sharper farmland tiling, richer
urban detail and reworked coastlines.

> This is a large download (~1.8 GB unpacked). Make sure you have the Syria map
> installed before applying.

## Performance

4K textures increase VRAM use. If you're on 8 GB, try the 2K variant in the
releases page instead.
`,
    assets: [
      {
        name: "syria-4k-2026.02.zip",
        size: 1.8 * 1024 * MB,
        url: assetUrl("syria-collective/syria-4k-textures", "2026.02", "syria-4k-2026.02.zip"),
      },
      {
        name: "dcs-studio.toml",
        size: 0.7 * KB,
        url: assetUrl("syria-collective/syria-4k-textures", "2026.02", "dcs-studio.toml"),
      },
    ],
    download_size: 1.8 * 1024 * MB,
    installable: true,
    installs: [
      { source: "Textures/Syria4K", dest: "Saved Games/DCS/Mods/terrains/Syria/Textures" },
    ],
    requires: [{ id: "ed/syria", name: "Syria Map", installed: false }],
  },
};

// Every marketplace backend advertises download_size as the sum of its release
// assets (the GitHub adapter computes it the same way) — keep the mock honest.
for (const p of Object.values(PRODUCTS)) {
  p.download_size = p.assets.reduce((s, a) => s + a.size, 0);
}

/** Synthesize a browsable product page for a listing without an authored one. */
function synthesize(listing: MarketListing): ProductDetail {
  return {
    repo: listing.repo,
    name: listing.name,
    author: listing.author,
    description: listing.description,
    repo_url: listing.repo_url,
    avatar_url: listing.avatar_url,
    stars: listing.stars,
    readme: `# ${listing.name}\n\n${listing.description}\n`,
    release_tag: null,
    release_url: null,
    release_date: null,
    assets: [],
    download_size: 0,
    installable: false,
    installs: [],
    requires: [],
  };
}

/** `MarketplacePort` over the static sample catalog — no network, no auth. */
export class MockMarketplace implements MarketplacePort {
  async discover(_topic: string): Promise<MarketListing[]> {
    return LISTINGS;
  }

  async loadProduct(repo: string): Promise<ProductDetail> {
    const authored = PRODUCTS[repo];
    if (authored) return authored;
    const listing = LISTINGS.find((l) => l.repo === repo);
    // Mirrors the GitHub adapter's not-found message shape.
    if (!listing) throw new Error(`Repository ${repo} was not found.`);
    return synthesize(listing);
  }
}
