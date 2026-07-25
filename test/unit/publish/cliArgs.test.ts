import { describe, expect, it } from "vitest";
import { COMMIT_IDENTITY, ghArgs, gitArgs, sevenZipArgs } from "../../../src/core/domain/cliArgs";

// These argument vectors decide what happens to a user's repository, tags and
// release assets. They are asserted whole rather than by `toContain`, because
// the failure mode that matters is a flag quietly appearing, vanishing or
// moving — not a flag being absent entirely.

describe("ghArgs.repoCreate", () => {
  const base = { name: "my-mod", source: "C:\\proj" };

  it("defaults to a public repo that is pushed, with an explicit empty -d", () => {
    // -d must always be present: without it gh prompts, and a spawn with no
    // TTY would hang instead of failing.
    expect(ghArgs.repoCreate(base)).toEqual([
      "repo",
      "create",
      "my-mod",
      "--public",
      "--source",
      "C:\\proj",
      "--push",
      "-d",
      "",
    ]);
  });

  it("honours an explicit private visibility", () => {
    expect(ghArgs.repoCreate({ ...base, visibility: "private" })).toContain("--private");
    expect(ghArgs.repoCreate({ ...base, visibility: "private" })).not.toContain("--public");
  });

  it("wires the remote when one is named, and omits the flag otherwise", () => {
    expect(ghArgs.repoCreate({ ...base, remote: "origin" })).toEqual([
      "repo",
      "create",
      "my-mod",
      "--public",
      "--source",
      "C:\\proj",
      "--remote",
      "origin",
      "--push",
      "-d",
      "",
    ]);
    expect(ghArgs.repoCreate(base)).not.toContain("--remote");
  });

  it("pushes unless push is explicitly false", () => {
    expect(ghArgs.repoCreate({ ...base, push: true })).toContain("--push");
    // undefined means "yes" — only an explicit false suppresses the push.
    expect(ghArgs.repoCreate({ ...base, push: undefined })).toContain("--push");
    expect(ghArgs.repoCreate({ ...base, push: false })).not.toContain("--push");
  });

  it("passes the description through when set", () => {
    expect(ghArgs.repoCreate({ ...base, description: "A mod" }).slice(-2)).toEqual(["-d", "A mod"]);
  });
});

describe("ghArgs — probes and repo edits", () => {
  it("builds the presence, auth and login probes", () => {
    expect(ghArgs.version()).toEqual(["--version"]);
    expect(ghArgs.authStatus()).toEqual(["auth", "status"]);
    expect(ghArgs.apiUser()).toEqual(["api", "user", "-q", ".login"]);
  });

  it("adds a discovery topic to a repo", () => {
    expect(ghArgs.repoTopicAdd("owner/repo", "dcs-studio")).toEqual([
      "repo",
      "edit",
      "owner/repo",
      "--add-topic",
      "dcs-studio",
    ]);
  });
});

describe("ghArgs — releases", () => {
  it("views a release by tag against an explicit repo", () => {
    expect(ghArgs.releaseView("owner/repo", "v1.0.0")).toEqual([
      "release",
      "view",
      "v1.0.0",
      "-R",
      "owner/repo",
    ]);
  });

  it("deletes the release AND its tag, without prompting", () => {
    // This vector only ever undoes a release the current run half-created, so
    // --cleanup-tag is what makes the rollback complete: leave the tag behind
    // and the next attempt collides with it. --yes keeps the spawn
    // non-interactive. Nothing that existed before a publish is deleted with
    // this — an existing release is replaced through upload/edit instead.
    expect(ghArgs.releaseDelete("owner/repo", "v1.0.0")).toEqual([
      "release",
      "delete",
      "v1.0.0",
      "-R",
      "owner/repo",
      "--yes",
      "--cleanup-tag",
    ]);
  });

  it("creates a release with every asset positioned before the flags", () => {
    // gh takes assets as positionals after the tag; a flag interleaved here
    // would be read as an asset path.
    expect(
      ghArgs.releaseCreate({
        repo: "owner/repo",
        tag: "v1.0.0",
        title: "v1.0.0",
        notes: "Release notes",
        assets: ["C:\\out\\mod.7z", "C:\\out\\dcs-studio.toml"],
      }),
    ).toEqual([
      "release",
      "create",
      "v1.0.0",
      "C:\\out\\mod.7z",
      "C:\\out\\dcs-studio.toml",
      "-R",
      "owner/repo",
      "--title",
      "v1.0.0",
      "--notes",
      "Release notes",
    ]);
  });

  it("creates a release with no assets at all", () => {
    const args = ghArgs.releaseCreate({
      repo: "owner/repo",
      tag: "v1.0.0",
      title: "t",
      notes: "n",
      assets: [],
    });
    expect(args).toEqual([
      "release",
      "create",
      "v1.0.0",
      "-R",
      "owner/repo",
      "--title",
      "t",
      "--notes",
      "n",
    ]);
  });
});

