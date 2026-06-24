//! studio::market — the Marketplace storefront's discovery (model
//! `model/studio/market.pds`, issue #10, discovery slice). A mod is any public
//! repo carrying the `dcs-studio` topic; the repo's other topics become the
//! listing's labels. A repo is listed whether or not it ships a `dcs-studio.toml`
//! — that manifest is only required to download/install (a later slice). Browsing
//! is sign-in gated: discovery is refused without a session, and every search
//! runs authenticated as the logged-in user (30/min, issue #11). Search is
//! rate-limited, so results are cached: a still-fresh cache serves without a
//! network call, and a failed/offline search falls back to the last cache. ureq
//! is blocking — callers run it off the UI thread.

use serde::{Deserialize, Serialize};

use crate::github_http::{self, API_BASE};
use dcs_studio_project::{DISCOVERY_TOPIC, LIBRARY_TOPIC, MANIFEST_FILE};

const SEARCH_URL: &str = "https://api.github.com/search/repositories";
/// How long a cache stays fresh enough to skip a live search (model
/// `CACHE_TTL_SECONDS`).
const CACHE_TTL_SECONDS: u64 = 900;
/// Cap on repos pulled from one search page (the API max is 100).
const SEARCH_PER_PAGE: u32 = 100;
/// Shown when discovery is attempted signed-out (the store is gated).
const SIGN_IN_REQUIRED: &str = "Sign in with GitHub to browse the Marketplace.";

/// A repository search hit (model `RepoRef`).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RepoRef {
    pub owner: String,
    pub name: String,
    pub description: String,
    pub html_url: String,
    pub avatar_url: String,
    pub stars: u64,
    pub topics: Vec<String>,
}

/// A store listing — a discovered mod (model `MarketListing`). `author` is the
/// repo owner; `labels` are the repo's topics minus the `dcs-studio` marker.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MarketListing {
    pub repo: String,
    pub name: String,
    pub author: String,
    pub description: String,
    pub labels: Vec<String>,
    pub repo_url: String,
    pub avatar_url: String,
    pub stars: u64,
    /// A dependency-only library (carries `dcs-studio-library`): "Add as
    /// dependency", never installable into DCS (issue #48).
    pub is_library: bool,
}

/// What the cache file holds: the listings + when they were fetched.
#[derive(Serialize, Deserialize)]
struct Cache {
    fetched_at: u64,
    listings: Vec<MarketListing>,
}

/// One release file with its byte size (model `ReleaseAsset`).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProductAsset {
    pub name: String,
    pub size: u64,
}

/// One `[[install]]` mapping from the mod's manifest (model `InstallEntry`).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct InstallEntry {
    pub source: String,
    pub dest: String,
}

/// One `[[dependencies]]` entry shown on the product page (model `Dependency`):
/// another Marketplace mod (`id` = `owner/name`) this one needs, its version
/// constraint, and whether it is optional.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProductDependency {
    pub id: String,
    pub name: String,
    pub version: String,
    pub optional: bool,
}

/// A mod's product page (model `ProductDetail`): repo header, README source,
/// the latest release's assets + total download size, and the install plan
/// parsed from the `dcs-studio.toml` release asset (`installable` only when that
/// asset is present and parses).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProductDetail {
    pub repo: String,
    pub name: String,
    pub author: String,
    pub description: String,
    pub repo_url: String,
    pub avatar_url: String,
    pub stars: u64,
    pub readme: Option<String>,
    pub release_tag: Option<String>,
    pub release_url: Option<String>,
    pub assets: Vec<ProductAsset>,
    pub download_size: u64,
    pub installable: bool,
    pub installs: Vec<InstallEntry>,
    /// The mod's direct declared `[[dependencies]]` (other Marketplace mods);
    /// the full transitive set is resolved at install time, not here.
    pub dependencies: Vec<ProductDependency>,
    /// A dependency-only library (issue #48): forced non-installable; the product
    /// page offers "Add as dependency" instead of Install.
    pub is_library: bool,
}

