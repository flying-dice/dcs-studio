import type { MarketplacePort } from "../../core/ports/marketplace";
import type { AuthPort } from "../../core/ports/auth";
import type { MarketListing, ProductDetail } from "../../core/domain/types";
import {
  ghErrorMessage,
  mapListing,
  mapProduct,
  type ReleaseJson,
  type RepoJson,
  type SearchItem,
} from "../../core/domain/githubMarketplace";

// GitHub REST adapter for `MarketplacePort`. Discovery mirrors dcs-studio's
// studio-services/market.rs: search public repos by the `dcs-studio` topic; the
// repo's other topics become the listing's labels; the `dcs-studio-library`
// topic marks a dependency-only library. All response mapping and the
// installability rule are pure functions in core/domain/githubMarketplace.ts —
// this file owns only HTTP + headers. Auth is the adapter's concern: the
// injected `AuthPort` supplies a token (silently, per call).

const API = "https://api.github.com";

function headers(token: string | undefined, accept: string): Record<string, string> {
  const h: Record<string, string> = {
    Accept: accept,
    "User-Agent": "dcs-studio-vscode",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function ghErr(res: Response): Promise<string> {
  let detail = res.statusText;
  try {
    const j = (await res.json()) as { message?: string };
    if (j?.message) detail = j.message;
  } catch {
    /* non-JSON body */
  }
  return ghErrorMessage(res.status, detail);
}

/** JSON GET; null on 404, throws with a readable message on other errors. */
async function ghJson<T>(url: string, token: string | undefined): Promise<T | null> {
  const res = await fetch(url, { headers: headers(token, "application/vnd.github+json") });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await ghErr(res));
  return (await res.json()) as T;
}

/** Raw text GET (README); null on 404. */
async function ghText(url: string, token: string | undefined): Promise<string | null> {
  const res = await fetch(url, { headers: headers(token, "application/vnd.github.raw") });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await ghErr(res));
  return await res.text();
}

/** Public repos carrying `topic`, mapped to listings, most-starred first. */
async function discover(topic: string, token: string | undefined): Promise<MarketListing[]> {
  const q = encodeURIComponent(`topic:${topic}`);
  const url = `${API}/search/repositories?q=${q}&per_page=100&sort=stars&order=desc`;
  const data = await ghJson<{ items: SearchItem[] }>(url, token);
  return (data?.items ?? []).map(mapListing);
}

/**
 * A repo's product page: header, README, and latest-release facts. `installable`
 * is the current-release marker — true only when the latest release ships a
 * `dcs-studio.toml` asset and the repo is not a library. The install PLAN
 * (parsing that manifest) is the install step; here `installs`/`dependencies`/
 * `requires` are left empty.
 */
async function loadProduct(owner: string, name: string, token: string | undefined): Promise<ProductDetail> {
  const repo = await ghJson<RepoJson>(`${API}/repos/${owner}/${name}`, token);
  if (!repo) throw new Error(`Repository ${owner}/${name} was not found.`);
  const readme = await ghText(`${API}/repos/${owner}/${name}/readme`, token);
  const release = await ghJson<ReleaseJson>(`${API}/repos/${owner}/${name}/releases/latest`, token);
  return mapProduct(repo, readme, release, owner);
}

/** `MarketplacePort` over GitHub REST; tokens come from the injected `AuthPort`. */
export class GithubMarketplace implements MarketplacePort {
  constructor(private readonly auth: AuthPort) {}

  async discover(topic: string): Promise<MarketListing[]> {
    return discover(topic, await this.auth.getToken(false));
  }

  async loadProduct(repo: string): Promise<ProductDetail> {
    const [owner, name] = repo.split("/");
    return loadProduct(owner, name, await this.auth.getToken(false));
  }
}
