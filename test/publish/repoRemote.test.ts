import { describe, expect, it } from "vitest";
import { parseRepoRemote } from "../../src/core/domain/repoRemote";

// Characterizes the exact behavior of the original publishPanel.ts detectRepo
// regex: /github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/i over the trimmed output of
// `git remote get-url origin`.
describe("parseRepoRemote", () => {
  it("parses an https remote with a .git suffix", () => {
    expect(parseRepoRemote("https://github.com/flying-dice/dcs-studio.git")).toEqual({
      owner: "flying-dice",
      name: "dcs-studio",
    });
  });

  it("parses an https remote without a .git suffix", () => {
    expect(parseRepoRemote("https://github.com/owner/repo")).toEqual({
      owner: "owner",
      name: "repo",
    });
  });

  it("parses an ssh remote with a .git suffix", () => {
    expect(parseRepoRemote("git@github.com:owner/repo.git")).toEqual({
      owner: "owner",
      name: "repo",
    });
  });

  it("parses an ssh remote without a .git suffix", () => {
    expect(parseRepoRemote("git@github.com:owner/repo")).toEqual({ owner: "owner", name: "repo" });
  });

  it("parses an ssh:// protocol remote", () => {
    expect(parseRepoRemote("ssh://git@github.com/owner/repo.git")).toEqual({
      owner: "owner",
      name: "repo",
    });
  });

  it("matches github.com case-insensitively", () => {
    expect(parseRepoRemote("https://GitHub.COM/Owner/Repo.git")).toEqual({
      owner: "Owner",
      name: "Repo",
    });
  });

  it("trims surrounding whitespace (raw git stdout)", () => {
    expect(parseRepoRemote("  https://github.com/owner/repo.git\n")).toEqual({
      owner: "owner",
      name: "repo",
    });
  });

  it("keeps dots in the repo name while dropping only the trailing .git", () => {
    expect(parseRepoRemote("https://github.com/owner/my.mod.git")).toEqual({
      owner: "owner",
      name: "my.mod",
    });
  });

  it("returns null for a non-GitHub remote", () => {
    expect(parseRepoRemote("https://gitlab.com/owner/repo.git")).toBeNull();
  });

  it("returns null for garbage", () => {
    expect(parseRepoRemote("not a url")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parseRepoRemote("")).toBeNull();
  });
});
