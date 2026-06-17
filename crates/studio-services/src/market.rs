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

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const SEARCH_URL: &str = "https://api.github.com/search/repositories";
const API_BASE: &str = "https://api.github.com";
const USER_AGENT: &str = concat!("dcs-studio/", env!("CARGO_PKG_VERSION"));

/// The GitHub topic marking a repo as a dcs-studio mod (model `DISCOVERY_TOPIC`).
const DISCOVERY_TOPIC: &str = "dcs-studio";
/// The manifest filename that, when a release asset, makes a mod installable and
/// carries its install plan (model: the product's `dcs-studio.toml`).
const MANIFEST_ASSET: &str = "dcs-studio.toml";
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
    let resp: Resp = ureq::get(SEARCH_URL)
        .set("Accept", "application/vnd.github+json")
        .set("User-Agent", USER_AGENT)
        .set("Authorization", &format!("Bearer {token}"))
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
    let labels = repo
        .topics
        .iter()
        .filter(|t| t.as_str() != DISCOVERY_TOPIC)
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
    let Some(token) = crate::github::current_token() else {
        return Err(SIGN_IN_REQUIRED.to_string());
    };
    if let Some(fresh) = fresh_cache(force) {
        return Ok(fresh);
    }
    match search_repos_by_topic(DISCOVERY_TOPIC, &token) {
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
    let resp: Resp = ureq::get(&url)
        .set("Accept", "application/vnd.github+json")
        .set("User-Agent", USER_AGENT)
        .set("Authorization", &format!("Bearer {token}"))
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
    let result = ureq::get(&url)
        .set("Accept", "application/vnd.github.raw")
        .set("User-Agent", USER_AGENT)
        .set("Authorization", &format!("Bearer {token}"))
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
    let result = ureq::get(&url)
        .set("Accept", "application/vnd.github+json")
        .set("User-Agent", USER_AGENT)
        .set("Authorization", &format!("Bearer {token}"))
        .call();
    let resp: Resp = match result {
        Ok(r) => r.into_json().map_err(|e| format!("release response: {e}"))?,
        Err(ureq::Error::Status(404, _)) => return Ok(None),
        Err(e) => return Err(format!("latest-release request failed: {e}")),
    };
    let manifest_url = resp
        .assets
        .iter()
        .find(|a| a.name == MANIFEST_ASSET)
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
    ureq::get(url)
        .set("User-Agent", USER_AGENT)
        .set("Authorization", &format!("Bearer {token}"))
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
    let installable = manifest.is_some();
    let installs = manifest
        .map(|m| {
            m.install
                .into_iter()
                .map(|r| InstallEntry {
                    source: r.source,
                    dest: r.dest,
                })
                .collect()
        })
        .unwrap_or_default();
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
    let Some(token) = crate::github::current_token() else {
        return Err(SIGN_IN_REQUIRED.to_string());
    };
    build_product(owner, name, &token)
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

// --- install: download payload → unpack to content store → LINK into DCS roots
// (model studio::market `Library`) -----------------------------------------

/// Hard ceilings on the untrusted, unsigned third-party payload (any
/// topic-tagged public repo is one-click installable): cap the download and the
/// decompressed total so a malicious release can't exhaust RAM/disk (zip bomb).
const MAX_PAYLOAD_BYTES: u64 = 512 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES: u64 = 512 * 1024 * 1024;
const MAX_PAYLOAD_ENTRIES: usize = 20_000;

/// A what-was-installed record: the content store dir + the links placed.
#[derive(Clone, Serialize, Deserialize)]
struct InstalledEntry {
    store: String,
    links: Vec<String>,
}

/// The PERSISTENT per-user data dir for the content store + ledger — it backs
/// the links placed into the DCS roots, so it must survive a reboot (temp would
/// be cleared, dangling every installed link). Falls back to temp only if no
/// data dir resolves.
fn market_dir() -> PathBuf {
    dirs::data_dir()
        .map(|d| d.join("dcs-studio").join("market"))
        .unwrap_or_else(|| std::env::temp_dir().join("dcs-studio-market"))
}

fn store_dir(owner: &str, name: &str) -> PathBuf {
    market_dir().join(format!("{owner}__{name}"))
}

fn ledger_path() -> PathBuf {
    market_dir().join("installed.json")
}

fn read_ledger() -> HashMap<String, InstalledEntry> {
    std::fs::read_to_string(ledger_path())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn write_ledger(ledger: &HashMap<String, InstalledEntry>) {
    let _ = std::fs::create_dir_all(market_dir());
    if let Ok(text) = serde_json::to_string(ledger) {
        let _ = std::fs::write(ledger_path(), text);
    }
}

/// The DCS destination roots — Saved Games\DCS (GameInstall is left unconfigured;
/// a `{GameInstall}` rule then fails the guard rather than installing wrong).
fn resolve_roots() -> Result<dcs_studio_project::RootMap, String> {
    let saved_games = dcs_studio_project::detect::default_saved_games()
        .ok_or_else(|| "couldn't find your Saved Games\\DCS folder".to_string())?;
    Ok(dcs_studio_project::RootMap {
        saved_games,
        game_install: None,
    })
}

/// The download URL of the payload the publish side wrote — the asset named
/// `dcs-studio-<name>-<tag>.zip` (see publish.rs `package_payload`). Matched by
/// that exact `dcs-studio-<name>-` prefix so an unrelated `.zip` on the release
/// can't be installed by mistake (publish + install agree on the artifact).
fn find_payload_asset(owner: &str, name: &str, token: &str) -> Result<String, String> {
    #[derive(Deserialize)]
    struct Resp {
        #[serde(default)]
        assets: Vec<Asset>,
    }
    #[derive(Deserialize)]
    struct Asset {
        name: String,
        browser_download_url: String,
    }
    let url = format!("{API_BASE}/repos/{owner}/{name}/releases/latest");
    let resp: Resp = ureq::get(&url)
        .set("Accept", "application/vnd.github+json")
        .set("User-Agent", USER_AGENT)
        .set("Authorization", &format!("Bearer {token}"))
        .call()
        .map_err(|e| format!("latest-release request failed: {e}"))?
        .into_json()
        .map_err(|e| format!("latest-release response: {e}"))?;
    let prefix = format!("dcs-studio-{name}-");
    resp.assets
        .into_iter()
        .find(|a| a.name.starts_with(&prefix) && a.name.ends_with(".zip"))
        .map(|a| a.browser_download_url)
        .ok_or_else(|| {
            format!("this release has no `{prefix}*.zip` payload (re-publish the release from DCS Studio)")
        })
}

/// Download the payload, capped: reject an oversized Content-Length up front and
/// hard-stop the stream past `MAX_PAYLOAD_BYTES` so an unsigned third-party asset
/// can't exhaust memory.
fn fetch_asset_bytes(url: &str, token: &str) -> Result<Vec<u8>, String> {
    use std::io::Read as _;
    let resp = ureq::get(url)
        .set("User-Agent", USER_AGENT)
        .set("Authorization", &format!("Bearer {token}"))
        .call()
        .map_err(|e| format!("payload download failed: {e}"))?;
    if let Some(len) = resp.header("Content-Length").and_then(|l| l.parse::<u64>().ok()) {
        if len > MAX_PAYLOAD_BYTES {
            return Err("payload is too large to install".to_string());
        }
    }
    let mut buf = Vec::new();
    resp.into_reader()
        .take(MAX_PAYLOAD_BYTES + 1)
        .read_to_end(&mut buf)
        .map_err(|e| format!("payload read failed: {e}"))?;
    if buf.len() as u64 > MAX_PAYLOAD_BYTES {
        return Err("payload exceeds the size limit".to_string());
    }
    Ok(buf)
}

/// Replace `store` with the unpacked archive (a project-shaped tree), capped by
/// entry-count (`max_entries`) and a running budget of ACTUAL decompressed bytes
/// (`max_uncompressed`), and confined to `store` via `enclosed_name` (Zip-Slip
/// guard). The byte cap is on real output, not the archive's DECLARED
/// `uncompressed_size` header (which zip does not enforce) — so a lying-header
/// zip bomb that declares a tiny size is still stopped at the budget.
fn unpack(
    bytes: &[u8],
    store: &Path,
    max_uncompressed: u64,
    max_entries: usize,
) -> Result<(), String> {
    use std::io::Read as _;
    let _ = std::fs::remove_dir_all(store);
    std::fs::create_dir_all(store).map_err(|e| format!("create store: {e}"))?;
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|e| format!("open payload: {e}"))?;
    if archive.len() > max_entries {
        return Err("payload has too many files to install".to_string());
    }
    let mut budget = max_uncompressed;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("payload entry: {e}"))?;
        // Zip-Slip guard: skip any entry whose name escapes the store.
        let Some(rel) = entry.enclosed_name() else {
            continue;
        };
        let out = store.join(rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| format!("unpack dir: {e}"))?;
        } else {
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("unpack parent: {e}"))?;
            }
            let mut file = std::fs::File::create(&out).map_err(|e| format!("unpack file: {e}"))?;
            // Cap on ACTUAL bytes: read at most budget+1 so an oversize entry
            // (honest OR lying-header) trips the check rather than being written.
            let mut limited = entry.by_ref().take(budget + 1);
            let written = std::io::copy(&mut limited, &mut file)
                .map_err(|e| format!("unpack write: {e}"))?;
            if written > budget {
                return Err("payload is too large when decompressed".to_string());
            }
            budget -= written;
        }
    }
    Ok(())
}

