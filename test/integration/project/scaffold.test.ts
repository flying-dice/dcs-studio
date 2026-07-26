import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetVscode, seededText, seedFile, state, vscodeMock } from "../support/vscode";

vi.mock("vscode", () => vscodeMock());

import * as vscode from "vscode";
import {
  loadTemplateAssets,
  scaffoldInPlace,
  scaffoldNewFolder,
} from "../../../src/project/scaffold";

// The scaffolder writes a whole project tree in one go. Two things about it are
// unrecoverable if they go wrong: writing outside the folder the user picked,
// and overwriting files that were already there. The template content and the
// planning rules are pure and covered in core/domain; these tests cover the
// adapter that probes the disk and executes — that it refuses the targets it
// should, and that what lands on disk is what was rendered.

const EXT = "C:\\ext";
const PARENT = "C:\\Projects";
const LUA_LIB = new Uint8Array([0x4c, 0x49, 0x42, 0x00]);

const extensionUri = () => vscode.Uri.file(EXT);

const newFolder = (template: string, name: string, parent = PARENT) =>
  scaffoldNewFolder(extensionUri(), template, name, parent);

beforeEach(() => {
  resetVscode();
  seedFile(`${EXT}\\bridge\\prebuilt\\lua.lib`, LUA_LIB);
});

describe("the bundled template assets", () => {
  it("uses the lua import library the VSIX packages", async () => {
    expect(await loadTemplateAssets(extensionUri())).toEqual({ luaLib: LUA_LIB });
  });

  it("falls back to the build input when running from source", async () => {
    // bridge/lua5.1 is excluded from the package, so a checkout has only that
    // copy — without the fallback the Rust template cannot be scaffolded at all
    // when the extension runs out of a clone.
    resetVscode();
    const fromSource = new Uint8Array([9, 9]);
    seedFile(`${EXT}\\bridge\\lua5.1\\lua.lib`, fromSource);
    expect(await loadTemplateAssets(extensionUri())).toEqual({ luaLib: fromSource });
  });
});

describe("scaffolding into a new folder", () => {
  it("writes every rendered file under <parent>\\<name>", async () => {
    const result = await newFolder("lua-mission", "My Mod");

    expect(result).toEqual({ root: `${PARENT}\\My Mod`, skipped: [] });
    expect(seededText(`${PARENT}\\My Mod\\dcs-studio.toml`)).toContain('name = "My Mod"');
    // Nested template paths become real subdirectories, not a literal
    // "Scripts/my-mod.lua" filename.
    expect(seededText(`${PARENT}\\My Mod\\Scripts\\my-mod.lua`)).toContain("DCS Studio");
    expect(seededText(`${PARENT}\\My Mod\\README.md`)).toContain("# My Mod");
  });

  it("creates each file's directory before writing it", async () => {
    await newFolder("lua-mission", "my-mod");
    const scriptDir = state.fsOps.findIndex(
      (op) => op.op === "createDirectory" && op.uri === `${PARENT}\\my-mod\\Scripts`,
    );
    const script = state.fsOps.findIndex(
      (op) => op.op === "writeFile" && op.uri === `${PARENT}\\my-mod\\Scripts\\my-mod.lua`,
    );
    expect(scriptDir).toBeGreaterThanOrEqual(0);
    expect(scriptDir).toBeLessThan(script);
  });

  it("writes binary assets as bytes rather than text", async () => {
    // lua.lib is a linker input; a utf-8 round-trip would corrupt it and the
    // user's cargo build would fail with an unreadable archive.
    await newFolder("rust-dll", "my-mod");
    expect(state.files.get(`${PARENT}\\my-mod\\lua5.1\\lua.lib`)).toEqual(LUA_LIB);
  });

  it("trims the requested name", async () => {
    const result = await newFolder("blank", "  my-mod  ");
    expect(result.root).toBe(`${PARENT}\\my-mod`);
  });

  it("scaffolds into an existing empty folder", async () => {
    // The folder the user just made in Explorer, then browsed to.
    state.directories.add(`${PARENT}\\my-mod`);
    await newFolder("blank", "my-mod");
    expect(seededText(`${PARENT}\\my-mod\\dcs-studio.toml`)).toContain("[project]");
  });

  it("refuses a folder that already has files in it", async () => {
    // Scaffolding over someone's existing work would mix a new project into it
    // and overwrite any file the template also defines.
    seedFile(`${PARENT}\\my-mod\\notes.txt`, "my work");
    await expect(newFolder("blank", "my-mod")).rejects.toThrow("already exists and isn't empty");
    expect(state.fsOps).toEqual([]);
  });

  it("refuses a path that is a file", async () => {
    seedFile(`${PARENT}\\my-mod`, "an unrelated file");
    await expect(newFolder("blank", "my-mod")).rejects.toThrow(
      `"${PARENT}\\my-mod" already exists`,
    );
  });

  it.each([
    ["an empty name", "   ", "Enter a project name."],
    ["a name with path separators", "mods/my-mod", "isn't a valid folder name"],
    ["a name ending in a dot", "my-mod.", "isn't a valid folder name"],
  ])("rejects %s", async (_label, name, message) => {
    await expect(newFolder("blank", name)).rejects.toThrow(message);
    expect(state.fsOps).toEqual([]);
  });

  it("rejects a missing location", async () => {
    await expect(newFolder("blank", "my-mod", "")).rejects.toThrow("Choose a location");
  });

  it("rejects an unknown template before touching the disk", async () => {
    await expect(newFolder("kitchen-sink", "my-mod")).rejects.toThrow(
      'Unknown template "kitchen-sink"',
    );
    expect(state.fsOps).toEqual([]);
  });
});

describe("scaffolding into the folder already open", () => {
  const ROOT = "C:\\proj";
  const inPlace = (name: string, template = "lua-mission") =>
    scaffoldInPlace(extensionUri(), template, name, ROOT);

  it("writes the template into the open folder", async () => {
    const result = await inPlace("my-mod");
    expect(result).toEqual({ root: ROOT, skipped: [] });
    expect(seededText(`${ROOT}\\dcs-studio.toml`)).toContain('name = "my-mod"');
  });

  it("keeps files the folder already has and names them", async () => {
    // This runs against a repo the user already has work in — a README or a
    // .gitignore they wrote is theirs, and silently replacing it with the
    // template's is not recoverable from the editor.
    seedFile(`${ROOT}\\README.md`, "# my existing notes");
    const result = await inPlace("my-mod");

    expect(result.skipped).toEqual(["README.md"]);
    expect(seededText(`${ROOT}\\README.md`)).toBe("# my existing notes");
    // The files it did not already have still get written.
    expect(seededText(`${ROOT}\\Scripts\\my-mod.lua`)).toContain("DCS Studio");
  });

  it("accepts a name that could not be a folder, since it makes no folder", async () => {
    const result = await inPlace("My Mod: Reloaded");
    expect(result.skipped).toEqual([]);
    expect(seededText(`${ROOT}\\dcs-studio.toml`)).toContain('name = "My Mod: Reloaded"');
  });

  it("still rejects an empty name", async () => {
    await expect(inPlace("  ")).rejects.toThrow("Enter a project name.");
    expect(state.fsOps).toEqual([]);
  });
});
