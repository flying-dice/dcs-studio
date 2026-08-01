#!/usr/bin/env node
// Clears the TypeScript output directory before `tsc` writes into it.
//
// `tsc` only ever ADDS to `outDir`. It has no notion of a file it emitted last
// time and should not emit now, so every source file that is renamed, moved or
// deleted leaves its compiled `.js` (and `.js.map`) behind forever. Those
// orphans are invisible locally — nothing imports them — but `.vscodeignore`
// excludes `src/**`, not `out/**`, so `vsce package` sweeps every one of them
// into the .vsix.
//
// That is not merely untidy. `out/adapters/mock/marketplace.js` was shipping to
// users: a MockMarketplace whose source ARCHITECTURE.md states cannot reach a
// packaged build. The claim was true of `src/`; the artefact directory had a
// longer memory. Deleted sources were also still shipping their old bodies
// under `out/adapters/vscode/notifier.js`, `out/core/ports/notifier.js`,
// `out/bridge/paths.js`, `out/install/dataDir.js`, `out/skills/manager.js` and
// `out/adapters/vscode/manifestPort.js`.
//
// A full wipe rather than a diff: the build is not incremental (no `composite`
// or `incremental` in tsconfig.json), so `tsc` rewrites every file regardless
// and there is nothing to preserve. Cheap, and it cannot leave a survivor.
//
// Takes the directory as an optional argument so the packaging test can drive
// it against a scratch directory instead of the real `out/`.
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const target = resolve(root, process.argv[2] ?? "out");

// `force` so a first-ever build (no `out/` yet) is not an error.
rmSync(target, { recursive: true, force: true });
