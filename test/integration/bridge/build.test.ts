import type { spawn as nodeSpawn } from "node:child_process";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSpawnHarness, type SpawnHarness } from "../../support/fakeChildProcess";
import { tmpRoot } from "../../support/tmpDir";
import { resetVscode, state, vscodeMock } from "../support/vscode";

vi.mock("vscode", () => vscodeMock());

import * as vscode from "vscode";
import { buildBridge } from "../../../src/bridge/build";

// Compiling the bridge is the one command that hands control to a toolchain the
// extension does not ship. Nobody watches a `cargo build` succeed — they come
// back to a notification — so the outcome has to be unambiguous, and when it
// fails the compiler's own diagnostics have to be somewhere the user can read
// them. `bridgeDir` is inside the extension's install directory, so unlike the
// DCS write dir it is a real path on this host and gets a real temp directory.

const tmp = tmpRoot("bridge-build-");
let harness: SpawnHarness;

function context(): vscode.ExtensionContext {
  return { extensionUri: vscode.Uri.file(tmp.path) } as unknown as vscode.ExtensionContext;
}

function fakeSpawn(): typeof nodeSpawn {
  return harness.spawn as unknown as typeof nodeSpawn;
}

/** The bridge workspace as a published extension with its source included. */
function seedBridgeSource(manifest = "[workspace]\n"): void {
  tmp.file(path.join("bridge", "Cargo.toml"), manifest);
}

function channel() {
  return state.outputChannels[0];
}

beforeEach(() => {
  harness = createSpawnHarness();
  resetVscode();
});

describe("without the bridge source", () => {
  it("says so instead of running a build that cannot work", async () => {
    // The marketplace build ships the prebuilt DLLs without bridge/; running
    // cargo there fails with a manifest error that explains nothing.
    await buildBridge(context(), fakeSpawn());
    expect(state.errors).toEqual(["Bridge source (bridge/) is not present in this build."]);
    expect(harness.calls).toEqual([]);
    expect(state.outputChannels).toEqual([]);
  });
});

describe("running cargo", () => {
  beforeEach(() => seedBridgeSource());

  it("builds the release profile in the bridge workspace", async () => {
    await buildBridge(context(), fakeSpawn());
    // A debug build produces DLLs the inject step would never find, and the
    // shell is needed for the Windows `cargo` shim to resolve on PATH.
    expect(harness.calls).toEqual([
      {
        cmd: "cargo",
        args: ["build", "--release"],
        opts: { cwd: tmp.join("bridge"), shell: true },
      },
    ]);
  });

  it("reports success naming both DLLs and what to do next", async () => {
    harness.plan(() => ({ code: 0 }));
    await buildBridge(context(), fakeSpawn());
    // Building alone changes nothing in DCS — the new DLLs still have to be
    // injected, so the toast has to say so.
    expect(state.info).toEqual([expect.stringContaining("Run DCS Studio: Inject")]);
    expect(state.errors).toEqual([]);
  });

  it("streams cargo's output into a channel it opens up front", async () => {
    harness.plan(() => ({
      stdout: "   Compiling dcs_studio_gui v0.1.0\n",
      stderr: "error[E0425]: cannot find value `x`\n",
      code: 101,
    }));

    await buildBridge(context(), fakeSpawn());

    // A build failure is a compiler diagnostic; without it on screen there is
    // nothing to act on.
    expect(channel().name).toBe("DCS Studio Bridge Build");
    expect(channel().shown).toBe(true);
    expect(channel().lines.join("")).toContain("error[E0425]");
    expect(channel().lines.join("")).toContain("Compiling dcs_studio_gui");
    expect(channel().lines.join("")).toContain("cargo exited with code 101");
    expect(state.errors).toEqual([expect.stringContaining("Bridge build failed")]);
    expect(state.info).toEqual([]);
  });

  it("points at the toolchain when cargo cannot be started at all", async () => {
    harness.plan(() => ({ error: new Error("spawn cargo ENOENT") }));

    await buildBridge(context(), fakeSpawn());

    // Distinct from a failed build: nothing is wrong with the source, Rust is
    // simply not installed.
    expect(state.errors).toEqual([expect.stringContaining("Is the Rust toolchain installed")]);
    expect(channel().lines.join("")).toContain("Failed to start cargo: spawn cargo ENOENT");
  });
});

describe("with the real toolchain", () => {
  it("shells out for real and reports what the toolchain said", async () => {
    // The seam is for these specs; the shipped command has to reach a real
    // cargo. A manifest cargo rejects gets a verdict without a compile.
    seedBridgeSource("this is not a manifest\n");

    await buildBridge(context());

    expect(state.errors).toEqual([expect.stringContaining("Bridge build failed")]);
    expect(channel().lines.join("")).toContain("cargo exited with code");
  });
});