/// Link each `[[install]]` rule's resolved dest to its store source (never copy).
/// Returns the placed link paths (for the ledger / uninstall). On the first
/// failure, the links placed so far are rolled back so a half-install leaves
/// nothing behind.
fn deploy_links(store: &Path, roots: &dcs_studio_project::RootMap) -> Result<Vec<String>, String> {
    let manifest = dcs_studio_project::manifest::load(store)?;
    if manifest.install.is_empty() {
        return Err("the mod declares no [[install]] rules — nothing to install".to_string());
    }
    let mut placed: Vec<String> = Vec::new();
    for rule in &manifest.install {
        // SECURITY: `rule.source` comes from the untrusted downloaded manifest.
        // It must stay under the content store — otherwise a malicious mod could
        // link a DCS dest to an arbitrary path on disk. Mirrors the trusted
        // installer's source guard (install.rs).
        if !dcs_studio_project::install::stays_under(&rule.source) {
            rollback(&placed);
            return Err(format!(
                "install source '{}' escapes the package — refusing",
                rule.source
            ));
        }
        let source = store.join(&rule.source);
        if !source.exists() {
            rollback(&placed);
            return Err(format!("payload is missing install source: {}", rule.source));
        }
        // The studio::installer guard: dest must resolve under a whitelisted root.
        let dest = match dcs_studio_project::install::resolve_dest(&rule.dest, roots) {
            Ok(d) => d,
            Err(e) => {
                rollback(&placed);
                return Err(e);
            }
        };
        if let Err(e) = crate::linker::link(&dest, &source) {
            rollback(&placed);
            return Err(e);
        }
        placed.push(dest.to_string_lossy().to_string());
    }
    Ok(placed)
}

