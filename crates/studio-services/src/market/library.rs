//! studio::market::library — the install/uninstall engine behind the Marketplace
//! (model studio::market `Library`, issue #10), split out of the discovery slice
//! (`super`). Download the release payload → unpack it (capped, Zip-Slip- and
//! zip-bomb-guarded) into a PERSISTENT content store → LINK each `[[install]]`
//! dest into the DCS roots (never copy) → record a ledger so uninstall can undo
//! exactly what was placed. The sign-in gate is shared with discovery
//! (`super::SIGN_IN_REQUIRED`); the GitHub REST calls ride the shared
//! `github_http` scaffolding. ureq is blocking — callers run it off the UI thread.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::SIGN_IN_REQUIRED;
use super::resolve::{self, ModFacts, ModSource, PlanNode};
use crate::github_http::{self, API_BASE};

/// Hard ceilings on the untrusted, unsigned third-party payload (any
/// topic-tagged public repo is one-click installable): cap the download and the
/// decompressed total so a malicious release can't exhaust RAM/disk (zip bomb).
const MAX_PAYLOAD_BYTES: u64 = 512 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES: u64 = 512 * 1024 * 1024;
const MAX_PAYLOAD_ENTRIES: usize = 20_000;

/// A what-was-installed record: the content store dir, the links placed, the
/// `owner/name` ids this mod declared as dependencies, and whether the user
/// installed it EXPLICITLY (vs it being pulled in only as a dependency). The
/// last two are #[serde(default)] for back-compat: a pre-dependency ledger entry
/// reads back with no `deps` and `explicit = true` (every old install was a
/// direct, user-initiated one).
#[derive(Clone, Serialize, Deserialize)]
struct InstalledEntry {
    store: String,
    links: Vec<String>,
    #[serde(default)]
    deps: Vec<String>,
    #[serde(default = "default_explicit")]
    explicit: bool,
}

/// Back-compat default: a ledger entry written before dependency tracking was a
/// direct user install, so it reads back as explicit.
fn default_explicit() -> bool {
    true
}

/// What an install pass did (model studio::market `InstallOutcome`): the root
/// mod, every dependency newly pulled in (`owner/name`), the count of links
/// placed across all newly-installed nodes, and any non-fatal warnings (version
/// mismatches, skipped optional dependencies).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct InstallOutcome {
    pub root: String,
    pub installed_deps: Vec<String>,
    pub links: usize,
    pub warnings: Vec<String>,
}

/// What an uninstall pass did (model studio::market `UninstallOutcome`): every
/// mod removed — the target plus any now-orphaned dependencies garbage-collected
/// with it.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UninstallOutcome {
    pub removed: Vec<String>,
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

/// The DCS destination roots for a Marketplace install: the shared resolver with
/// `{GameInstall}` left unconfigured (`None`) — a `{GameInstall}` rule then fails
/// the guard rather than installing a third-party mod to the game dir.
fn resolve_roots() -> Result<dcs_studio_project::RootMap, String> {
    dcs_studio_project::detect::resolve_roots(None)
}

/// The download URL of the legacy single-`.zip` payload — the asset named
/// `dcs-studio-<name>-<tag>.zip`. Matched by that exact `dcs-studio-<name>-`
/// prefix so an unrelated `.zip` on the release can't be installed by mistake.
/// (Publish now writes a 7-Zip payload instead — issue #62; discovering and
/// re-stitching those `.7z`/`.7z.NNN` assets on install lands with that issue's
/// install slice, while this legacy `.zip` path stays for older releases.)
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
    let resp: Resp = github_http::get(&url, token)
        .set("Accept", github_http::ACCEPT_JSON)
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
    let resp = github_http::get(url, token)
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

/// Install a discovered mod and its transitive Marketplace dependencies (model
/// `Library.Install`): sign-in gated; resolve the `[[dependencies]]` graph, then
/// place each node (download → unpack → link) deps-first, recording the ledger.
pub fn install(owner: &str, name: &str) -> Result<InstallOutcome, String> {
    install_with(crate::github::current_token().as_deref(), owner, name)
}

