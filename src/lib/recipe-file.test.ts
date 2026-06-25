import { describe, it, expect, vi } from "vitest";
import {
  createFileFromRecipe,
  recipeBaseName,
  type RecipeFileOps,
} from "./recipe-file";
import type { Recipe } from "./recipes";

function recipe(over: Partial<Recipe> = {}): Recipe {
  return {
    id: "r",
    category: "dcs",
    title: "Mission (model) time",
    blurb: "b",
    code: "return DCS.getModelTime()",
    ...over,
  };
}

/**
 * In-memory fake of the fs + workbench seams. `createFile` refuses a duplicate
 * name (like Rust `create_file`); `readDir` reflects files created so far, so a
 * second call to the action sees the first file and must skip its name.
 */
function fakeOps(over: Partial<RecipeFileOps> & { root?: string | null } = {}) {
  const { root: rootOver, ...opOver } = over;
  const root = rootOver === undefined ? "/ws" : rootOver;
  const files = new Map<string, string>(); // path -> contents
  const opened: { path: string; name: string }[] = [];
  let refreshed = 0;
  const ops: RecipeFileOps = {
    rootPath: () => root,
    readDir: async (dir) =>
      [...files.keys()]
        .filter((p) => p.startsWith(`${dir}/`))
        .map((p) => ({ name: p.slice(dir.length + 1) })),
    createFile: async (parentDir, name) => {
      const path = `${parentDir}/${name}`;
      const clash = [...files.keys()].some(
        (p) => p.toLowerCase() === path.toLowerCase(),
      );
      if (clash) throw new Error(`exists: ${name}`);
      files.set(path, "");
      return path;
    },
    writeFile: async (path, contents) => {
      files.set(path, contents);
    },
    openFile: (path, name) => opened.push({ path, name }),
    refreshTree: () => {
      refreshed += 1;
    },
    ...opOver,
  };
  return { ops, files, opened, refreshed: () => refreshed };
}

describe("recipeBaseName (issue #60)", () => {
  it("slugifies a title to lower-case, dash-joined alphanumerics", () => {
    expect(recipeBaseName("Mission (model) time")).toBe("mission-model-time");
    expect(recipeBaseName("Export a query to CSV")).toBe("export-a-query-to-csv");
    expect(recipeBaseName("JSON.encode")).toBe("json-encode");
  });

  it("trims leading/trailing separators and collapses runs", () => {
    expect(recipeBaseName("  Hello,  World!  ")).toBe("hello-world");
    expect(recipeBaseName("In-memory scratch DB")).toBe("in-memory-scratch-db");
  });

  it("is empty when the title has no alphanumerics (caller falls back)", () => {
    expect(recipeBaseName("!!!")).toBe("");
    expect(recipeBaseName("— …")).toBe("");
  });
});

describe("createFileFromRecipe (issue #60)", () => {
  it("creates a slug-named file at the root seeded with the code, then opens it", async () => {
    const { ops, files, opened, refreshed } = fakeOps();
    await createFileFromRecipe(recipe(), ops);

    expect([...files.entries()]).toEqual([
      ["/ws/mission-model-time.lua", "return DCS.getModelTime()"],
    ]);
    // Seeded BEFORE open → the tab loads already-saved content (not dirty).
    expect(opened).toEqual([
      { path: "/ws/mission-model-time.lua", name: "mission-model-time.lua" },
    ]);
    expect(refreshed()).toBe(1);
  });

  it("falls back to untitled.lua when the title slugifies to nothing", async () => {
    const { ops, files } = fakeOps();
    await createFileFromRecipe(recipe({ title: "!!!" }), ops);
    expect([...files.keys()]).toEqual(["/ws/untitled.lua"]);
  });

  it("uniquifies the name when one already exists (creating another)", async () => {
    const { ops, files, opened } = fakeOps();
    await createFileFromRecipe(recipe(), ops);
    await createFileFromRecipe(recipe(), ops);

    expect([...files.keys()]).toEqual([
      "/ws/mission-model-time.lua",
      "/ws/mission-model-time-2.lua",
    ]);
    expect(opened.map((o) => o.name)).toEqual([
      "mission-model-time.lua",
      "mission-model-time-2.lua",
    ]);
  });

  it("is a no-op with no project open (consistent with newRootFile)", async () => {
    const { ops, files, opened } = fakeOps({ root: null });
    await expect(createFileFromRecipe(recipe(), ops)).resolves.toBeUndefined();
    expect(files.size).toBe(0);
    expect(opened).toEqual([]);
  });

  it("logs and never throws when the create fails (race, IO error)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const opened = vi.fn();
    const { ops } = fakeOps({
      createFile: async () => {
        throw new Error("io");
      },
      openFile: opened,
    });
    await expect(createFileFromRecipe(recipe(), ops)).resolves.toBeUndefined();
    expect(opened).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledOnce();
    err.mockRestore();
  });

  it("logs and never throws when seeding the content fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const opened = vi.fn();
    const { ops } = fakeOps({
      writeFile: async () => {
        throw new Error("io");
      },
      openFile: opened,
    });
    await expect(createFileFromRecipe(recipe(), ops)).resolves.toBeUndefined();
    // Create happened but the seed write failed → the tab is never opened.
    expect(opened).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledOnce();
    err.mockRestore();
  });
});