/// A repo's latest release, internal to assembly (`manifest_url` is the
/// `dcs-studio.toml` asset's download URL when present).
struct LatestRelease {
    tag: String,
    html_url: String,
    assets: Vec<ProductAsset>,
    manifest_url: Option<String>,
}

/// Public repos carrying `topic`, authenticated as the logged-in user (model
/// `GitHubRest.SearchReposByTopic`): `GET /search/repositories?q=topic:<topic>`.
pub fn search_repos_by_topic(topic: &str, token: &str) -> Result<Vec<RepoRef>, String> {
    #[derive(Deserialize)]
    struct Resp {
        items: Vec<Item>,
    }
    #[derive(Deserialize)]
    struct Item {
        name: String,
        #[serde(default)]
        description: Option<String>,
        html_url: String,
        owner: Owner,
        #[serde(default)]
        stargazers_count: u64,
        #[serde(default)]
        topics: Vec<String>,
    }
    #[derive(Deserialize)]
    struct Owner {
        login: String,
        avatar_url: String,
    }
    let resp: Resp = github_http::get(SEARCH_URL, token)
        .set("Accept", github_http::ACCEPT_JSON)
        .query("q", &format!("topic:{topic}"))
        .query("per_page", &SEARCH_PER_PAGE.to_string())
        .query("sort", "stars")
        .call()
        .map_err(|e| format!("repo search failed: {e}"))?
        .into_json()
        .map_err(|e| format!("repo search response: {e}"))?;
    Ok(resp
        .items
        .into_iter()
        .map(|i| RepoRef {
            owner: i.owner.login,
            name: i.name,
            description: i.description.unwrap_or_default(),
            html_url: i.html_url,
            avatar_url: i.owner.avatar_url,
            stars: i.stargazers_count,
            topics: i.topics,
        })
        .collect())
}

/// Map a search hit to a store listing: author = owner, labels = the repo's
/// topics minus the `dcs-studio` marker (model `Registry.BuildListings`).
fn listing_from(repo: RepoRef) -> MarketListing {
    let is_library = repo.topics.iter().any(|t| t == LIBRARY_TOPIC);
    // The two marker topics drive behaviour, not labels — keep both out.
    let labels = repo
        .topics
        .iter()
        .filter(|t| t.as_str() != DISCOVERY_TOPIC && t.as_str() != LIBRARY_TOPIC)
        .cloned()
        .collect();
    MarketListing {
        repo: format!("{}/{}", repo.owner, repo.name),
        name: repo.name,
        author: repo.owner,
        description: repo.description,
        labels,
        repo_url: repo.html_url,
        avatar_url: repo.avatar_url,
        stars: repo.stars,
        is_library,
    }
}

/// Map every search hit to a listing (model `Registry.BuildListings`).
pub fn build_listings(repos: Vec<RepoRef>) -> Vec<MarketListing> {
    repos.into_iter().map(listing_from).collect()
}

/// Discover mods for the store (model `Registry.Discover`). Browsing requires a
/// GitHub sign-in: with no token the discovery is refused. Otherwise a still-fresh
/// cache is served without a network call (unless `force`), else the `dcs-studio`
/// topic is searched as the logged-in user and each hit mapped to a listing. A
/// failed/offline search falls back to the last cache; an empty cache surfaces
/// the error.
pub fn discover(force: bool) -> Result<Vec<MarketListing>, String> {
    discover_with(crate::github::current_token().as_deref(), force)
}

/// The testable core of [`discover`]: the session token is injected rather than
/// read from the keyring, so the gate + cache-fallback logic is unit-testable.
fn discover_with(token: Option<&str>, force: bool) -> Result<Vec<MarketListing>, String> {
    let Some(token) = token else {
        return Err(SIGN_IN_REQUIRED.to_string());
    };
    if let Some(fresh) = fresh_cache(force) {
        return Ok(fresh);
    }
    match search_repos_by_topic(DISCOVERY_TOPIC, token) {
        Ok(repos) => {
            let listings = build_listings(repos);
            save_cache(&listings);
            Ok(listings)
        }
        // Rate-limited or offline: the last cache beats a dead store.
        Err(e) => fall_back_to_cache(&e),
    }
}