/// Refuse to install a library (a repo carrying `dcs-studio-library`) into DCS.
/// Pure (the topics are injected) so the defence-in-depth decision is unit-tested
/// without a live `get_repo` round-trip (issue #48).
fn refuse_library(topics: &[String], owner: &str, name: &str) -> Result<(), String> {
    if topics.iter().any(|t| t == dcs_studio_project::LIBRARY_TOPIC) {
        return Err(format!(
            "{owner}/{name} is a dcs-studio library — add it as a dependency (lua-cargo), not install it into DCS"
        ));
    }
    Ok(())
}

/// The GitHub-backed [`ModSource`] the resolver walks: facts come from the repo
/// topics (`get_repo`) + the latest release's `dcs-studio.toml` asset, and
/// install state from the ledger. One token, reused for every node.
struct GithubSource<'a> {
    token: &'a str,
}

impl ModSource for GithubSource<'_> {
    fn facts(&self, owner: &str, name: &str) -> Result<ModFacts, String> {
        let repo = super::get_repo(owner, name, self.token)?;
        let is_library = repo.topics.iter().any(|t| t == dcs_studio_project::LIBRARY_TOPIC);
        let release = super::get_latest_release(owner, name, self.token)?;
        let latest_tag = release.as_ref().map(|r| r.tag.clone());
        let manifest_text = release
            .as_ref()
            .and_then(|r| r.manifest_url.as_deref())
            .and_then(|url| super::fetch_asset_text(url, self.token).ok());
        let manifest = manifest_text
            .as_deref()
            .and_then(|t| dcs_studio_project::manifest::parse(t).ok());
        let installable = manifest.is_some();
        let deps = manifest.map(|m| m.dependencies).unwrap_or_default();
        Ok(ModFacts {
            is_library,
            latest_tag,
            deps,
            installable,
        })
    }

    fn is_installed(&self, id: &str) -> bool {
        read_ledger().contains_key(id)
    }
}

/// The testable core of [`install`]: the session token is injected.
fn install_with(token: Option<&str>, owner: &str, name: &str) -> Result<InstallOutcome, String> {
    let Some(token) = token else {
        return Err(SIGN_IN_REQUIRED.to_string());
    };
    // Defence in depth (issue #48): a library is never installable into DCS, even
    // via a direct call that bypassed the product page's hidden Install button.
    // The topic is the authoritative source, re-fetched server-side here; the
    // refusal decision is the pure [`refuse_library`] seam (unit-tested).
    let repo = super::get_repo(owner, name, token)?;
    refuse_library(&repo.topics, owner, name)?;

    // Resolve the transitive dependency graph (model `Library.ResolvePlan`).
    let source = GithubSource { token };
    let plan = resolve::resolve(owner, name, &source)?;

    let roots = resolve_roots()?;
    install_plan(owner, name, &plan, token, &roots)
}

/// Download the payload, unpack it to the per-mod content store, and link its
/// `[[install]]` rules — one plan node's placement. Returns the store dir + the
/// links placed.
fn place_one(
    owner: &str,
    name: &str,
    token: &str,
    roots: &dcs_studio_project::RootMap,
) -> Result<(String, Vec<String>), String> {
    let payload_url = find_payload_asset(owner, name, token)?;
    let bytes = fetch_asset_bytes(&payload_url, token)?;
    let store = store_dir(owner, name);
    unpack(&bytes, &store, MAX_UNCOMPRESSED_BYTES, MAX_PAYLOAD_ENTRIES)?;
    let links = deploy_links(&store, roots)?;
    Ok((store.to_string_lossy().to_string(), links))
}

