import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The contract between package.json's contribution points and the composition
// root. VS Code resolves these two halves at runtime and never at build time,
// so a command declared but not registered surfaces as "command 'x' not found"
// the moment a user clicks it, and a menu entry pointing at a command that no
// longer exists is a dead button. Neither the compiler nor any other test in
// the suite can see across that seam.
//
// This is a static contract check rather than an activation test: it needs no
// VS Code instance, so it runs in the headless integration layer with
// everything else.

const root = resolve(__dirname, "../../..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** Every `registerCommand` id across the composition root and its helpers. */
function registeredCommandIds(): string[] {
  const sources = [
    "src/extension.ts",
    "src/debug/factory.ts",
    "src/bridge/deploy.ts",
    "src/bridge/launch.ts",
    "src/bridge/dbExport.ts",
    "src/mission/missionPanel.ts",
  ];
  const ids: string[] = [];
  for (const rel of sources) {
    const text = readFileSync(join(root, rel), "utf8");
    for (const m of text.matchAll(/registerCommand\(\s*["'`]([^"'`]+)["'`]/g)) ids.push(m[1]);
  }
  return ids;
}

const declared: string[] = (pkg.contributes.commands ?? []).map(
  (c: { command: string }) => c.command,
);
const registered = registeredCommandIds();

describe("command contribution contract", () => {
  it("declares commands and registers at least as many", () => {
    // Guards the guard: if the regex or the file list ever stops matching, the
    // rest of this suite would pass vacuously.
    expect(declared.length).toBeGreaterThan(0);
    expect(registered.length).toBeGreaterThanOrEqual(declared.length);
  });

  it("registers a handler for every command declared in package.json", () => {
    // A declared-but-unregistered command is visible in the palette and throws
    // when invoked.
    const missing = declared.filter((id) => !registered.includes(id));
    expect(missing, `declared in package.json but never registered: ${missing.join(", ")}`).toEqual(
      [],
    );
  });

  it("declares every command that a menu contribution points at", () => {
    // A menu entry referencing an undeclared command renders as a dead item.
    const menuIds = Object.values(
      (pkg.contributes.menus ?? {}) as Record<string, { command?: string }[]>,
    )
      .flat()
      .map((entry) => entry.command)
      .filter((id): id is string => !!id);
    const undeclared = [...new Set(menuIds)].filter((id) => !declared.includes(id));
    expect(undeclared, `menu entries for undeclared commands: ${undeclared.join(", ")}`).toEqual(
      [],
    );
  });

  it("registers no command id twice", () => {
    // Two registrations of the same id throw at activation, which disables the
    // whole extension rather than just that command.
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const id of registered) {
      if (seen.has(id)) duplicates.push(id);
      seen.add(id);
    }
    expect(duplicates).toEqual([]);
  });

  it("keeps every declared command under the extension's id namespace", () => {
    const stray = declared.filter((id) => !id.startsWith("dcs."));
    expect(stray, `commands outside the dcs.* namespace: ${stray.join(", ")}`).toEqual([]);
  });

  it("documents internal commands as those registered but not contributed", () => {
    // Registered-but-undeclared is legitimate for internal handlers (the status
    // bar click target), but it must stay a deliberate, enumerated list rather
    // than a place commands quietly accumulate outside the palette.
    const internal = registered.filter((id) => !declared.includes(id));
    expect(internal.sort()).toEqual(["dcs.bridge.statusBarClick"]);
  });
});

describe("configuration contribution contract", () => {
  const properties: Record<string, unknown> = pkg.contributes.configuration?.properties ?? {};

  it("namespaces every setting under dcsStudio", () => {
    const stray = Object.keys(properties).filter((key) => !key.startsWith("dcsStudio."));
    expect(stray).toEqual([]);
  });

  it("reads no configuration key that package.json does not declare", () => {
    // A `getConfiguration("dcsStudio").get("typo")` silently returns undefined
    // and the feature just never works, with nothing to debug.
    const sources = [
      "src/extension.ts",
      "src/marketplace/panel.ts",
      "src/adapters/vscode/installRoots.ts",
      "src/setup/panel.ts",
    ];
    const used = new Set<string>();
    for (const rel of sources) {
      const text = readFileSync(join(root, rel), "utf8");
      for (const m of text.matchAll(
        /getConfiguration\(\s*["'`]dcsStudio["'`]\s*\)\s*\.\s*get<[^>]*>\(\s*["'`]([^"'`]+)["'`]/g,
      )) {
        used.add(`dcsStudio.${m[1]}`);
      }
    }
    const undeclared = [...used].filter((key) => !(key in properties));
    expect(undeclared, `settings read but not declared: ${undeclared.join(", ")}`).toEqual([]);
  });
});
