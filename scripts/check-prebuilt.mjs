#!/usr/bin/env node
// Packaging gate for bridge/prebuilt/ — runs from `vscode:prepublish`, so every
// `vsce package` goes through it.
//
// The payload is gitignored and staged only by the release workflow's cargo
// build. Nothing else asserts it is there, and its absence is invisible at
// install time: the extension activates fine and fails at the point of use,
// when the user injects the bridge into DCS. Failing here turns a broken .vsix
// into a broken build.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const prebuilt = join(root, "bridge", "prebuilt");

const REQUIRED = ["dcs_studio_gui.dll", "dcs_studio_mission.dll", "lua.lib"];

const missing = REQUIRED.filter((name) => !existsSync(join(prebuilt, name)));

if (missing.length) {
  console.error(
    `\nbridge/prebuilt/ is missing ${missing.join(", ")}.\n\n` +
      "A .vsix without these installs and activates cleanly, then fails when the\n" +
      "user injects the bridge into DCS. Build and stage the payload first:\n\n" +
      "  cargo build --release --workspace   (in bridge/)\n" +
      "  copy bridge/target/release/dcs_studio_{gui,mission}.dll and\n" +
      "  bridge/lua5.1/lua.lib into bridge/prebuilt/\n\n" +
      "The release workflow does this for you — see .github/workflows/release.yml.\n",
  );
  process.exit(1);
}

console.log(`› bridge/prebuilt/ payload complete (${REQUIRED.join(", ")}).`);
