import { describe, expect, it } from "vitest";
import {
  entrypointConsentKey,
  entrypointRunKey,
  expandArgTokens,
  resolveEntrypointLaunch,
} from "../../src/core/domain/entrypointLaunch";
import type { InstallRoots, ManifestEntrypoint } from "../../src/core/domain/types";

const ROOTS: InstallRoots = { savedGames: "C:\\SG\\DCS", gameInstall: "E:\\DCS" };
const UNPACKED = "D:\\data\\Owner__Repo";

const ep = (over: Partial<ManifestEntrypoint> = {}): ManifestEntrypoint => ({
  id: "srs-server",
  name: "SRS Server",
  exe: "Server/SR-Server.exe",
  ...over,
});

describe("expandArgTokens", () => {
  it("replaces {SavedGames} and {GameInstall} tokens", () => {
    expect(expandArgTokens("{SavedGames}/cfg", ROOTS)).toBe("C:\\SG\\DCS/cfg");
    expect(expandArgTokens("{GameInstall}/bin", ROOTS)).toBe("E:\\DCS/bin");
  });

  it("replaces every occurrence in one arg", () => {
    expect(expandArgTokens("{SavedGames}-{SavedGames}", ROOTS)).toBe("C:\\SG\\DCS-C:\\SG\\DCS");
  });

  it("leaves non-token args untouched", () => {
    expect(expandArgTokens("--minimized", ROOTS)).toBe("--minimized");
  });

  it("substitutes an empty string when {GameInstall} is unconfigured", () => {
    expect(expandArgTokens("{GameInstall}/x", { savedGames: "C:\\SG", gameInstall: "" })).toBe(
      "/x",
    );
  });
});

describe("resolveEntrypointLaunch", () => {
  it("joins exe under the unpacked dir and defaults cwd to the exe's directory", () => {
    const plan = resolveEntrypointLaunch(ep(), UNPACKED, ROOTS);
    expect(plan.exe).toBe("D:\\data\\Owner__Repo\\Server\\SR-Server.exe");
    expect(plan.cwd).toBe("D:\\data\\Owner__Repo\\Server");
    expect(plan.args).toEqual([]);
  });

  it("joins an explicit cwd under the unpacked dir", () => {
    const plan = resolveEntrypointLaunch(ep({ cwd: "Server/run" }), UNPACKED, ROOTS);
    expect(plan.cwd).toBe("D:\\data\\Owner__Repo\\Server\\run");
  });

  it("expands root tokens across all args", () => {
    const plan = resolveEntrypointLaunch(
      ep({ args: ["--minimized", "--cfg", "{SavedGames}/srs.cfg", "{GameInstall}/mods"] }),
      UNPACKED,
      ROOTS,
    );
    expect(plan.args).toEqual(["--minimized", "--cfg", "C:\\SG\\DCS/srs.cfg", "E:\\DCS/mods"]);
  });

  it("treats an exe at the mod root (no subdir) with cwd defaulting to the mod dir", () => {
    const plan = resolveEntrypointLaunch(ep({ exe: "app.exe" }), UNPACKED, ROOTS);
    expect(plan.exe).toBe("D:\\data\\Owner__Repo\\app.exe");
    expect(plan.cwd).toBe("D:\\data\\Owner__Repo");
  });
});

describe("entrypointConsentKey", () => {
  it("lowercases the repo and includes the entrypoint id", () => {
    expect(entrypointConsentKey("Owner/Repo", "srs-server")).toBe(
      "dcs.entrypointConsent.owner/repo:srs-server",
    );
  });
});

describe("entrypointRunKey", () => {
  it("lowercases the repo and pairs it with the entrypoint id", () => {
    expect(entrypointRunKey("Owner/Repo", "srs-server")).toBe("owner/repo::srs-server");
    expect(entrypointRunKey("owner/repo", "srs-server")).toBe(
      entrypointRunKey("Owner/Repo", "srs-server"),
    );
  });
});