// --- product page: repo header + README + release + install plan -----------

/// One repo's metadata for the product header (model `GitHubRest.GetRepo`):
/// `GET /repos/{owner}/{name}`.
pub fn get_repo(owner: &str, name: &str, token: &str) -> Result<RepoRef, String> {
    #[derive(Deserialize)]
    struct Resp {
        name: String,
        #[serde(default)]
        description: Option<String>,
        html_url: String,
        owner: Owner,
        #[serde(default)]
        stargazers_count: u64,
        #[serde(default)]
        topics: Vec<String>,
    }
    #[derive(Deserialize)]
    struct Owner {
        login: String,
        avatar_url: String,
    }
    let url = format!("{API_BASE}/repos/{owner}/{name}");
    let resp: Resp = github_http::get(&url, token)
        .set("Accept", github_http::ACCEPT_JSON)
        .call()
        .map_err(|e| format!("repo fetch failed: {e}"))?
        .into_json()
        .map_err(|e| format!("repo response: {e}"))?;
    Ok(RepoRef {
        owner: resp.owner.login,
        name: resp.name,
        description: resp.description.unwrap_or_default(),
        html_url: resp.html_url,
        avatar_url: resp.owner.avatar_url,
        stars: resp.stargazers_count,
        topics: resp.topics,
    })
}

/// A repo's README source, or `None` when it has none (model
/// `GitHubRest.GetReadme`): `GET /repos/{owner}/{name}/readme` (raw media type).
pub fn get_readme(owner: &str, name: &str, token: &str) -> Result<Option<String>, String> {
    let url = format!("{API_BASE}/repos/{owner}/{name}/readme");
    let result = github_http::get(&url, token)
        .set("Accept", "application/vnd.github.raw")
        .call();
    match result {
        Ok(r) => r
            .into_string()
            .map(Some)
            .map_err(|e| format!("readme read failed: {e}")),
        Err(ureq::Error::Status(404, _)) => Ok(None),
        Err(e) => Err(format!("readme fetch failed: {e}")),
    }
}

/// The repo's latest release (assets + the manifest asset URL), or `None` when it
/// has no release (model `GitHubRest.GetLatestRelease`):
/// `GET /repos/{owner}/{name}/releases/latest`.
fn get_latest_release(owner: &str, name: &str, token: &str) -> Result<Option<LatestRelease>, String> {
    #[derive(Deserialize)]
    struct Resp {
        tag_name: String,
        html_url: String,
        #[serde(default)]
        assets: Vec<Asset>,
    }
    #[derive(Deserialize)]
    struct Asset {
        name: String,
        #[serde(default)]
        size: u64,
        browser_download_url: String,
    }
    let url = format!("{API_BASE}/repos/{owner}/{name}/releases/latest");
    let result = github_http::get(&url, token)
        .set("Accept", github_http::ACCEPT_JSON)
        .call();
    let resp: Resp = match result {
        Ok(r) => r.into_json().map_err(|e| format!("release response: {e}"))?,
        Err(ureq::Error::Status(404, _)) => return Ok(None),
        Err(e) => return Err(format!("latest-release request failed: {e}")),
    };
    let manifest_url = resp
        .assets
        .iter()
        .find(|a| a.name == MANIFEST_FILE)
        .map(|a| a.browser_download_url.clone());
    Ok(Some(LatestRelease {
        tag: resp.tag_name,
        html_url: resp.html_url,
        assets: resp
            .assets
            .into_iter()
            .map(|a| ProductAsset {
                name: a.name,
                size: a.size,
            })
            .collect(),
        manifest_url,
    }))
}

