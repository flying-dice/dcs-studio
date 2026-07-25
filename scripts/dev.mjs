// One-command dev loop:
//   1. compile once,
//   2. open a clean VS Code Extension Development Host with ONLY this extension
//      (--disable-extensions) and a scratch workspace folder,
//   3. keep tsc -watch running so each edit rebuilds out/ — the extension's
//      dev auto-reload (src/devReload.ts) then reloads the host automatically.
//
// Usage: npm run dev
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = path.join(root, ".dev-sandbox");

// A scratch workspace so the sidebar nav / manifest form have a folder to work in.
mkdirSync(sandbox, { recursive: true });
if (!existsSync(path.join(sandbox, "README.md"))) {
  writeFileSync(
    path.join(sandbox, "README.md"),
    "# DCS Studio dev sandbox\n\nThis folder is the workspace for the Extension Development Host.\n",
  );
}

console.log("› Compiling once…");
const compile = spawnSync("npm", ["run", "compile"], { cwd: root, stdio: "inherit", shell: true });
if (compile.status !== 0) {
  console.error("Initial compile failed — fix errors and re-run `npm run dev`.");
  process.exit(compile.status ?? 1);
}

console.log("› Launching Extension Development Host (this extension only)…");
// TODO: clean-code - 0.5 - BOUNDARY (#57): `shell: true` means this argv is re-parsed
// by the shell, and neither interpolated path is quoted. The shipping target is
// Windows, where `C:\Users\First Last\…` and `…\OneDrive - Company\…` are
// normal — `npm run dev` there opens the wrong folder or fails to launch, with
// no error that points at quoting. `shell: true` is genuinely needed (`code` is
// `code.cmd`), so quote the two interpolations rather than dropping it.
spawn(
  "code",
  [`--extensionDevelopmentPath=${root}`, "--disable-extensions", "--new-window", sandbox],
  { cwd: root, stdio: "inherit", shell: true },
);

console.log("› Watching for changes (edits rebuild out/ and the dev host auto-reloads)…");
const watch = spawn("npx", ["tsc", "-watch", "-p", "./"], {
  cwd: root,
  stdio: "inherit",
  shell: true,
});
watch.on("exit", (code) => process.exit(code ?? 0));
