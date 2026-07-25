import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSpawnHarness, type SpawnHarness } from "../../support/fakeChildProcess";

// The git adapter runs against a user's own working tree, so the behaviour that
// matters is which failures it insists on and which it deliberately swallows.
// Three of its methods are best-effort by design — commit (an empty tree is not
// an error), remote add (the remote already existing is the normal re-publish
// case) and the remote-url read (unset means "no remote", not a crash) — while
// init, add and push must stop the publish. That split is invisible in the
// argv, which core/domain/cliArgs already covers, and it is exactly what breaks
// a publish when it drifts.
//
// git is faked here rather than run for real: the failure modes worth pinning
// (git missing, a push rejected, git killed by a signal) cannot be produced on
// demand against a real binary, and a real one would make the results depend on
// the developer's git config.

let spawner: SpawnHarness;

vi.mock("child_process", () => ({
  spawn: (cmd: string, args: string[], opts: Record<string, unknown>) =>
    spawner.spawn(cmd, args, opts),
  spawnSync: (cmd: string, args: string[], opts: Record<string, unknown>) =>
    spawner.spawnSync(cmd, args, opts),
}));

import { GitCli, hasGitSync, isGitRepoSync } from "../../../src/adapters/node/git";

const ROOT = "D:\\proj\\my-mod";

beforeEach(() => {
  spawner = createSpawnHarness();
});

describe("hasGitSync", () => {
  it("reports git present when the version probe starts", () => {
    spawner.planSync(() => ({ status: 0, stdout: "git version 2.44.0" }));
    expect(hasGitSync()).toBe(true);
    expect(spawner.syncCalls[0]).toMatchObject({ cmd: "git", args: ["--version"] });
  });

  it("reports git absent when the binary cannot be started", () => {
    spawner.planSync(() => ({ error: new Error("ENOENT") }));
    expect(hasGitSync()).toBe(false);
  });

  it("reports git absent rather than throwing when spawnSync blows up", () => {
    // Preflight runs synchronously as the publish panel opens; a throw here
    // would replace the checklist with a broken panel.
    spawner.planSync(() => {
      throw new Error("EACCES");
    });
    expect(hasGitSync()).toBe(false);
  });
});

describe("isGitRepoSync", () => {
  it("asks git about the given root and accepts only a literal true", () => {
    spawner.planSync(() => ({ status: 0, stdout: "true\n" }));
    expect(isGitRepoSync(ROOT)).toBe(true);
    expect(spawner.syncCalls[0]).toMatchObject({
      cmd: "git",
      args: ["rev-parse", "--is-inside-work-tree"],
      opts: { cwd: ROOT, windowsHide: true, encoding: "utf8" },
    });
  });

  it("reports false inside a bare repo, where git answers false", () => {
    spawner.planSync(() => ({ status: 0, stdout: "false\n" }));
    expect(isGitRepoSync(ROOT)).toBe(false);
  });

  it("reports false when git is missing or the path is not a repo", () => {
    spawner.planSync(() => ({ error: new Error("ENOENT"), stdout: "" }));
    expect(isGitRepoSync(ROOT)).toBe(false);
  });

  it("reports false rather than throwing when spawnSync blows up", () => {
    spawner.planSync(() => {
      throw new Error("EACCES");
    });
    expect(isGitRepoSync(ROOT)).toBe(false);
  });
});

describe("GitCli probes", () => {
  it("delegates isInstalled and isRepo to the sync probes", async () => {
    spawner.planSync(() => ({ status: 0, stdout: "true\n" }));
    const git = new GitCli();
    expect(await git.isInstalled()).toBe(true);
    expect(await git.isRepo(ROOT)).toBe(true);
  });
});

describe("GitCli.init", () => {
  it("initialises the repo and renames the branch to main, in that order", async () => {
    // DCS Studio publishes from main; a repo left on master pushes a ref
    // GitHub then shows as the non-default branch.
    spawner.plan(() => ({ code: 0 }));
    await new GitCli().init(ROOT);
    expect(spawner.calls.map((c) => c.args)).toEqual([["init"], ["branch", "-M", "main"]]);
    expect(spawner.calls[0].opts).toEqual({ cwd: ROOT, windowsHide: true });
  });

  it("stops at the first failure instead of renaming a branch that does not exist", async () => {
    spawner.plan(() => ({ code: 1, stderr: "permission denied\n" }));
    await expect(new GitCli().init(ROOT)).rejects.toThrow("git init: permission denied");
    expect(spawner.calls).toHaveLength(1);
  });
});