describe("ghArgs — replacing a release in place", () => {
  it("uploads over an existing release with --clobber", () => {
    // Without --clobber gh refuses an asset name already attached, and the
    // only way to re-release would be to delete the release first — which is
    // exactly the window this vector exists to avoid.
    expect(
      ghArgs.releaseUpload("owner/repo", "v1.0.0", ["C:\\out\\mod.7z", "C:\\out\\dcs-studio.toml"]),
    ).toEqual([
      "release",
      "upload",
      "v1.0.0",
      "C:\\out\\mod.7z",
      "C:\\out\\dcs-studio.toml",
      "-R",
      "owner/repo",
      "--clobber",
    ]);
  });

  it("edits title and notes without naming the tag or the assets", () => {
    // No --tag / --target here: re-pointing a tag people have already fetched
    // is the damage this flow exists to avoid.
    expect(
      ghArgs.releaseEdit({
        repo: "owner/repo",
        tag: "v1.0.0",
        title: "v1.0.0",
        notes: "Release notes",
      }),
    ).toEqual([
      "release",
      "edit",
      "v1.0.0",
      "-R",
      "owner/repo",
      "--title",
      "v1.0.0",
      "--notes",
      "Release notes",
    ]);
  });

  it("reads back the attached asset names, one per line", () => {
    expect(ghArgs.releaseAssetNames("owner/repo", "v1.0.0")).toEqual([
      "release",
      "view",
      "v1.0.0",
      "-R",
      "owner/repo",
      "--json",
      "assets",
      "-q",
      ".assets[].name",
    ]);
  });

  it("detaches a single asset without prompting", () => {
    // delete-asset, not delete: the release and its tag must survive the prune.
    expect(ghArgs.releaseAssetDelete("owner/repo", "v1.0.0", "mod.7z.003")).toEqual([
      "release",
      "delete-asset",
      "v1.0.0",
      "mod.7z.003",
      "-R",
      "owner/repo",
      "--yes",
    ]);
  });
});

describe("gitArgs", () => {
  it("builds the presence and repo probes", () => {
    expect(gitArgs.version()).toEqual(["--version"]);
    expect(gitArgs.isRepo()).toEqual(["rev-parse", "--is-inside-work-tree"]);
  });

  it("initialises onto main, since publish pushes main", () => {
    expect(gitArgs.init()).toEqual(["init"]);
    expect(gitArgs.branchMain()).toEqual(["branch", "-M", "main"]);
  });

  it("stages everything and reads status in a parseable form", () => {
    expect(gitArgs.addAll()).toEqual(["add", "-A"]);
    expect(gitArgs.status()).toEqual(["status", "--porcelain"]);
  });

  it("commits with a per-invocation identity, never writing global config", () => {
    // -c passes the identity for this command only: a user with no git
    // identity configured can still publish, and their config is untouched.
    expect(gitArgs.commit("Initial commit")).toEqual([
      "-c",
      `user.email=${COMMIT_IDENTITY.email}`,
      "-c",
      `user.name=${COMMIT_IDENTITY.name}`,
      "commit",
      "-m",
      "Initial commit",
    ]);
  });

  it("keeps a multi-line commit message as a single argument", () => {
    const message = "Title\n\nBody line";
    expect(gitArgs.commit(message).at(-1)).toBe(message);
    expect(gitArgs.commit(message)).toHaveLength(7);
  });

  it("reads and adds remotes, and pushes with upstream tracking", () => {
    expect(gitArgs.getRemoteUrl("origin")).toEqual(["remote", "get-url", "origin"]);
    expect(gitArgs.remoteAdd("origin", "https://github.com/o/r.git")).toEqual([
      "remote",
      "add",
      "origin",
      "https://github.com/o/r.git",
    ]);
    expect(gitArgs.push("origin", "main")).toEqual(["push", "-u", "origin", "main"]);
  });
});

describe("sevenZipArgs", () => {
  it("extracts with the output dir glued to -o", () => {
    // 7-Zip takes no space after -o; `-o <dir>` is parsed as a file operand.
    expect(sevenZipArgs.extract("C:\\dl\\mod.7z", "C:\\data\\mod")).toEqual([
      "x",
      "-y",
      "-oC:\\data\\mod",
      "C:\\dl\\mod.7z",
    ]);
  });

  it("packs a single archive with no volume flag", () => {
    const args = sevenZipArgs.pack("C:\\out\\mod.7z", ["Scripts", "Mods/tech"]);
    expect(args).toEqual(["a", "-t7z", "-mx=5", "-y", "C:\\out\\mod.7z", "Scripts", "Mods/tech"]);
    expect(args.some((a) => a.startsWith("-v"))).toBe(false);
  });

  it("packs split volumes with an explicit byte suffix", () => {
    // The trailing `b` is load-bearing: without a unit some 7-Zip builds read
    // the number as blocks, producing volumes GitHub rejects as oversized.
    expect(sevenZipArgs.packSplit("C:\\out\\mod.7z", ["Scripts"], 1_500_000_000)).toEqual([
      "a",
      "-t7z",
      "-mx=5",
      "-y",
      "-v1500000000b",
      "C:\\out\\mod.7z",
      "Scripts",
    ]);
  });

  it("packs an empty file list without emitting a stray operand", () => {
    expect(sevenZipArgs.pack("C:\\out\\mod.7z", [])).toEqual([
      "a",
      "-t7z",
      "-mx=5",
      "-y",
      "C:\\out\\mod.7z",
    ]);
  });
});