/// Refresh an already-on-disk plan node's ledger entry. The ROOT is always fully
/// re-walked by the resolver, so its `node.deps` are its real current edges —
/// refresh them and promote it to explicit (the user asked for it directly). A
/// NON-root already-installed dependency is emitted by the resolver as a LEAF
/// with `deps: []` (its subtree is on disk, not re-walked), so its ledger edges
/// are already correct from its OWN install — they must NOT be overwritten.
/// Clobbering them to `[]` would drop its sub-dependencies' refcount edges, so a
/// still-needed transitive dependency would look orphaned and be garbage-
/// collected on the next uninstall, silently breaking the installed mod.
fn refresh_already_installed(entry: &mut InstalledEntry, node: &PlanNode, is_root: bool) {
    if is_root {
        entry.deps = node.deps.clone();
        entry.explicit = true;
    }
}

/// Place each node of a resolved plan in order (model `Library.InstallPlan`):
/// download + link a node not yet on disk, or skip the link step for one already
/// installed; record the ledger with each node's declared dependency ids and
/// whether it was installed explicitly (the root) or only pulled in. On any
/// failure the nodes placed in THIS pass are rolled back — both their links AND
/// the content stores freshly unpacked for them — so a partial install leaves
/// nothing behind. Returns the aggregate outcome.
fn install_plan(
    owner: &str,
    name: &str,
    plan: &[PlanNode],
    token: &str,
    roots: &dcs_studio_project::RootMap,
) -> Result<InstallOutcome, String> {
    let root_id = format!("{owner}/{name}");
    let mut ledger = read_ledger();
    // Links + content stores placed in THIS pass, for rollback if a later node
    // fails (the stores are freshly unpacked here, so dropping them on rollback
    // truly leaves nothing behind — they aren't shared with a prior install).
    let mut placed_links: Vec<String> = Vec::new();
    let mut placed_stores: Vec<String> = Vec::new();
    let mut total_links = 0usize;
    let mut installed_deps: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    for node in plan {
        warnings.extend(node.warnings.iter().cloned());
        let is_root = node.id == root_id;

        if node.already_installed {
            if let Some(entry) = ledger.get_mut(&node.id) {
                refresh_already_installed(entry, node, is_root);
            }
            continue;
        }

        let (parts_owner, parts_name) = node
            .id
            .split_once('/')
            .ok_or_else(|| format!("invalid mod id in plan: {}", node.id))?;
        match place_one(parts_owner, parts_name, token, roots) {
            Ok((store, links)) => {
                placed_links.extend(links.iter().cloned());
                placed_stores.push(store.clone());
                total_links += links.len();
                ledger.insert(
                    node.id.clone(),
                    InstalledEntry {
                        store,
                        links,
                        deps: node.deps.clone(),
                        explicit: is_root,
                    },
                );
                if !is_root {
                    installed_deps.push(node.id.clone());
                }
            }
            Err(e) => {
                rollback(&placed_links);
                for store in &placed_stores {
                    let _ = std::fs::remove_dir_all(store);
                }
                return Err(format!("installing {}: {e}", node.id));
            }
        }
    }

    write_ledger(&ledger);
    Ok(InstallOutcome {
        root: root_id,
        installed_deps,
        links: total_links,
        warnings,
    })
}

/// The ids of installed mods that declare `id` among their dependencies — the
/// refcount that keeps a still-needed dependency installed.
fn dependents_of(ledger: &HashMap<String, InstalledEntry>, id: &str) -> Vec<String> {
    let mut deps: Vec<String> = ledger
        .iter()
        .filter(|(k, v)| k.as_str() != id && v.deps.iter().any(|d| d == id))
        .map(|(k, _)| k.clone())
        .collect();
    deps.sort();
    deps
}

/// Remove one ledger entry from disk: unlink its links (never following them
/// into the target) and drop its content store.
fn remove_entry(entry: &InstalledEntry) -> Result<(), String> {
    for link in &entry.links {
        crate::linker::unlink(Path::new(link))?;
    }
    let _ = std::fs::remove_dir_all(&entry.store);
    Ok(())
}

