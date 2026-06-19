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
use crate::github_http::{self, API_BASE};

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

/// The DCS destination roots for a Marketplace install: the shared resolver with
/// `{GameInstall}` left unconfigured (`None`) — a `{GameInstall}` rule then fails
/// the guard rather than installing a third-party mod to the game dir.
fn resolve_roots() -> Result<dcs_studio_project::RootMap, String> {
    dcs_studio_project::detect::resolve_roots(None)
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

/// Install a discovered mod (model `Library.Install`): sign-in gated; download
/// the payload, unpack to the content store, link each dest, record the ledger.
pub fn install(owner: &str, name: &str) -> Result<dcs_studio_project::InstallReport, String> {
    install_with(crate::github::current_token().as_deref(), owner, name)
}

/// The testable core of [`install`]: the session token is injected.
fn install_with(
    token: Option<&str>,
    owner: &str,
    name: &str,
) -> Result<dcs_studio_project::InstallReport, String> {
    let Some(token) = token else {
        return Err(SIGN_IN_REQUIRED.to_string());
    };
    let roots = resolve_roots()?;
    let payload_url = find_payload_asset(owner, name, token)?;
    let bytes = fetch_asset_bytes(&payload_url, token)?;
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

    #[test]
    fn install_refuses_without_a_token() {
        // The install core takes the session token, so the sign-in gate is
        // exercised without touching the global keyring (model `Library.Install`).
        assert_eq!(install_with(None, "octocat", "cool-mod").unwrap_err(), SIGN_IN_REQUIRED);
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
