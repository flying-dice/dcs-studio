import { describe, it, expect } from "vitest";
import {
  DISCOVERY_TOPIC,
  MANIFEST_FILE,
  labelsFrom,
  mapListing,
  mapAssets,
  mapProduct,
  ghErrorMessage,
  type SearchItem,
  type RepoJson,
  type ReleaseJson,
} from "../../src/core/domain/githubMarketplace";
import { productInvariants } from "../marketplace/contract";

describe("marker constants", () => {
  it("match the dcs-studio project markers", () => {
    expect(DISCOVERY_TOPIC).toBe("dcs-studio");
    expect(MANIFEST_FILE).toBe("dcs-studio.toml");
  });
});

describe("labelsFrom", () => {
  it("drops the marker topic and keeps the rest", () => {
    expect(labelsFrom(["dcs-studio", "script", "weapons"])).toEqual(["script", "weapons"]);
  });

  it("is empty for a marker-only topic list", () => {
    expect(labelsFrom(["dcs-studio"])).toEqual([]);
  });
});

const searchItem = (over: Partial<SearchItem> = {}): SearchItem => ({
  full_name: "owner/mod",
  name: "mod",
  description: "A mod.",
  html_url: "https://github.com/owner/mod",
  stargazers_count: 5,
  topics: ["dcs-studio", "script"],
  owner: { login: "owner", avatar_url: "https://avatars/owner" },
  ...over,
});

describe("mapListing", () => {
  it("maps a search item to a listing", () => {
    expect(mapListing(searchItem())).toEqual({
      repo: "owner/mod",
      name: "mod",
      author: "owner",
      description: "A mod.",
      labels: ["script"],
      repo_url: "https://github.com/owner/mod",
      avatar_url: "https://avatars/owner",
      stars: 5,
    });
  });

  it("tolerates missing topics, owner, description, and stars", () => {
    const it_ = searchItem({
      topics: undefined,
      owner: undefined as unknown as SearchItem["owner"],
      description: null,
      stargazers_count: undefined as unknown as number,
    });
    const l = mapListing(it_);
    expect(l.labels).toEqual([]);
    expect(l.author).toBe("");
    expect(l.avatar_url).toBe("");
    expect(l.description).toBe("");
    expect(l.stars).toBe(0);
  });
});

const releaseJson = (over: Partial<ReleaseJson> = {}): ReleaseJson => ({
  tag_name: "v1.2.3",
  html_url: "https://github.com/owner/mod/releases/tag/v1.2.3",
  assets: [
    { name: "mod.7z", size: 100, browser_download_url: "https://dl/mod.7z" },
    { name: "dcs-studio.toml", size: 10, browser_download_url: "https://dl/manifest" },
  ],
  ...over,
});

describe("mapAssets", () => {
  it("maps release assets (browser_download_url → url)", () => {
    expect(mapAssets(releaseJson())).toEqual([
      { name: "mod.7z", size: 100, url: "https://dl/mod.7z" },
      { name: "dcs-studio.toml", size: 10, url: "https://dl/manifest" },
    ]);
  });

  it("is empty for a missing release", () => {
    expect(mapAssets(null)).toEqual([]);
  });
});

const repoJson = (over: Partial<RepoJson> = {}): RepoJson => ({
  full_name: "owner/mod",
  name: "mod",
  description: "A mod.",
  html_url: "https://github.com/owner/mod",
  stargazers_count: 7,
  topics: ["dcs-studio"],
  owner: { login: "owner", avatar_url: "https://avatars/owner" },
  ...over,
});

describe("mapProduct", () => {
  it("maps repo + readme + release, computing installability and download size", () => {
    const p = mapProduct(repoJson(), "# readme", releaseJson(), "fallback");
    expect(p).toEqual({
      repo: "owner/mod",
      name: "mod",
      author: "owner",
      description: "A mod.",
      repo_url: "https://github.com/owner/mod",
      avatar_url: "https://avatars/owner",
      stars: 7,
      readme: "# readme",
      release_tag: "v1.2.3",
      release_url: "https://github.com/owner/mod/releases/tag/v1.2.3",
      assets: [
        { name: "mod.7z", size: 100, url: "https://dl/mod.7z" },
        { name: "dcs-studio.toml", size: 10, url: "https://dl/manifest" },
      ],
      download_size: 110,
      installable: true,
      installs: [],
      requires: [],
    });
    productInvariants(p);
  });

  it("is not installable without a manifest asset in the latest release", () => {
    const rel = releaseJson({
      assets: [{ name: "mod.7z", size: 100, browser_download_url: "https://dl/mod.7z" }],
    });
    const p = mapProduct(repoJson(), null, rel, "fallback");
    expect(p.installable).toBe(false);
    expect(p.download_size).toBe(100);
    productInvariants(p);
  });

  it("handles a repo without a release (null tag/url, empty assets)", () => {
    const p = mapProduct(repoJson(), null, null, "fallback");
    expect(p.release_tag).toBeNull();
    expect(p.release_url).toBeNull();
    expect(p.assets).toEqual([]);
    expect(p.download_size).toBe(0);
    expect(p.installable).toBe(false);
    expect(p.readme).toBeNull();
    productInvariants(p);
  });

  it("tolerates missing owner/description/stars/topics with the owner fallback", () => {
    const repo = repoJson({
      owner: undefined as unknown as RepoJson["owner"],
      description: null,
      stargazers_count: undefined as unknown as number,
      topics: undefined,
    });
    const p = mapProduct(repo, null, null, "fallback-owner");
    expect(p.author).toBe("fallback-owner");
    expect(p.avatar_url).toBe("");
    expect(p.description).toBe("");
    expect(p.stars).toBe(0);
  });
});

describe("ghErrorMessage", () => {
  it("maps a 403 rate-limit detail to the friendly sign-in message", () => {
    expect(ghErrorMessage(403, "API rate limit exceeded for 1.2.3.4.")).toBe(
      "GitHub rate limit reached. Sign in to raise the limit, or wait a minute.",
    );
    expect(ghErrorMessage(403, "You have exceeded a secondary RATE LIMIT")).toBe(
      "GitHub rate limit reached. Sign in to raise the limit, or wait a minute.",
    );
  });

  it("keeps a non-rate-limit 403 as a generic GitHub error", () => {
    expect(ghErrorMessage(403, "Resource protected by organization SAML")).toBe(
      "GitHub 403: Resource protected by organization SAML",
    );
  });

  it("formats other statuses with their detail", () => {
    expect(ghErrorMessage(500, "Internal Server Error")).toBe("GitHub 500: Internal Server Error");
    expect(ghErrorMessage(422, "Validation Failed")).toBe("GitHub 422: Validation Failed");
  });
});