fn rollback(links: &[String]) {
    for l in links {
        let _ = crate::linker::unlink(Path::new(l));
    }
}

/// Install a discovered mod (model `Library.Install`): sign-in gated; download
/// the payload, unpack to the content store, link each dest, record the ledger.
pub fn install(owner: &str, name: &str) -> Result<dcs_studio_project::InstallReport, String> {
    let Some(token) = crate::github::current_token() else {
        return Err(SIGN_IN_REQUIRED.to_string());
    };
    let roots = resolve_roots()?;
    let payload_url = find_payload_asset(owner, name, &token)?;
    let bytes = fetch_asset_bytes(&payload_url, &token)?;
    let store = store_dir(owner, name);
    unpack(&bytes, &store, MAX_UNCOMPRESSED_BYTES, MAX_PAYLOAD_ENTRIES)?;
    let links = deploy_links(&store, &roots)?;

    let mut ledger = read_ledger();
    ledger.insert(
        format!("{owner}/{name}"),
        InstalledEntry {
            store: store.to_string_lossy().to_string(),
            links: links.clone(),
        },
    );
    write_ledger(&ledger);
    Ok(dcs_studio_project::InstallReport {
        copied: links.len(),
        files: links,
    })
}

/// Uninstall a mod (model `Library.Uninstall`): remove every link it placed
/// (never following them into the target), then drop the store + ledger entry.
pub fn uninstall(id: &str) -> Result<(), String> {
    let mut ledger = read_ledger();
    let entry = ledger
        .get(id)
        .cloned()
        .ok_or_else(|| format!("{id} is not installed"))?;
    for link in &entry.links {
        crate::linker::unlink(Path::new(link))?;
    }
    let _ = std::fs::remove_dir_all(&entry.store);
    ledger.remove(id);
    write_ledger(&ledger);
    Ok(())
}

