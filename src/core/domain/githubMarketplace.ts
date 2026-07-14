// Pure GitHub-marketplace mapping + policy. Everything here maps GitHub REST JSON
// shapes into the core marketplace domain types, decides installability, sums the
// download size, filters marker topics into labels, and maps a failed response's
// (status, detail) into a user-actionable message. NO HTTP, NO auth, NO I/O — the
// adapter (`adapters/github/marketplace.ts`) does the fetching and hands these
// functions the parsed JSON.

import type { MarketListing, ProductAsset, ProductDetail } from "./types";

// Marker topic + manifest file — the constants dcs-studio-project exports.
export const DISCOVERY_TOPIC = "dcs-studio";
export const MANIFEST_FILE = "dcs-studio.toml";

/** A repo item in the search-repositories response. */
export interface SearchItem {
  full_name: string;
  name: string;
  description: string | null;
  html_url: string;
  stargazers_count: number;
  topics?: string[];
  owner: { login: string; avatar_url: string };
}

/** The repo response (product header). */
export interface RepoJson {
  full_name: string;
  name: string;
  description: string | null;
  html_url: string;
  stargazers_count: number;
  topics?: string[];
  owner: { login: string; avatar_url: string };
}

/** The latest-release response. */
export interface ReleaseJson {
  tag_name: string;
  html_url: string;
  /** ISO-8601 publish time — a trust signal (recency) on the same payload. */
  published_at?: string | null;
  assets: Array<{ name: string; size: number; browser_download_url: string }>;
}

/** Topics minus the marker topic — the listing's display labels. */
export function labelsFrom(topics: string[]): string[] {
  return topics.filter((t) => t !== DISCOVERY_TOPIC);
}

/** Map one search item to a marketplace listing. */
export function mapListing(it: SearchItem): MarketListing {
  const topics = it.topics ?? [];
  return {
    repo: it.full_name,
    name: it.name,
    author: it.owner?.login ?? "",
    description: it.description ?? "",
    labels: labelsFrom(topics),
    repo_url: it.html_url,
    avatar_url: it.owner?.avatar_url ?? "",
    stars: it.stargazers_count ?? 0,
  };
}

/** Map a release's assets (or none) to product assets. */
export function mapAssets(release: ReleaseJson | null): ProductAsset[] {
  return (release?.assets ?? []).map((a) => ({ name: a.name, size: a.size, url: a.browser_download_url }));
}

/**
 * Map a repo + README + latest release into the product page. `installable` is the
 * current-release marker: true only when the latest release ships a
 * `dcs-studio.toml` asset. The install PLAN (parsing that manifest) is a later
 * step, so installs/requires are left empty here.
 */
export function mapProduct(
  repo: RepoJson,
  readme: string | null,
  release: ReleaseJson | null,
  ownerFallback: string,
): ProductDetail {
  const assets = mapAssets(release);
  const hasManifest = assets.some((a) => a.name === MANIFEST_FILE);
  return {
    repo: repo.full_name,
    name: repo.name,
    author: repo.owner?.login ?? ownerFallback,
    description: repo.description ?? "",
    repo_url: repo.html_url,
    avatar_url: repo.owner?.avatar_url ?? "",
    stars: repo.stargazers_count ?? 0,
    readme,
    release_tag: release?.tag_name ?? null,
    release_url: release?.html_url ?? null,
    release_date: release?.published_at ?? null,
    assets,
    download_size: assets.reduce((s, a) => s + a.size, 0),
    installable: hasManifest,
    installs: [],
    requires: [],
  };
}

/** Map a failed GitHub response's (status, detail) to a user-actionable message. */
export function ghErrorMessage(status: number, detail: string): string {
  if (status === 403 && /rate limit/i.test(detail)) {
    return "GitHub rate limit reached. Sign in to raise the limit, or wait a minute.";
  }
  return `GitHub ${status}: ${detail}`;
}
