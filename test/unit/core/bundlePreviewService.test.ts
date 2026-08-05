import { describe, expect, it } from "vitest";
import { BundlePreviewService } from "../../../src/core/app/bundlePreviewService";
import { DEFAULT_VOLUME_BYTES } from "../../../src/core/domain/archivePolicy";
import { MemFileSystem } from "../../support/memFileSystem";

// The archive the manifest form draws beside the `[[bundle]]` section.
//
// What is under test is mostly the JOIN: the packager's file list, measured
// against a real project. So the fake filesystem is seeded like a real mod —
// a manifest, a folder that brings a tree, and a build output that has not been
// produced — because those are the three rows the preview exists to tell apart.

const ROOT = "C:\\proj";

function project(): MemFileSystem {
  return new MemFileSystem()
    .seedFile(`${ROOT}\\dcs-studio.toml`, "x".repeat(800))
    .seedFile(`${ROOT}\\Mods\\tech\\MyMod\\entry.lua`, "y".repeat(100))
    .seedFile(`${ROOT}\\Mods\\tech\\MyMod\\lib\\util.lua`, "z".repeat(40));
}

function service(fs = project()): BundlePreviewService {
  return new BundlePreviewService(fs);
}

const req = (bundle: { path: string }[]) => ({ bundle, name: "my-mod", version: "1.0.0" });

describe("BundlePreviewService", () => {
  it("leads with the manifest and marks it as the row nobody declared", async () => {
    const preview = await service().preview(ROOT, req([{ path: "Mods/tech/MyMod" }]));
    expect(preview.rows.map((r) => [r.path, r.always])).toEqual([
      ["dcs-studio.toml", true],
      ["Mods/tech/MyMod", false],
    ]);
  });

  it("measures a folder entry as the whole tree it brings", async () => {
    const preview = await service().preview(ROOT, req([{ path: "Mods/tech/MyMod" }]));
    expect(preview.rows[1]).toMatchObject({ kind: "dir", files: 2, bytes: 140 });
  });

  it("measures a single file entry as itself", async () => {
    const preview = await service().preview(ROOT, req([{ path: "Mods/tech/MyMod/entry.lua" }]));
    expect(preview.rows[1]).toMatchObject({ kind: "file", files: 1, bytes: 100 });
  });

  it("reports a path with nothing at it as a row, not as a failure", async () => {
    // Publish REFUSES on a missing path; the preview shows it. That difference
    // is the feature — the point is to see the unbuilt DLL before the preflight
    // stops you, not to be stopped a second time.
    const preview = await service().preview(ROOT, req([{ path: "target/release/mod.dll" }]));
    expect(preview.rows[1]).toMatchObject({ kind: "missing", files: 0, bytes: 0 });
    expect(preview.missing).toBe(1);
  });

  it("totals files and bytes across every row, the manifest included", async () => {
    const preview = await service().preview(ROOT, req([{ path: "Mods/tech/MyMod" }]));
    expect(preview.totalFiles).toBe(3);
    expect(preview.totalBytes).toBe(940);
  });

  it("names the archive from the [project] fields it was given", async () => {
    const preview = await service().preview(ROOT, {
      bundle: [],
      name: "F-16C Weapons",
      version: "2.3.1",
    });
    expect(preview.archiveName).toBe("dcs-studio-f-16c-weapons-2.3.1.7z");
  });

  it("stays quiet about splitting for a payload under the volume limit", async () => {
    const preview = await service().preview(ROOT, req([{ path: "Mods/tech/MyMod" }]));
    expect(preview.likelySplit).toBe(false);
    expect(preview.volumeBytes).toBe(DEFAULT_VOLUME_BYTES);
  });

  it("flags a payload whose SOURCE already exceeds the volume limit", async () => {
    // Deliberately measured on uncompressed bytes. Under the limit here means
    // under it compressed too, so silence is reliable; over it is a warning
    // rather than a promise, which is why the field is `likelySplit`.
    const fs = project();
    const svc = new BundlePreviewService({
      // Not seeded as a real file: 1.5 GiB of "b" in a Map is a fake nobody
      // needs. The service asks one question and this answers it.
      measure: async (p) =>
        p.endsWith("big.bin")
          ? { directory: false, files: 1, bytes: DEFAULT_VOLUME_BYTES + 1 }
          : fs.measure(p),
    });
    const preview = await svc.preview(ROOT, req([{ path: "big.bin" }]));
    expect(preview.likelySplit).toBe(true);
  });

  it("draws one row for a path declared twice, as the packager packs one copy", async () => {
    const preview = await service().preview(
      ROOT,
      req([{ path: "Mods/tech/MyMod" }, { path: "Mods/tech/MyMod" }]),
    );
    expect(preview.rows).toHaveLength(2);
  });

  it("ignores a blank row rather than measuring the project root", async () => {
    // A blank path joins to the root, which exists and is enormous — so a
    // preview that did not drop it would answer "your whole repo" for the
    // ordinary state of a form with an unfilled row in it.
    const preview = await service().preview(ROOT, req([{ path: "" }]));
    expect(preview.rows).toHaveLength(1);
    expect(preview.rows[0].path).toBe("dcs-studio.toml");
  });

  it("reports an empty folder as present and empty, not as missing", async () => {
    const fs = project().seedDir(`${ROOT}\\empty`);
    const preview = await service(fs).preview(ROOT, req([{ path: "empty" }]));
    expect(preview.rows[1]).toMatchObject({ kind: "dir", files: 0, bytes: 0 });
    expect(preview.missing).toBe(0);
  });
});
