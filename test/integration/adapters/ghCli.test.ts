import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSpawnHarness, type SpawnHarness } from "../../support/fakeChildProcess";

// The gh adapter is what stands between a publish click and someone's GitHub
// account. Now that the argv construction lives in core/domain/cliArgs, what is
// left here is process choreography and, more importantly, the judgement calls
// about what a given failure *means*: "the repo already exists" is a success
// the publish flow continues through, "not signed in" must stop it, and a
// topic-tagging failure must be swallowed so a nicety never blocks a release.
// Get one of those wrong and a user either loses a publish or silently
// publishes into the wrong place, so each is pinned here.
//
// The gh binary itself is faked (see test/support/fakeChildProcess) — a machine
// with gh installed and signed in can only ever exercise the happy branch.

let spawner: SpawnHarness;

vi.mock("child_process", () => ({
  spawn: (cmd: string, args: string[], opts: Record<string, unknown>) =>
    spawner.spawn(cmd, args, opts),
  spawnSync: (cmd: string, args: string[], opts: Record<string, unknown>) =>
    spawner.spawnSync(cmd, args, opts),
}));

import { GhCli, ghFactsSync, ghLoginSync } from "../../../src/adapters/node/gh";

beforeEach(() => {
  spawner = createSpawnHarness();
});

describe("ghLoginSync", () => {
  it("returns the trimmed login the CLI printed", () => {
    // gh prints a trailing newline; the raw value is shown in the publish panel.
    spawner.planSync(() => ({ status: 0, stdout: "flying-dice\n" }));
    expect(ghLoginSync()).toBe("flying-dice");
    expect(spawner.syncCalls[0]).toMatchObject({
      cmd: "gh",
      args: ["api", "user", "-q", ".login"],
    });
  });

  it("returns null when gh is not installed at all", () => {
    // spawnSync reports a missing binary via `error`, not a status.
    spawner.planSync(() => ({ error: new Error("ENOENT"), status: null, stdout: "" }));
    expect(ghLoginSync()).toBeNull();
  });

  it("returns null when gh ran but is not signed in", () => {
    spawner.planSync(() => ({ status: 1, stdout: "" }));
    expect(ghLoginSync()).toBeNull();
  });
});

describe("ghFactsSync", () => {
  it("reports present and authed when gh is installed and signed in", () => {
    spawner.planSync(() => ({ status: 0 }));
    expect(ghFactsSync()).toEqual({ present: true, authed: true });
    expect(spawner.syncCalls.map((c) => c.args)).toEqual([["--version"], ["auth", "status"]]);
  });

  it("reports present but not authed when the auth probe exits non-zero", () => {
    // The distinction drives the preflight message: "sign in" vs "install gh".
    spawner.planSync((call) => (call.args[0] === "--version" ? { status: 0 } : { status: 1 }));
    expect(ghFactsSync()).toEqual({ present: true, authed: false });
  });

  it("reports absent — and never probes auth — when gh is missing", () => {
    spawner.planSync(() => ({ error: new Error("ENOENT") }));
    expect(ghFactsSync()).toEqual({ present: false, authed: false });
    expect(spawner.syncCalls).toHaveLength(1);
  });

  it("reports absent rather than throwing when spawnSync itself blows up", () => {
    // Preflight runs on panel open; an exception here would break the panel
    // instead of showing "gh not found".
    spawner.planSync(() => {
      throw new Error("EACCES");
    });
    expect(ghFactsSync()).toEqual({ present: false, authed: false });
  });
});

describe("GhCli probes", () => {
  it("exposes installed/authed/login over the sync probes", async () => {
    spawner.planSync(() => ({ status: 0, stdout: "pilot\n" }));
    const gh = new GhCli();
    expect(await gh.isInstalled()).toBe(true);
    expect(await gh.isAuthed()).toBe(true);
    expect(await gh.login()).toBe("pilot");
  });

  it("reports not-installed and not-authed when gh is absent", async () => {
    spawner.planSync(() => ({ error: new Error("ENOENT") }));
    const gh = new GhCli();
    expect(await gh.isInstalled()).toBe(false);
    expect(await gh.isAuthed()).toBe(false);
  });
});

