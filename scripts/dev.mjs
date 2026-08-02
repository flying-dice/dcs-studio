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
// Single command strings throughout: `npm`/`code`/`npx` are .cmd shims on
// Windows (so a shell is required), and spawning an args ARRAY through a shell
// is deprecated (DEP0190).
const compile = spawnSync("npm run compile", { cwd: root, stdio: "inherit", shell: true });
if (compile.status !== 0) {
  console.error("Initial compile failed — fix errors and re-run `npm run dev`.");
  process.exit(compile.status ?? 1);
}

console.log("› Launching Extension Development Host (this extension only)…");
// `shell: true` is needed on Windows — `code` is `code.cmd`, which spawn cannot
// exec directly — but it means this argv is re-parsed by the shell. The shipping
// target is Windows, where `C:\Users\First Last\…` and `…\OneDrive - Company\…`
// are normal, so an unquoted interpolation splits mid-path and the host opens
// the wrong folder or fails to launch with nothing that points at quoting.
// Double quotes are the one form both cmd.exe and sh honour.
spawn(`code --extensionDevelopmentPath="${root}" --disable-extensions --new-window "${sandbox}"`, {
  cwd: root,
  stdio: "inherit",
  shell: true,
});

console.log("› Watching for changes (edits rebuild out/ and the dev host auto-reloads)…");
// Also shelled out, but every argument here is a literal — `cwd` is handed to
// the OS directly rather than through the shell, so there is nothing to quote.
const watch = spawn("npx tsc -watch -p ./", {
  cwd: root,
  stdio: "inherit",
  shell: true,
});
watch.on("exit", (code) => process.exit(code ?? 0));