/// The text of a release asset by its download URL (model
/// `GitHubRest.FetchAssetText`).
fn fetch_asset_text(url: &str, token: &str) -> Result<String, String> {
    github_http::get(url, token)
        .call()
        .map_err(|e| format!("asset download failed: {e}"))?
        .into_string()
        .map_err(|e| format!("asset read failed: {e}"))
}

/// Assemble the product from its parts (pure): sum the asset sizes, and when a
/// manifest text is present and parses, derive the install plan (source → dest)
/// and mark it installable. A repo without a release/manifest still yields a
/// product — just not installable.
fn assemble_product(
    repo: RepoRef,
    readme: Option<String>,
    release: Option<LatestRelease>,
    manifest_text: Option<String>,
) -> ProductDetail {
    let manifest = manifest_text
        .as_deref()
        .and_then(|t| dcs_studio_project::manifest::parse(t).ok());
    let is_library = repo.topics.iter().any(|t| t == LIBRARY_TOPIC);
    // A library is NEVER installable into DCS, regardless of a manifest asset
    // (issue #48): you bundle it as a dependency, not install it into the sim.
    let installable = manifest.is_some() && !is_library;
    let (installs, dependencies) = match manifest {
        Some(m) => (
            m.install
                .into_iter()
                .map(|r| InstallEntry {
                    source: r.source,
                    dest: r.dest,
                })
                .collect(),
            m.dependencies
                .into_iter()
                .map(|d| ProductDependency {
                    id: d.id,
                    name: d.name,
                    version: d.version,
                    optional: d.optional,
                })
                .collect(),
        ),
        None => (Vec::new(), Vec::new()),
    };
    let (release_tag, release_url, assets, download_size) = match release {
        Some(r) => {
            let total = r.assets.iter().map(|a| a.size).sum();
            (Some(r.tag), Some(r.html_url), r.assets, total)
        }
        None => (None, None, Vec::new(), 0),
    };
    ProductDetail {
        repo: format!("{}/{}", repo.owner, repo.name),
        name: repo.name,
        author: repo.owner,
        description: repo.description,
        repo_url: repo.html_url,
        avatar_url: repo.avatar_url,
        stars: repo.stars,
        readme,
        release_tag,
        release_url,
        assets,
        download_size,
        installable,
        installs,
        dependencies,
        is_library,
    }
}

/// Build a mod's product (model `Registry.BuildProduct`): fetch the repo, README
/// (best-effort — a README error degrades to none), and latest release; fetch +
/// parse the `dcs-studio.toml` asset when present; assemble.
fn build_product(owner: &str, name: &str, token: &str) -> Result<ProductDetail, String> {
    let repo = get_repo(owner, name, token)?;
    let readme = get_readme(owner, name, token).ok().flatten();
    let release = get_latest_release(owner, name, token)?;
    let manifest_text = release
        .as_ref()
        .and_then(|r| r.manifest_url.as_deref())
        .and_then(|url| fetch_asset_text(url, token).ok());
    Ok(assemble_product(repo, readme, release, manifest_text))
}

/// Load one mod's product page (model `Registry.LoadProduct`). Sign-in gated like
/// the store: refused without a token, otherwise built as the logged-in user.
pub fn load_product(owner: &str, name: &str) -> Result<ProductDetail, String> {
    load_product_with(crate::github::current_token().as_deref(), owner, name)
}

/// The testable core of [`load_product`]: the session token is injected.
fn load_product_with(token: Option<&str>, owner: &str, name: &str) -> Result<ProductDetail, String> {
    let Some(token) = token else {
        return Err(SIGN_IN_REQUIRED.to_string());
    };
    build_product(owner, name, token)
}

// --- cache: a JSON file under the temp dir (plumbing for the model's fresh /
// fallback cache decisions) -------------------------------------------------