describe("GitCli.addAll and hasChanges", () => {
  it("stages everything and fails loudly when staging fails", async () => {
    spawner.plan(() => ({ code: 0 }));
    await new GitCli().addAll(ROOT);
    expect(spawner.calls[0].args).toEqual(["add", "-A"]);

    spawner.plan(() => ({ code: 128, stderr: "index.lock exists" }));
    await expect(new GitCli().addAll(ROOT)).rejects.toThrow("git add: index.lock exists");
  });

  it("reports changes only when porcelain status prints something", async () => {
    spawner.plan(() => ({ code: 0, stdout: " M dcs-studio.toml\n" }));
    expect(await new GitCli().hasChanges(ROOT)).toBe(true);

    spawner.plan(() => ({ code: 0, stdout: "\n" }));
    expect(await new GitCli().hasChanges(ROOT)).toBe(false);
  });
});

describe("GitCli.commit", () => {
  it("commits without complaint when there is nothing to commit", async () => {
    // Re-publishing an unchanged project reaches commit with a clean tree; a
    // throw here would block a release that is otherwise perfectly valid.
    spawner.plan(() => ({ code: 1, stdout: "nothing to commit, working tree clean" }));
    await expect(new GitCli().commit(ROOT, "Publish v1.0.0")).resolves.toBeUndefined();
    expect(spawner.calls[0].args).toContain("Publish v1.0.0");
  });
});

describe("GitCli remotes", () => {
  it("reads origin's url by default and trims it", async () => {
    spawner.plan(() => ({ code: 0, stdout: "https://github.com/me/mod.git\n" }));
    expect(await new GitCli().getRemoteUrl(ROOT)).toBe("https://github.com/me/mod.git");
    expect(spawner.calls[0].args).toEqual(["remote", "get-url", "origin"]);
  });

  it("reads a named remote when one is given", async () => {
    spawner.plan(() => ({ code: 0, stdout: "git@github.com:me/mod.git\n" }));
    expect(await new GitCli().getRemoteUrl(ROOT, "upstream")).toBe("git@github.com:me/mod.git");
    expect(spawner.calls[0].args).toEqual(["remote", "get-url", "upstream"]);
  });

  it("reports no remote as null rather than as a failure", async () => {
    // A project that has never been shared has no origin; that is the starting
    // state of every publish, not an error.
    spawner.plan(() => ({ code: 2, stderr: "No such remote 'origin'" }));
    expect(await new GitCli().getRemoteUrl(ROOT)).toBeNull();
  });

  it("ignores remote-add failing because the remote already exists", async () => {
    spawner.plan(() => ({ code: 3, stderr: "error: remote origin already exists." }));
    await expect(
      new GitCli().setRemote(ROOT, "origin", "https://github.com/me/mod.git"),
    ).resolves.toBeUndefined();
    expect(spawner.calls[0].args).toEqual([
      "remote",
      "add",
      "origin",
      "https://github.com/me/mod.git",
    ]);
  });
});

describe("GitCli.push", () => {
  it("pushes the ref with upstream tracking", async () => {
    spawner.plan(() => ({ code: 0 }));
    await new GitCli().push(ROOT, "origin", "main");
    expect(spawner.calls[0].args).toEqual(["push", "-u", "origin", "main"]);
  });

  it("surfaces a rejected push with git's own explanation", async () => {
    spawner.plan(() => ({
      code: 1,
      stderr: "! [rejected] main -> main (fetch first)\n",
    }));
    await expect(new GitCli().push(ROOT, "origin", "main")).rejects.toThrow(
      "git push: ! [rejected] main -> main (fetch first)",
    );
  });

  it("falls back to stdout when git reported the problem there", async () => {
    spawner.plan(() => ({ code: 1, stdout: "Everything up-to-date but exited 1\n", stderr: "" }));
    await expect(new GitCli().push(ROOT, "origin", "main")).rejects.toThrow(
      "git push: Everything up-to-date but exited 1",
    );
  });

  it("still fails, naming the step, when git dies silently on a signal", async () => {
    // Signal death gives a null exit code; treating that as success would let
    // publish report a release that never got pushed.
    spawner.plan(() => ({ code: null }));
    await expect(new GitCli().push(ROOT, "origin", "main")).rejects.toThrow("git push: exit -1");
  });

  it("reports a spawn failure, and prefers streamed stderr when there is any", async () => {
    spawner.plan(() => ({ error: new Error("spawn git ENOENT") }));
    await expect(new GitCli().push(ROOT, "origin", "main")).rejects.toThrow(
      "git push: spawn git ENOENT",
    );

    spawner.plan(() => ({ stderr: "fatal: could not read Password\n", error: new Error("EPIPE") }));
    await expect(new GitCli().push(ROOT, "origin", "main")).rejects.toThrow(
      "git push: fatal: could not read Password",
    );
  });
});