describe("GhCli.repoCreate", () => {
  it("reports a fresh creation on success", async () => {
    spawner.plan(() => ({ code: 0 }));
    expect(await new GhCli().repoCreate({ name: "my-mod", source: "D:\\proj" })).toEqual({
      created: true,
      alreadyExists: false,
    });
    expect(spawner.calls[0].cmd).toBe("gh");
    expect(spawner.calls[0].opts).toEqual({ windowsHide: true });
  });

  it("treats an existing repo as reusable rather than an error", async () => {
    // Re-publishing an already-shared mod is the common case; failing here
    // would make the second publish of any mod impossible.
    spawner.plan(() => ({ code: 1, stderr: "GraphQL: Name already exists on this account" }));
    expect(await new GhCli().repoCreate({ name: "my-mod", source: "D:\\proj" })).toEqual({
      created: false,
      alreadyExists: true,
    });
  });

  it("surfaces a real failure with the CLI's own stderr", async () => {
    spawner.plan(() => ({ code: 1, stderr: "  HTTP 403: Resource not accessible  \n" }));
    await expect(new GhCli().repoCreate({ name: "m", source: "D:\\p" })).rejects.toThrow(
      "gh repo create: HTTP 403: Resource not accessible",
    );
  });

  it("falls back to stdout when the failure was reported there", async () => {
    // gh writes some errors to stdout; an empty message would leave the user
    // with a bare "gh repo create:" and nothing to act on.
    spawner.plan(() => ({ code: 1, stdout: "could not resolve to a User\n", stderr: "" }));
    await expect(new GhCli().repoCreate({ name: "m", source: "D:\\p" })).rejects.toThrow(
      "gh repo create: could not resolve to a User",
    );
  });

  it("still fails when gh is killed by a signal and says nothing", async () => {
    // A signal death gives exit code null, which must not be mistaken for 0.
    spawner.plan(() => ({ code: null }));
    await expect(new GhCli().repoCreate({ name: "m", source: "D:\\p" })).rejects.toThrow(
      "gh repo create:",
    );
  });

  it("reports the spawn failure when gh cannot be started", async () => {
    spawner.plan(() => ({ error: new Error("spawn gh ENOENT") }));
    await expect(new GhCli().repoCreate({ name: "m", source: "D:\\p" })).rejects.toThrow(
      "gh repo create: spawn gh ENOENT",
    );
  });

  it("prefers already-streamed stderr over the spawn error message", async () => {
    // When the process produced output before dying, that output is the more
    // useful diagnostic than "spawn failed".
    spawner.plan(() => ({ stderr: "auth required\n", error: new Error("write EPIPE") }));
    await expect(new GhCli().repoCreate({ name: "m", source: "D:\\p" })).rejects.toThrow(
      "gh repo create: auth required",
    );
  });
});

describe("GhCli release and topic operations", () => {
  it("ignores a topic-tagging failure — discovery is a nicety, not a blocker", async () => {
    spawner.plan(() => ({ code: 1, stderr: "no permission to edit topics" }));
    await expect(new GhCli().repoTopicAdd("me/mod", "dcs-studio")).resolves.toBeUndefined();
    expect(spawner.calls[0].args).toEqual(["repo", "edit", "me/mod", "--add-topic", "dcs-studio"]);
  });

  it("reports whether a release for the tag already exists", async () => {
    spawner.plan(() => ({ code: 0 }));
    expect(await new GhCli().releaseView("me/mod", "v1.0.0")).toBe(true);
    spawner.plan(() => ({ code: 1, stderr: "release not found" }));
    expect(await new GhCli().releaseView("me/mod", "v1.0.0")).toBe(false);
  });

  it("treats deleting a non-existent release as a no-op", async () => {
    // cutRelease deletes before re-creating; a first-time release has nothing
    // to delete and must not fail there.
    spawner.plan(() => ({ code: 1, stderr: "release not found" }));
    await expect(new GhCli().releaseDelete("me/mod", "v1.0.0")).resolves.toBeUndefined();
  });

  it("creates a release and reports the CLI's failure verbatim", async () => {
    const opts = {
      repo: "me/mod",
      tag: "v1.0.0",
      title: "v1.0.0",
      notes: "notes",
      assets: ["D:\\out\\p.7z"],
    };
    spawner.plan(() => ({ code: 0, stdout: "https://github.com/me/mod/releases/v1.0.0\n" }));
    await expect(new GhCli().releaseCreate(opts)).resolves.toBeUndefined();

    spawner.plan(() => ({ code: 1, stderr: "asset exceeds 2GB" }));
    await expect(new GhCli().releaseCreate(opts)).rejects.toThrow(
      "gh release create: asset exceeds 2GB",
    );
  });

  it("still names the failing step when gh exits silently", async () => {
    // Nothing on either stream: the exit code is all the user can be told.
    spawner.plan(() => ({ code: 3 }));
    await expect(
      new GhCli().releaseCreate({ repo: "me/mod", tag: "v1", title: "t", notes: "", assets: [] }),
    ).rejects.toThrow("gh release create: exit 3");
  });
});
