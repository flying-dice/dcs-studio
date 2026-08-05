import { describe, expect, it } from "vitest";
import { archiveFiles, previewArchiveName } from "../../../src/core/domain/bundlePlan";

// The rules that decide what a release .7z contains. They live here rather than
// inside PublishService because the manifest form previews the same answer, and
// these tests are what stop the two drifting: every clause below is something
// the `[[bundle]]` section never said out loud, and something a second
// implementation would eventually get wrong.

describe("archiveFiles", () => {
  it("always leads with the manifest, declared or not", () => {
    // The rule the form's copy never stated. A release without it is not
    // installable at all — the marketplace reads the install plan from it.
    expect(archiveFiles([])).toEqual(["dcs-studio.toml"]);
    expect(archiveFiles([{ path: "Scripts" }])).toEqual(["dcs-studio.toml", "Scripts"]);
  });

  it("keeps the manifest first even when it is declared explicitly", () => {
    // Otherwise the packager hands 7-Zip the same file twice and the preview
    // draws two rows for one entry.
    expect(archiveFiles([{ path: "dcs-studio.toml" }, { path: "Scripts" }])).toEqual([
      "dcs-studio.toml",
      "Scripts",
    ]);
  });

  it("packs a path declared twice exactly once, keeping the first position", () => {
    expect(archiveFiles([{ path: "Scripts" }, { path: "Mods" }, { path: "Scripts" }])).toEqual([
      "dcs-studio.toml",
      "Scripts",
      "Mods",
    ]);
  });

  it("dedupes on the literal string, as the packager does", () => {
    // `Scripts` and `./Scripts` resolve to the same folder and are two entries
    // here — stated as a test because it is a limitation, not an accident, and a
    // future normalisation must change the packager and the preview together.
    expect(archiveFiles([{ path: "Scripts" }, { path: "./Scripts" }])).toEqual([
      "dcs-studio.toml",
      "Scripts",
      "./Scripts",
    ]);
  });

  it("drops a blank path rather than treating it as the project root", () => {
    // The form appends `{ path: "" }` when Add bundled path is clicked, so this
    // is the state of every half-filled manifest. `join(root, "")` is the root,
    // so packing it would sweep the whole working tree — `.git` included — into
    // a public release.
    expect(archiveFiles([{ path: "" }, { path: "   " }, { path: "Scripts" }])).toEqual([
      "dcs-studio.toml",
      "Scripts",
    ]);
  });

  it("trims a path before packing it", () => {
    expect(archiveFiles([{ path: "  Scripts  " }])).toEqual(["dcs-studio.toml", "Scripts"]);
  });

  it("preserves declaration order, because the archive lists in that order", () => {
    expect(archiveFiles([{ path: "b" }, { path: "a" }, { path: "c" }])).toEqual([
      "dcs-studio.toml",
      "b",
      "a",
      "c",
    ]);
  });
});

describe("previewArchiveName", () => {
  it("builds the name publish would build, slug rules and all", () => {
    expect(previewArchiveName("My Mod", "v1.2.0")).toBe("dcs-studio-my-mod-v1.2.0.7z");
  });

  it("falls back to placeholders rather than rendering a name with holes in it", () => {
    // `dcs-studio--.7z` reads as a bug in the packager; the placeholders read as
    // two boxes nobody has filled in, which is what is true.
    expect(previewArchiveName("", "")).toBe("dcs-studio-your-mod-0.1.0.7z");
    expect(previewArchiveName("   ", "  ")).toBe("dcs-studio-your-mod-0.1.0.7z");
  });

  it("slugs characters GitHub would not take verbatim", () => {
    expect(previewArchiveName("F-16C Weapons!", "2.3.1")).toBe("dcs-studio-f-16c-weapons-2.3.1.7z");
  });
});