fn cache_path() -> std::path::PathBuf {
    std::env::temp_dir().join("dcs-studio-market-cache.json")
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn read_cache() -> Option<Cache> {
    let text = std::fs::read_to_string(cache_path()).ok()?;
    serde_json::from_str(&text).ok()
}

/// Whether a cache fetched at `fetched_at` is still fresh at `now` (pure).
fn is_fresh(fetched_at: u64, now: u64) -> bool {
    now.saturating_sub(fetched_at) < CACHE_TTL_SECONDS
}

/// The cached listings when within `CACHE_TTL_SECONDS` and `force` is false
/// (model `Registry.FreshCache`).
fn fresh_cache(force: bool) -> Option<Vec<MarketListing>> {
    if force {
        return None;
    }
    let cache = read_cache()?;
    is_fresh(cache.fetched_at, now_secs()).then_some(cache.listings)
}

fn save_cache(listings: &[MarketListing]) {
    let cache = Cache {
        fetched_at: now_secs(),
        listings: listings.to_vec(),
    };
    if let Ok(text) = serde_json::to_string(&cache) {
        let _ = std::fs::write(cache_path(), text);
    }
}

/// Serve the last cached listings (any age) when a live search fails; surface
/// `error` only when the cache is empty too (model `Registry.FallBackToCache`).
fn fall_back_to_cache(error: &str) -> Result<Vec<MarketListing>, String> {
    match read_cache() {
        Some(cache) => Ok(cache.listings),
        None => Err(error.to_string()),
    }
}

// --- install: the engine lives in the `library` submodule (model studio::market
// `Library`); these are its public entry points. The discovery slice above
// (search, product, cache) stays in this module. The dependency walk
// (`Library.ResolvePlan`) is the `resolve` submodule. -------------------------
mod library;
mod resolve;
pub use library::{InstallOutcome, UninstallOutcome, install, installed_ids, uninstall};

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(owner: &str, name: &str, topics: &[&str]) -> RepoRef {
        RepoRef {
            owner: owner.to_string(),
            name: name.to_string(),
            description: "a mod".to_string(),
            html_url: format!("https://github.com/{owner}/{name}"),
            avatar_url: "https://avatars.invalid/u".to_string(),
            stars: 7,
            topics: topics.iter().map(|t| (*t).to_string()).collect(),
        }
    }

    #[test]
    fn the_sign_in_gate_is_testable_without_the_keyring() {
        // The `*_with` cores take the session token, so the sign-in gate is
        // exercised without touching the global keyring (discovery + product;
        // the install gate is covered in the `library` submodule).
        assert_eq!(discover_with(None, false).unwrap_err(), SIGN_IN_REQUIRED);
        assert_eq!(
            load_product_with(None, "octocat", "cool-mod").unwrap_err(),
            SIGN_IN_REQUIRED
        );
    }

    #[test]
    fn listing_carries_other_topics_as_labels_and_drops_the_marker() {
        let listing = listing_from(repo("octocat", "cool-mod", &["dcs-studio", "scripting", "a-10"]));
        assert_eq!(listing.repo, "octocat/cool-mod");
        assert_eq!(listing.name, "cool-mod");
        assert_eq!(listing.author, "octocat");
        assert_eq!(listing.stars, 7);
        // The `dcs-studio` marker is filtered out; the rest are labels.
        assert_eq!(listing.labels, vec!["scripting".to_string(), "a-10".to_string()]);
    }

    #[test]
    fn a_repo_with_only_the_marker_topic_lists_with_no_labels() {
        // Listed regardless of a manifest — installability is resolved later.
        let listing = listing_from(repo("octocat", "bare-mod", &["dcs-studio"]));
        assert_eq!(listing.repo, "octocat/bare-mod");
        assert!(listing.labels.is_empty());
    }

    #[test]
    fn cache_freshness_respects_the_ttl() {
        assert!(is_fresh(1000, 1000), "same instant is fresh");
        assert!(is_fresh(1000, 1000 + CACHE_TTL_SECONDS - 1), "within TTL");
        assert!(!is_fresh(1000, 1000 + CACHE_TTL_SECONDS), "exactly TTL is stale");
        assert!(!is_fresh(1000, 9_999_999), "ancient is stale");
        // A clock skew (now < fetched_at) saturates to 0 → treated as fresh.
        assert!(is_fresh(5000, 1000));
    }

    #[test]
    fn build_listings_maps_every_hit() {
        let repos = vec![
            repo("a", "one", &["dcs-studio", "x"]),
            repo("b", "two", &["dcs-studio"]),
        ];
        let listings = build_listings(repos);
        assert_eq!(listings.len(), 2);
        assert_eq!(listings[0].labels, vec!["x".to_string()]);
    }

    #[test]
    fn product_with_manifest_is_installable_and_sums_asset_sizes() {
        let release = LatestRelease {
            tag: "v2.0.0".to_string(),
            html_url: "https://github.com/octocat/cool-mod/releases/latest".to_string(),
            assets: vec![
                ProductAsset { name: "mod.zip".to_string(), size: 1000 },
                ProductAsset { name: "dcs-studio.toml".to_string(), size: 200 },
            ],
            manifest_url: Some("https://example.invalid/dcs-studio.toml".to_string()),
        };
        let manifest = "[project]\nname = \"Cool\"\n\n[[install]]\nsource = \"dist\"\ndest = \"{SavedGames}/Scripts/cool\"\n\n[[dependencies]]\nid = \"flying-dice/base\"\nname = \"Base\"\nversion = \"^1.0\"\n";
        let p = assemble_product(
            repo("octocat", "cool-mod", &["dcs-studio"]),
            Some("# Cool".to_string()),
            Some(release),
            Some(manifest.to_string()),
        );
        assert!(p.installable);
        assert_eq!(p.installs.len(), 1);
        assert_eq!(p.installs[0].source, "dist");
        assert_eq!(p.installs[0].dest, "{SavedGames}/Scripts/cool");
        // The product page surfaces the mod's direct declared dependencies.
        assert_eq!(p.dependencies.len(), 1);
        assert_eq!(p.dependencies[0].id, "flying-dice/base");
        assert_eq!(p.dependencies[0].version, "^1.0");
        assert_eq!(p.download_size, 1200, "summed asset bytes");
        assert_eq!(p.release_tag.as_deref(), Some("v2.0.0"));
        assert_eq!(p.readme.as_deref(), Some("# Cool"));
    }

    #[test]
    fn product_without_manifest_is_not_installable() {
        // A tagged repo with no release/manifest still yields a product page.
        let p = assemble_product(repo("octocat", "bare-mod", &["dcs-studio"]), None, None, None);
        assert!(!p.installable);
        assert!(p.installs.is_empty());
        assert_eq!(p.download_size, 0);
        assert_eq!(p.release_tag, None);
        assert_eq!(p.repo, "octocat/bare-mod");
    }

    #[test]
    fn library_listing_is_marked_and_the_library_topic_is_not_a_label() {
        let listing =
            listing_from(repo("flying-dice", "mylib", &["dcs-studio", "dcs-studio-library", "util"]));
        assert!(listing.is_library, "carries the library topic");
        // Both marker topics are filtered out; only real topics are labels.
        assert_eq!(listing.labels, vec!["util".to_string()]);
    }

    #[test]
    fn library_product_is_forced_non_installable_even_with_a_manifest() {
        let release = LatestRelease {
            tag: "10.0.0".to_string(),
            html_url: "https://github.com/flying-dice/mylib/releases/latest".to_string(),
            assets: vec![ProductAsset { name: "dcs-studio.toml".to_string(), size: 200 }],
            manifest_url: Some("https://example.invalid/dcs-studio.toml".to_string()),
        };
        let manifest = "[project]\nname = \"Lib\"\n\n[[install]]\nsource = \"a\"\ndest = \"{SavedGames}/Scripts/a\"\n";
        let p = assemble_product(
            repo("flying-dice", "mylib", &["dcs-studio", "dcs-studio-library"]),
            None,
            Some(release),
            Some(manifest.to_string()),
        );
        assert!(p.is_library, "flagged a library");
        assert!(!p.installable, "a library is never installable, manifest asset notwithstanding");
    }
}
