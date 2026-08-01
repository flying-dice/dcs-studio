import { readdirSync, readFileSync } from "node:fs";
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

/** Every `.ts` file under `src/`. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * Every `registerCommand` id in `src/`.
 *
 * This used to be a hardcoded list of six files, which quietly stopped being
 * true the moment the registrations moved out of `activate()` into
 * `src/bridge/commands.ts` — the scan found no `dcs.bridge.statusBarClick` and
 * concluded the command had been deleted. A list of files that has to be
 * updated by hand whenever code moves is a check that decays into a
 * false alarm at best and a blind spot at worst, so it walks the tree instead.
 */
function registeredCommandIds(): string[] {
  const ids: string[] = [];
  for (const file of sourceFiles(join(root, "src"))) {
    const text = readFileSync(file, "utf8");
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

  it("excludes MissionScripting.lua from every menu that offers a run/debug command", () => {
    // The handler refuses it outright (src/debug/factory.ts); these clauses are
    // what keeps it from being offered in the first place. The palette is the
    // one that was missed: a command with no commandPalette entry is listed
    // unconditionally, so the exclusion has to be declared there too.
    const menus = (pkg.contributes.menus ?? {}) as Record<
      string,
      { command?: string; when?: string }[]
    >;
    const runDebug = [
      "dcs.debug.runMission",
      "dcs.debug.debugMission",
      "dcs.debug.runGui",
      "dcs.debug.debugGui",
    ];
    const offered = Object.entries(menus).flatMap(([menu, entries]) =>
      entries
        .filter((e) => e.command && runDebug.includes(e.command))
        .map((e) => ({ menu, command: e.command, when: e.when ?? "" })),
    );
    // Guards the guard: every menu the four appear in, and the palette among them.
    expect([...new Set(offered.map((o) => o.menu))].sort()).toEqual([
      "commandPalette",
      "editor/context",
      "editor/title/run",
      "explorer/context",
    ]);
    const unguarded = offered.filter(
      (o) => !o.when.includes("resourceFilename != MissionScripting.lua"),
    );
    expect(unguarded, `offered for MissionScripting.lua: ${JSON.stringify(unguarded)}`).toEqual([]);
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

  // Every setting read anywhere under src/, derived rather than enumerated: a
  // hand-written file list is the classic step that silently stops covering
  // anything. This one had gone stale in both directions — it named a file with
  // no config read left in it, and missed four that had one.
  //
  // A file that mentions getConfiguration("dcsStudio") is treated as a config
  // reader, and every string it passes to `.get(` — typed or not, chained or
  // through a local — is treated as a key. That over-reads (a Map.get in the
  // same file would be picked up), which is the safe direction: a false key
  // fails this test loudly rather than letting a real one slip past.
  function readSettingKeys(): Set<string> {
    const used = new Set<string>();
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? walk(join(dir, e.name))
          : e.name.endsWith(".ts")
            ? [join(dir, e.name)]
            : [],
      );
    for (const file of walk(join(root, "src"))) {
      const text = readFileSync(file, "utf8");
      if (!text.includes('getConfiguration("dcsStudio")')) continue;
      for (const m of text.matchAll(/\.\s*get\s*(?:<[^>]*>)?\s*\(\s*["'`]([^"'`]+)["'`]/g)) {
        // globalState/workspaceState keys are namespaced with a dot and are not
        // settings; configuration keys are bare subkeys under dcsStudio.
        if (!m[1].includes(".")) used.add(`dcsStudio.${m[1]}`);
      }
    }
    return used;
  }

  const used = readSettingKeys();

  it("finds the settings reads it is meant to police", () => {
    // Guards the guard: if the scan ever stops matching, both assertions below
    // would pass vacuously.
    expect(used.size).toBeGreaterThanOrEqual(Object.keys(properties).length);
  });

  it("reads no configuration key that package.json does not declare", () => {
    // A `getConfiguration("dcsStudio").get("typo")` silently returns undefined
    // and the feature just never works, with nothing to debug.
    const undeclared = [...used].filter((key) => !(key in properties));
    expect(undeclared, `settings read but not declared: ${undeclared.join(", ")}`).toEqual([]);
  });

  it("declares no configuration key that nothing reads", () => {
    // The other direction: a setting that stopped being read stays in the
    // user's settings UI forever, doing nothing.
    const unread = Object.keys(properties).filter((key) => !used.has(key));
    expect(unread, `declared but never read: ${unread.join(", ")}`).toEqual([]);
  });
});
