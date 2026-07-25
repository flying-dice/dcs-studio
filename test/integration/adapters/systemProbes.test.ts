import { beforeEach, describe, expect, it, vi } from "vitest";

// The three smallest node adapters, each a thin wrapper whose only real
// decisions are what it asks the OS and how it degrades when the OS says no.
// RegExeRegistry matters most: it shells out to reg.exe, which does not exist
// off-Windows, and its contract is that every failure mode collapses to an
// empty result rather than an exception — DCS detection runs on startup, so a
// throw here would surface as a broken extension rather than "DCS not found".

type ExecFileCb = (err: Error | null, stdout: string, stderr: string) => void;
const execFileCalls: { file: string; args: string[] }[] = [];
let execFileImpl: (cb: ExecFileCb) => void = (cb) => cb(null, "", "");

vi.mock("child_process", () => ({
  execFile: (file: string, args: string[], _opts: unknown, cb: ExecFileCb) => {
    execFileCalls.push({ file, args });
    execFileImpl(cb);
  },
}));

vi.mock("os", () => ({ homedir: () => "C:\\Users\\pilot" }));

import { SystemClock } from "../../../src/adapters/node/clock";
import { NodeEnv } from "../../../src/adapters/node/env";
import { RegExeRegistry } from "../../../src/adapters/node/registry";

beforeEach(() => {
  execFileCalls.length = 0;
  execFileImpl = (cb) => cb(null, "", "");
});

describe("SystemClock", () => {
  it("reports the real wall clock", () => {
    const before = Date.now();
    const now = new SystemClock().now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it("advances between calls rather than caching a value", async () => {
    const clock = new SystemClock();
    const first = clock.now();
    await new Promise((r) => setTimeout(r, 2));
    expect(clock.now()).toBeGreaterThan(first);
  });
});

describe("NodeEnv", () => {
  const ORIGINAL = process.env.USERPROFILE;

  it("reports the OS homedir", () => {
    expect(new NodeEnv().homedir()).toBe("C:\\Users\\pilot");
  });

  it("reports USERPROFILE when set, and undefined when not", () => {
    process.env.USERPROFILE = "C:\\Users\\other";
    expect(new NodeEnv().userProfile()).toBe("C:\\Users\\other");
    delete process.env.USERPROFILE;
    expect(new NodeEnv().userProfile()).toBeUndefined();
    if (ORIGINAL !== undefined) process.env.USERPROFILE = ORIGINAL;
  });

  it("offers both Program Files variants on each candidate drive", () => {
    // DCS is commonly installed off the system drive, and a 32-bit-era install
    // lands in (x86) — missing either shape means detection silently fails.
    expect(new NodeEnv().programFilesCandidates()).toEqual([
      "C:\\Program Files",
      "C:\\Program Files (x86)",
      "D:\\Program Files",
      "D:\\Program Files (x86)",
      "E:\\Program Files",
      "E:\\Program Files (x86)",
    ]);
  });
});

describe("RegExeRegistry", () => {
  it("queries the requested key recursively for one value name", async () => {
    await new RegExeRegistry().queryValues("HKCU", "Software\\Eagle Dynamics\\DCS World", "Path");
    expect(execFileCalls).toEqual([
      {
        file: "reg",
        args: ["query", "HKCU\\Software\\Eagle Dynamics\\DCS World", "/s", "/v", "Path"],
      },
    ]);
  });

  it("parses reg.exe output into key/value pairs", async () => {
    execFileImpl = (cb) =>
      cb(
        null,
        [
          "HKEY_CURRENT_USER\\Software\\Eagle Dynamics\\DCS World",
          "    Path    REG_SZ    D:\\DCS World",
          "",
          "HKEY_CURRENT_USER\\Software\\Eagle Dynamics\\DCS World OpenBeta",
          "    Path    REG_SZ    D:\\DCS World OpenBeta",
        ].join("\r\n"),
        "",
      );

    // The adapter hands raw stdout to the pure parser, which keys each hit by
    // the leaf subkey — that leaf is the variant name shown in Setup.
    const out = await new RegExeRegistry().queryValues("HKCU", "Software", "Path");
    expect(out).toEqual([
      ["DCS World", "D:\\DCS World"],
      ["DCS World OpenBeta", "D:\\DCS World OpenBeta"],
    ]);
  });

  it("resolves empty when reg.exe is absent, rather than rejecting", async () => {
    // The non-Windows case, and the one this whole adapter exists to absorb.
    execFileImpl = (cb) => cb(new Error("ENOENT"), "", "");
    await expect(new RegExeRegistry().queryValues("HKCU", "Software", "Path")).resolves.toEqual([]);
  });

  it("resolves empty when the key exists but produces no output", async () => {
    execFileImpl = (cb) => cb(null, "", "");
    await expect(new RegExeRegistry().queryValues("HKCU", "Missing", "Path")).resolves.toEqual([]);
  });

  it("resolves empty when output is present but matches no value name", async () => {
    execFileImpl = (cb) => cb(null, "HKEY_CURRENT_USER\\Software\\Other\r\n", "");
    await expect(new RegExeRegistry().queryValues("HKCU", "Software", "Path")).resolves.toEqual([]);
  });
});
