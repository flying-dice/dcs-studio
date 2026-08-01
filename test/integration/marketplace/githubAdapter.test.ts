import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GithubMarketplace } from "../../../src/adapters/github/marketplace";
import type { AuthPort } from "../../../src/core/ports/auth";
import { productInvariants } from "../../support/marketplaceContract";

// The GitHub REST half of MarketplacePort: headers, status handling, and the
// call sequence a product page needs. The response *mapping* is pure and unit
// tested — what only shows up here is whether the adapter asks GitHub the right
// question, authenticates when it can, and turns each failure shape into
// something the storefront can render.
//
// It is also run against the shared port contract, so the GitHub backend and
// the mock backend are held to the same product invariants — that
// interchangeability is the whole reason MarketplacePort exists.

interface Route {
  status?: number;
  json?: unknown;
  text?: string;
  /** Force a body that fails to parse as JSON. */
  badJson?: boolean;
}

const routes = new Map<string, Route>();
const requests: { url: string; headers: Record<string, string> }[] = [];

function route(match: string, r: Route): void {
  routes.set(match, r);
}

const fetchMock = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
  requests.push({ url, headers: init?.headers ?? {} });
  const key = [...routes.keys()].find((k) => url.includes(k));
  const r: Route = key ? (routes.get(key) as Route) : { status: 404 };
  const status = r.status ?? 200;
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: status === 500 ? "Internal Server Error" : `HTTP ${status}`,
    json: async () => {
      if (r.badJson) throw new Error("not json");
      return r.json;
    },
    text: async () => r.text ?? "",
  } as unknown as Response;
});

// Explicit parameter, no default: `auth(undefined)` must really mean signed
// out, which a default value would quietly override.
function auth(token: string | undefined): AuthPort {
  return {
    getToken: async () => token,
    onDidChangeSessions: () => ({ dispose: () => {} }),
    currentSession: async () => undefined,
    signIn: async () => undefined,
  };
}

const repoJson = {
  full_name: "Owner/Repo",
  name: "Repo",
  description: "A mod",
  stargazers_count: 7,
  topics: ["dcs-studio", "mission"],
  owner: { login: "Owner", avatar_url: "https://avatars/x" },
  html_url: "https://github.com/Owner/Repo",
};

const releaseJson = {
  tag_name: "v1.0.0",
  assets: [
    { name: "dcs-studio.toml", size: 120, browser_download_url: "https://dl/toml" },
    { name: "mod.7z", size: 900, browser_download_url: "https://dl/7z" },
  ],
};