/// Decide which ids an uninstall of `id` removes — the refcount + garbage-
/// collection decision, pure over the ledger map so it is unit-tested without
/// touching disk (model `Library.Uninstall` / `HasDependents` / `RemoveWithOrphans`).
/// `Err` when `id` is not installed, or when another installed mod still depends
/// on it (its dependents must go first). Otherwise returns `id` followed by every
/// dependency garbage-collected: auto-installed (not explicit) and, once the
/// removals so far are applied, needed by nothing still installed.
fn plan_removal(
    ledger: &HashMap<String, InstalledEntry>,
    id: &str,
) -> Result<Vec<String>, String> {
    if !ledger.contains_key(id) {
        return Err(format!("{id} is not installed"));
    }
    let dependents = dependents_of(ledger, id);
    if !dependents.is_empty() {
        let (label, them) = if dependents.len() > 1 {
            ("mods", "them")
        } else {
            ("mod", "it")
        };
        return Err(format!(
            "{id} is required by installed {label} {} — uninstall {them} first",
            dependents.join(", ")
        ));
    }

    // Simulate the removals over a clone so the decision stays pure.
    let mut remaining = ledger.clone();
    remaining.remove(id);
    let mut removed = vec![id.to_string()];

    loop {
        let orphan = remaining
            .iter()
            .find(|(k, v)| !v.explicit && dependents_of(&remaining, k).is_empty())
            .map(|(k, _)| k.clone());
        let Some(orphan) = orphan else { break };
        remaining.remove(&orphan);
        removed.push(orphan);
    }
    Ok(removed)
}

/// Apply a removal plan in order, dropping each victim from the ledger as it
/// comes off disk via `remove`. Stops at the FIRST failure — every later victim
/// was only orphaned on the assumption this one was removed, so the cascade can't
/// safely continue past it (the failed mod may still need them). Returns the ids
/// actually removed and the first error, if any. Pure over the ledger map + an
/// injected remover, so the stop-and-persist behaviour is unit-tested without
/// touching disk.
fn apply_removal(
    ledger: &mut HashMap<String, InstalledEntry>,
    plan: &[String],
    mut remove: impl FnMut(&InstalledEntry) -> Result<(), String>,
) -> (Vec<String>, Option<String>) {
    let mut removed = Vec::new();
    for victim in plan {
        if let Some(entry) = ledger.get(victim).cloned() {
            if let Err(e) = remove(&entry) {
                return (removed, Some(format!("uninstalling {victim}: {e}")));
            }
        }
        ledger.remove(victim);
        removed.push(victim.clone());
    }
    (removed, None)
}

