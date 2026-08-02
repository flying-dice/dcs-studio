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
}));

import { GhCli } from "../../../src/adapters/node/gh";

beforeEach(() => {
  spawner = createSpawnHarness();
});

describe("GhCli.login", () => {
  it("returns the trimmed login the CLI printed", async () => {
    // gh prints a trailing newline; the raw value is shown in the publish panel.
    spawner.plan(() => ({ code: 0, stdout: "flying-dice\n" }));
    expect(await new GhCli().login()).toBe("flying-dice");
    expect(spawner.calls[0]).toMatchObject({
      cmd: "gh",
      args: ["api", "user", "-q", ".login"],
    });
  });

  it("returns null when gh is not installed at all", async () => {
    // A missing binary is an `error` event, never an exit code.
    spawner.plan(() => ({ error: new Error("ENOENT") }));
    expect(await new GhCli().login()).toBeNull();
  });

  it("returns null when gh ran but is not signed in", async () => {
    spawner.plan(() => ({ code: 1, stdout: "" }));
    expect(await new GhCli().login()).toBeNull();
  });
});

describe("GhCli.facts", () => {
  it("reports present and authed in ONE pass: one version probe, one auth probe", async () => {
    // The publish preflight calls this exactly once per pass — a cold
    // `gh --version` was measured at 9.8s, and `gh auth status` hits the
    // network, so doubling either is a real UX cost.
    spawner.plan(() => ({ code: 0 }));
    expect(await new GhCli().facts()).toEqual({ present: true, authed: true });
    expect(spawner.calls.map((c) => c.args)).toEqual([["--version"], ["auth", "status"]]);
  });

  it("reports present but not authed when the auth probe exits non-zero", async () => {
    // The distinction drives the preflight message: "sign in" vs "install gh".
    spawner.plan((call) => (call.args[0] === "--version" ? { code: 0 } : { code: 1 }));
    expect(await new GhCli().facts()).toEqual({ present: true, authed: false });
  });

  it("reports absent — and never probes auth — when gh is missing", async () => {
    spawner.plan(() => ({ error: new Error("ENOENT") }));
    expect(await new GhCli().facts()).toEqual({ present: false, authed: false });
    expect(spawner.calls).toHaveLength(1);
  });

  it("reports absent rather than throwing when spawn itself blows up", async () => {
    // Preflight runs on panel open; an exception here would break the panel
    // instead of showing "gh not found".
    spawner.plan(() => {
      throw new Error("EACCES");
    });
    expect(await new GhCli().facts()).toEqual({ present: false, authed: false });
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
  it("reports a topic-tagging failure without throwing", async () => {
    // Never a blocker — a mod still publishes without its topic — but the
    // caller has to be told, because an untagged repo is invisible to
    // Marketplace discovery and the share would otherwise report success.
    spawner.plan(() => ({ code: 1, stderr: "no permission to edit topics" }));
    expect(await new GhCli().repoTopicAdd("me/mod", "dcs-studio")).toBe(false);
    expect(spawner.calls[0].args).toEqual(["repo", "edit", "me/mod", "--add-topic", "dcs-studio"]);

    spawner.plan(() => ({ code: 0 }));
    expect(await new GhCli().repoTopicAdd("me/mod", "dcs-studio")).toBe(true);
  });

  it("reports whether a release for the tag already exists", async () => {
    // This is the branch that decides between replacing a release in place and
    // creating one outright, so a wrong answer here is the difference between
    // a safe re-release and a destructive one.
    spawner.plan(() => ({ code: 0 }));
    expect(await new GhCli().releaseView("me/mod", "v1.0.0")).toBe(true);
    spawner.plan(() => ({ code: 1, stderr: "release not found" }));
    expect(await new GhCli().releaseView("me/mod", "v1.0.0")).toBe(false);
  });

  it("treats deleting a non-existent release as a no-op", async () => {
    // The rollback path fires after a create that may not have got far enough
    // to leave anything behind; it must not turn into a second failure.
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

// Replacing a release in place is what keeps a re-publish from ever leaving the
// repository with no release and no tag, so these three are the load-bearing
// half of the publish flow's safety.
describe("GhCli in-place release replacement", () => {
  it("uploads over an existing release and surfaces an upload failure", async () => {
    spawner.plan(() => ({ code: 0 }));
    await expect(
      new GhCli().releaseUpload("me/mod", "v1.0.0", ["D:\\out\\p.7z"]),
    ).resolves.toBeUndefined();

    spawner.plan(() => ({ code: 1, stderr: "connection reset by peer" }));
    await expect(new GhCli().releaseUpload("me/mod", "v1.0.0", ["D:\\out\\p.7z"])).rejects.toThrow(
      "gh release upload: connection reset by peer",
    );
  });

  it("edits the release metadata and surfaces an edit failure", async () => {
    const opts = { repo: "me/mod", tag: "v1.0.0", title: "v1.0.0", notes: "n" };
    spawner.plan(() => ({ code: 0 }));
    await expect(new GhCli().releaseEdit(opts)).resolves.toBeUndefined();

    spawner.plan(() => ({ code: 1, stderr: "release not found" }));
    await expect(new GhCli().releaseEdit(opts)).rejects.toThrow(
      "gh release edit: release not found",
    );
  });

  it("reads the attached asset names, dropping blank lines", async () => {
    spawner.plan(() => ({ code: 0, stdout: "dcs-studio.toml\nmod.7z.001\n\n  mod.7z.002  \n" }));
    expect(await new GhCli().releaseAssetNames("me/mod", "v1.0.0")).toEqual([
      "dcs-studio.toml",
      "mod.7z.001",
      "mod.7z.002",
    ]);
  });

  it("reports no assets rather than failing when the release cannot be read", async () => {
    // The list is only used to decide what to prune, and pruning nothing is
    // the safe answer — a read failure must not sink a release already up.
    spawner.plan(() => ({ code: 1, stderr: "release not found" }));
    expect(await new GhCli().releaseAssetNames("me/mod", "v1.0.0")).toEqual([]);
  });

  it("reports whether a stale asset was detached, without throwing", async () => {
    spawner.plan(() => ({ code: 0 }));
    expect(await new GhCli().releaseAssetDelete("me/mod", "v1.0.0", "mod.7z.003")).toBe(true);

    spawner.plan(() => ({ code: 1, stderr: "HTTP 404" }));
    expect(await new GhCli().releaseAssetDelete("me/mod", "v1.0.0", "mod.7z.003")).toBe(false);
  });
});