beforeEach(() => {
  routes.clear();
  requests.length = 0;
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("discover", () => {
  it("searches by topic, most-starred first, in one page of 100", () => {
    route("/search/repositories", { json: { items: [] } });
    return new GithubMarketplace(auth("tok")).discover("dcs-studio").then(() => {
      const url = requests[0].url;
      expect(url).toContain("q=topic%3Adcs-studio");
      expect(url).toContain("per_page=100");
      expect(url).toContain("sort=stars");
      expect(url).toContain("order=desc");
    });
  });

  it("sends the API version and a user agent, and authenticates when a token exists", async () => {
    route("/search/repositories", { json: { items: [] } });
    await new GithubMarketplace(auth("secret")).discover("dcs-studio");

    expect(requests[0].headers).toMatchObject({
      Accept: "application/vnd.github+json",
      "User-Agent": "dcs-studio-vscode",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: "Bearer secret",
    });
  });

  it("omits Authorization entirely when signed out, rather than sending an empty one", async () => {
    // GitHub rejects `Authorization: Bearer ` outright — anonymous browsing has
    // to send no header at all.
    route("/search/repositories", { json: { items: [] } });
    await new GithubMarketplace(auth(undefined)).discover("dcs-studio");
    expect(requests[0].headers).not.toHaveProperty("Authorization");
  });

  it("maps each search hit to a listing", async () => {
    route("/search/repositories", { json: { items: [repoJson] } });
    const listings = await new GithubMarketplace(auth("tok")).discover("dcs-studio");
    expect(listings).toHaveLength(1);
    expect(listings[0]).toMatchObject({ repo: "Owner/Repo", stars: 7 });
  });

  it("returns an empty list when the search yields no items field", async () => {
    route("/search/repositories", { json: {} });
    await expect(new GithubMarketplace(auth("tok")).discover("x")).resolves.toEqual([]);
  });

  it("returns an empty list on a 404 rather than throwing", async () => {
    route("/search/repositories", { status: 404 });
    await expect(new GithubMarketplace(auth("tok")).discover("x")).resolves.toEqual([]);
  });

  it("surfaces GitHub's own message on a rate limit", async () => {
    route("/search/repositories", {
      status: 403,
      json: { message: "API rate limit exceeded" },
    });
    // The domain rewrites GitHub's wording into something actionable rather
    // than echoing it — the user needs to know signing in raises the limit.
    await expect(new GithubMarketplace(auth("tok")).discover("x")).rejects.toThrow(
      "GitHub rate limit reached. Sign in to raise the limit, or wait a minute.",
    );
  });

  it("falls back to the status text when the error body is not JSON", async () => {
    route("/search/repositories", { status: 500, badJson: true });
    await expect(new GithubMarketplace(auth("tok")).discover("x")).rejects.toThrow(
      /Internal Server Error/,
    );
  });

  it("falls back to the status text when the error body has no message", async () => {
    route("/search/repositories", { status: 500, json: {} });
    await expect(new GithubMarketplace(auth("tok")).discover("x")).rejects.toThrow(
      /Internal Server Error/,
    );
  });
});

describe("loadProduct", () => {
  function seed(over: { readme?: Route; release?: Route; repo?: Route } = {}) {
    route("/repos/Owner/Repo/readme", over.readme ?? { text: "# Hello" });
    route("/repos/Owner/Repo/releases/latest", over.release ?? { json: releaseJson });
    // Least specific last: the matcher takes the first key that appears in the
    // url, so the bare repo route must not shadow the two above.
    route("/repos/Owner/Repo", over.repo ?? { json: repoJson });
  }

  it("fetches the repo, its README and its latest release", async () => {
    seed();
    const product = await new GithubMarketplace(auth("tok")).loadProduct("Owner/Repo");

    expect(requests.map((r) => r.url.replace("https://api.github.com", ""))).toEqual([
      "/repos/Owner/Repo",
      "/repos/Owner/Repo/readme",
      "/repos/Owner/Repo/releases/latest",
    ]);
    expect(product).toMatchObject({ repo: "Owner/Repo", release_tag: "v1.0.0" });
  });

  it.each(["Repo", "", "Owner/", "/Repo"])(
    "rejects %o as a repo reference instead of asking GitHub about it",
    async (bad) => {
      // Without the owner/name split holding, the name half is undefined and the
      // request went out as `/repos/<bad>/undefined`, returning GitHub's 404 as
      // "Repository <bad>/undefined was not found." — a message that reads like
      // the repo is missing rather than like the argument is malformed. The
      // shape is checkable here, so it is checked here, and no request is made.
      await expect(new GithubMarketplace(auth("tok")).loadProduct(bad)).rejects.toThrow(
        /is not an owner\/name repository reference/,
      );
      expect(requests).toEqual([]);
    },
  );

  it("requests the README as raw markdown, not as JSON metadata", async () => {
    seed();
    await new GithubMarketplace(auth("tok")).loadProduct("Owner/Repo");
    const readmeRequest = requests.find((r) => r.url.endsWith("/readme"));
    expect(readmeRequest?.headers.Accept).toBe("application/vnd.github.raw");
  });

  it("satisfies the shared MarketplacePort product contract", async () => {
    seed();
    const product = await new GithubMarketplace(auth("tok")).loadProduct("Owner/Repo");
    // The same invariants the mock backend is held to, so the two are
    // genuinely interchangeable behind the port.
    productInvariants(product);
  });

  it("renders a repo with no README", async () => {
    seed({ readme: { status: 404 } });
    const product = await new GithubMarketplace(auth("tok")).loadProduct("Owner/Repo");
    expect(product.repo).toBe("Owner/Repo");
  });

  it("fails the page when the README request errors rather than 404s", async () => {
    // A 404 means "this repo has no README" and degrades; any other status is
    // GitHub being unwell, and is surfaced rather than rendered as an empty
    // description that looks like the author's fault.
    seed({ readme: { status: 500 } });
    await expect(new GithubMarketplace(auth("tok")).loadProduct("Owner/Repo")).rejects.toThrow(
      /Internal Server Error/,
    );
  });

  it("marks a repo with no release as not installable", async () => {
    seed({ release: { status: 404 } });
    const product = await new GithubMarketplace(auth("tok")).loadProduct("Owner/Repo");
    expect(product.release_tag).toBeNull();
    expect(product.installable).toBe(false);
    productInvariants(product);
  });

  it("marks a release without a manifest asset as not installable", async () => {
    seed({
      release: {
        json: {
          tag_name: "v1.0.0",
          assets: [{ name: "mod.7z", size: 900, browser_download_url: "https://dl/7z" }],
        },
      },
    });
    const product = await new GithubMarketplace(auth("tok")).loadProduct("Owner/Repo");
    expect(product.installable).toBe(false);
    productInvariants(product);
  });

  it("names the missing repo when it does not exist", async () => {
    // A 404 on the repo is the one case that must throw rather than degrade:
    // there is no product page to show.
    route("/repos/Owner/Missing", { status: 404 });
    await expect(new GithubMarketplace(auth("tok")).loadProduct("Owner/Missing")).rejects.toThrow(
      "Repository Owner/Missing was not found.",
    );
  });

  it("splits the owner/name pair out of the repo id", async () => {
    seed();
    await new GithubMarketplace(auth("tok")).loadProduct("Owner/Repo");
    expect(requests[0].url).toBe("https://api.github.com/repos/Owner/Repo");
  });
});