/// The ids (`owner/name`) of installed mods (model `Library.InstalledIds`).
#[must_use]
pub fn installed_ids() -> Vec<String> {
    let mut ids: Vec<String> = read_ledger().into_keys().collect();
    ids.sort();
    ids
}

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
        let manifest = "[project]\nname = \"Cool\"\n\n[[install]]\nsource = \"dist\"\ndest = \"{SavedGames}/Scripts/cool\"\n";
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
    fn deploy_links_refuses_a_source_escaping_the_payload() {
        // A malicious downloaded manifest must not link a DCS dest to a path
        // outside the content store (the security regression from review).
        let base = std::env::temp_dir().join(format!("dcs-market-sec-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let store = base.join("store");
        let saved = base.join("saved");
        std::fs::create_dir_all(&store).unwrap();
        std::fs::create_dir_all(&saved).unwrap();
        std::fs::write(base.join("secret.txt"), b"top secret").unwrap();
        std::fs::write(
            store.join("dcs-studio.toml"),
            "[project]\nname = \"evil\"\n\n[[install]]\nsource = \"../secret.txt\"\ndest = \"{SavedGames}/pwned\"\n",
        )
        .unwrap();
        let roots = dcs_studio_project::RootMap {
            saved_games: saved.clone(),
            game_install: None,
        };

        let result = deploy_links(&store, &roots);

        assert!(result.is_err(), "an escaping source must be refused");
        assert!(!saved.join("pwned").exists(), "nothing planted in the DCS root");
        let _ = std::fs::remove_dir_all(&base);
    }

    fn crc32(data: &[u8]) -> u32 {
        let mut crc = !0u32;
        for &byte in data {
            crc ^= u32::from(byte);
            for _ in 0..8 {
                crc = if crc & 1 != 0 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
            }
        }
        !crc
    }

    /// A single STORED entry whose declared `uncompressed_size` is a LIE
    /// (`forged`) while the real data is `data` — what an honest zip writer can't
    /// produce. Mirrors the review PoC.
    fn forged_zip(name: &str, data: &[u8], forged_uncompressed: u32) -> Vec<u8> {
        let crc = crc32(data);
        let csize = data.len() as u32;
        let nlen = name.len() as u16;
        let mut z = Vec::new();
        // local file header
        z.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        z.extend_from_slice(&20u16.to_le_bytes());
        z.extend_from_slice(&0u16.to_le_bytes());
        z.extend_from_slice(&0u16.to_le_bytes()); // method: STORED
        z.extend_from_slice(&0u16.to_le_bytes());
        z.extend_from_slice(&0u16.to_le_bytes());
        z.extend_from_slice(&crc.to_le_bytes());
        z.extend_from_slice(&csize.to_le_bytes());
        z.extend_from_slice(&forged_uncompressed.to_le_bytes()); // the lie
        z.extend_from_slice(&nlen.to_le_bytes());
        z.extend_from_slice(&0u16.to_le_bytes());
        z.extend_from_slice(name.as_bytes());
        z.extend_from_slice(data);
        let cd_off = z.len() as u32;
        // central directory header
        z.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        z.extend_from_slice(&20u16.to_le_bytes());
        z.extend_from_slice(&20u16.to_le_bytes());
        z.extend_from_slice(&0u16.to_le_bytes());
        z.extend_from_slice(&0u16.to_le_bytes()); // STORED
        z.extend_from_slice(&0u16.to_le_bytes());
        z.extend_from_slice(&0u16.to_le_bytes());
        z.extend_from_slice(&crc.to_le_bytes());
        z.extend_from_slice(&csize.to_le_bytes());
        z.extend_from_slice(&forged_uncompressed.to_le_bytes()); // the lie
        z.extend_from_slice(&nlen.to_le_bytes());
        z.extend_from_slice(&0u16.to_le_bytes());
        z.extend_from_slice(&0u16.to_le_bytes());
        z.extend_from_slice(&0u16.to_le_bytes());
        z.extend_from_slice(&0u16.to_le_bytes());
        z.extend_from_slice(&0u32.to_le_bytes());
        z.extend_from_slice(&0u32.to_le_bytes()); // local header offset
        z.extend_from_slice(name.as_bytes());
        let cd_size = z.len() as u32 - cd_off;
        // end of central directory
        z.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        z.extend_from_slice(&0u16.to_le_bytes());
        z.extend_from_slice(&0u16.to_le_bytes());
        z.extend_from_slice(&1u16.to_le_bytes());
        z.extend_from_slice(&1u16.to_le_bytes());
        z.extend_from_slice(&cd_size.to_le_bytes());
        z.extend_from_slice(&cd_off.to_le_bytes());
        z.extend_from_slice(&0u16.to_le_bytes());
        z
    }

    #[test]
    fn unpack_caps_actual_bytes_against_a_lying_uncompressed_header() {
        // 4 KiB of real data, but the header DECLARES uncompressed_size = 0.
        let data = vec![b'A'; 4096];
        let zip = forged_zip("big.bin", &data, 0);
        let store = std::env::temp_dir().join(format!("dcs-bomb-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&store);

        // A tiny 1 KiB budget: the real 4 KiB output must trip it despite the lie.
        let result = unpack(&zip, &store, 1024, 100);

        assert!(result.is_err(), "lying-header bomb must be rejected on actual bytes");
        let _ = std::fs::remove_dir_all(&store);
    }

    #[test]
    fn unpack_accepts_a_payload_within_budget() {
        let data = b"hello world";
        let zip = forged_zip("ok.txt", data, data.len() as u32);
        let store = std::env::temp_dir().join(format!("dcs-ok-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&store);

        unpack(&zip, &store, 1024, 100).expect("a small honest payload unpacks");
        assert_eq!(std::fs::read(store.join("ok.txt")).unwrap(), data);
        let _ = std::fs::remove_dir_all(&store);
    }
}