/// Uninstall a mod and its orphaned dependencies (model `Library.Uninstall`):
/// refuse while another installed mod still depends on it; otherwise remove it,
/// then garbage-collect every dependency now orphaned (auto-installed and needed
/// by nothing). Returns every id removed. The ledger is persisted to reflect what
/// actually came off disk even if a removal fails partway, so it never claims a
/// removed mod is still installed.
pub fn uninstall(id: &str) -> Result<UninstallOutcome, String> {
    let mut ledger = read_ledger();
    let plan = plan_removal(&ledger, id)?;
    let (removed, error) = apply_removal(&mut ledger, &plan, remove_entry);
    write_ledger(&ledger);
    match error {
        Some(e) => Err(e),
        None => Ok(UninstallOutcome { removed }),
    }
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

    /// A ledger entry fixture: `deps` it declares + whether it was explicit.
    fn entry(deps: &[&str], explicit: bool) -> InstalledEntry {
        InstalledEntry {
            store: "store".to_string(),
            links: Vec::new(),
            deps: deps.iter().map(|d| (*d).to_string()).collect(),
            explicit,
        }
    }

    fn ledger(entries: &[(&str, InstalledEntry)]) -> HashMap<String, InstalledEntry> {
        entries
            .iter()
            .map(|(k, v)| ((*k).to_string(), v.clone()))
            .collect()
    }

    #[test]
    fn install_refuses_without_a_token() {
        // The install core takes the session token, so the sign-in gate is
        // exercised without touching the global keyring (model `Library.Install`).
        assert_eq!(install_with(None, "octocat", "cool-mod").unwrap_err(), SIGN_IN_REQUIRED);
    }

    #[test]
    fn an_old_ledger_entry_reads_back_as_explicit_with_no_deps() {
        // Back-compat: a pre-dependency-tracking entry has no `deps`/`explicit`.
        let json = r#"{"o/mod":{"store":"/s","links":["/l"]}}"#;
        let parsed: HashMap<String, InstalledEntry> = serde_json::from_str(json).unwrap();
        let e = parsed.get("o/mod").unwrap();
        assert!(e.deps.is_empty());
        assert!(e.explicit, "an old install is treated as explicit");
    }

    #[test]
    fn dependents_lists_mods_that_declare_the_id() {
        let l = ledger(&[
            ("o/root", entry(&["o/shared"], true)),
            ("o/other", entry(&["o/shared"], true)),
            ("o/shared", entry(&[], false)),
        ]);
        assert_eq!(
            dependents_of(&l, "o/shared"),
            vec!["o/other".to_string(), "o/root".to_string()]
        );
        assert!(dependents_of(&l, "o/root").is_empty());
    }

    #[test]
    fn uninstalling_an_unknown_mod_is_an_error() {
        let l = ledger(&[("o/root", entry(&[], true))]);
        assert!(plan_removal(&l, "o/ghost").unwrap_err().contains("not installed"));
    }

    #[test]
    fn a_depended_upon_mod_cannot_be_removed() {
        // root → dep (auto). Removing the dep directly is refused; the dependent
        // must go first (model SharedDependencySurvivesUninstall, second clause).
        let l = ledger(&[
            ("o/root", entry(&["o/dep"], true)),
            ("o/dep", entry(&[], false)),
        ]);
        let err = plan_removal(&l, "o/dep").unwrap_err();
        assert!(err.contains("required by"), "{err}");
        assert!(err.contains("o/root"), "names the dependent: {err}");
    }

    #[test]
    fn removing_a_mod_garbage_collects_its_orphaned_dependency() {
        // root → dep (auto, nothing else needs it): removing root removes dep too.
        let l = ledger(&[
            ("o/root", entry(&["o/dep"], true)),
            ("o/dep", entry(&[], false)),
        ]);
        let mut removed = plan_removal(&l, "o/root").unwrap();
        removed.sort();
        assert_eq!(removed, vec!["o/dep".to_string(), "o/root".to_string()]);
    }

    #[test]
    fn an_explicitly_installed_dependency_is_kept_on_gc() {
        // dep was ALSO installed explicitly by the user — keep it when root goes.
        let l = ledger(&[
            ("o/root", entry(&["o/dep"], true)),
            ("o/dep", entry(&[], true)),
        ]);
        let removed = plan_removal(&l, "o/root").unwrap();
        assert_eq!(removed, vec!["o/root".to_string()], "only root removed");
    }

    #[test]
    fn a_shared_dependency_survives_removing_one_dependent() {
        // Two roots share an auto dep. Removing one leaves the dep (the other
        // still needs it) — model SharedDependencySurvivesUninstall.
        let l = ledger(&[
            ("o/root-a", entry(&["o/shared"], true)),
            ("o/root-b", entry(&["o/shared"], true)),
            ("o/shared", entry(&[], false)),
        ]);
        let removed = plan_removal(&l, "o/root-a").unwrap();
        assert_eq!(removed, vec!["o/root-a".to_string()], "shared dep stays");
    }

    #[test]
    fn gc_cascades_through_a_chain_of_orphans() {
        // root → a → b, all auto except root explicit. Removing root cascades to
        // a then b (each orphaned in turn).
        let l = ledger(&[
            ("o/root", entry(&["o/a"], true)),
            ("o/a", entry(&["o/b"], false)),
            ("o/b", entry(&[], false)),
        ]);
        let mut removed = plan_removal(&l, "o/root").unwrap();
        removed.sort();
        assert_eq!(
            removed,
            vec!["o/a".to_string(), "o/b".to_string(), "o/root".to_string()]
        );
    }

    #[test]
    fn a_failed_removal_stops_the_cascade_and_persists_what_came_off() {
        // root → a → b (a, b auto). Plan = [root, a, b]. The disk removal of `a`
        // fails: the cascade stops there, root is dropped from the ledger (it came
        // off disk), and a + b stay installed (the failed `a` may still need `b`).
        let mut l = ledger(&[
            ("o/root", entry(&["o/a"], true)),
            ("o/a", entry(&["o/b"], false)),
            ("o/b", entry(&[], false)),
        ]);
        let plan = plan_removal(&l, "o/root").unwrap();
        let (removed, error) = apply_removal(&mut l, &plan, |e| {
            // `o/a` is the only entry whose deps are exactly [o/b].
            if e.deps == vec!["o/b".to_string()] {
                Err("link locked".to_string())
            } else {
                Ok(())
            }
        });
        assert_eq!(removed, vec!["o/root".to_string()], "only the target came off");
        assert!(error.unwrap().contains("o/a"), "the failure names the victim");
        // The ledger reflects reality: root gone, a + b still installed.
        assert!(!l.contains_key("o/root"));
        assert!(l.contains_key("o/a"));
        assert!(l.contains_key("o/b"));
    }

    #[test]
    fn re_encountering_an_installed_dependency_keeps_its_subdep_edges() {
        // Regression (shockwave !52): installing a mod that depends on an
        // ALREADY-INSTALLED mod must not wipe that mod's own dependency edges, or
        // its sub-dependency gets wrongly garbage-collected on a later uninstall.
        //
        // Given o/a (explicit) requires o/b; both installed.
        let mut l = ledger(&[
            ("o/a", entry(&["o/b"], true)),
            ("o/b", entry(&[], false)),
        ]);
        // When o/root (requires o/a) is installed: the resolver emits o/a as an
        // already-installed LEAF with deps:[] (its subtree is on disk). The
        // install pass refreshes o/a's entry with that leaf node.
        let a_leaf = PlanNode {
            id: "o/a".to_string(),
            deps: Vec::new(),
            already_installed: true,
            warnings: Vec::new(),
        };
        if let Some(entry) = l.get_mut("o/a") {
            refresh_already_installed(entry, &a_leaf, /* is_root */ false);
        }
        l.insert("o/root".to_string(), entry(&["o/a"], true));

        // o/a's real edge to o/b must survive (NOT clobbered to []).
        assert_eq!(
            l.get("o/a").unwrap().deps,
            vec!["o/b".to_string()],
            "the installed dependency keeps its own sub-dependency edge"
        );
        // Then uninstalling o/root removes only o/root — o/a still needs o/b.
        let removed = plan_removal(&l, "o/root").unwrap();
        assert_eq!(removed, vec!["o/root".to_string()]);
        assert!(l.contains_key("o/a") && l.contains_key("o/b"), "subtree intact");
    }

    #[test]
    fn re_installing_the_root_refreshes_its_edges_and_marks_it_explicit() {
        // The root IS fully re-walked, so its already-installed refresh DOES apply
        // the resolver's real deps and promotes it to explicit (e.g. a mod first
        // pulled in as an auto dependency, later installed directly).
        let mut entry = entry(&["o/old"], false);
        let root_node = PlanNode {
            id: "o/root".to_string(),
            deps: vec!["o/new".to_string()],
            already_installed: true,
            warnings: Vec::new(),
        };
        refresh_already_installed(&mut entry, &root_node, /* is_root */ true);
        assert_eq!(entry.deps, vec!["o/new".to_string()], "root edges refreshed");
        assert!(entry.explicit, "root promoted to explicit");
    }

    #[test]
    fn install_refuses_a_library_repo_defence_in_depth() {
        // A repo carrying the library topic is refused (the seam the install path
        // calls after re-fetching topics server-side) — feature
        // LibraryIsNeverInstallable's Layer 2.
        let lib_topics = vec!["dcs-studio".to_string(), "dcs-studio-library".to_string()];
        let err = refuse_library(&lib_topics, "flying-dice", "mylib").unwrap_err();
        assert!(err.contains("library"), "clear refusal: {err}");
        // A non-library repo passes the guard.
        let mod_topics = vec!["dcs-studio".to_string()];
        assert!(refuse_library(&mod_topics, "octocat", "cool-mod").is_ok());
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
