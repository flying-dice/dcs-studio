//! studio::market::payload — the install-side payload engine (issue #62), the
//! mirror of `publish.rs`'s split: discover a release's install payload, verify it
//! is COMPLETE before downloading, then download + re-stitch + extract it into the
//! per-mod content store. Three payload shapes are handled (model
//! `Library.DiscoverPayload`):
//!
//! * a multi-volume 7-Zip set `<base>.7z.001`, `.002`, … (`base` =
//!   `dcs-studio-<name>-<tag>`) — a raw byte-split of one `.7z` stream, so
//!   concatenating the volumes reproduces the archive and `7z x <base>.7z.001`
//!   reassembles it natively;
//! * a single `<base>.7z` (a small mod whose payload fit one volume);
//! * the legacy single `<base>.zip` (pre-#62 releases), read through the existing
//!   `zip` path unchanged.
//!
//! The untrusted, unsigned third-party payload is held to the same ceilings as the
//! legacy path: extraction is confined to the store (an entry escaping it is
//! refused) and bounded by a budget measured on ACTUAL decompressed bytes (a lying
//! declared size is never trusted) that is ITSELF capped at the free disk, plus an
//! entry-count cap, an aggregate-size cap, a volume-count cap, and a free-space
//! pre-flight. The 7-Zip volumes stream to a scratch dir and are read through a
//! CHAINED SEEK-READER in place — never concatenated into one temp copy; only the
//! legacy `.zip` is buffered whole in memory, under a RAM-sane download cap. So a
//! lying header can exhaust neither memory nor disk, and peak install disk is the
//! downloaded volumes + the extracted tree, nothing more. ureq is blocking —
//! callers run it off the UI thread.

use std::fs::File;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;

use crate::github_http::{self, API_BASE};

/// Budget on ACTUAL decompressed bytes (model: the decompression cap, default
/// ~16 GiB). Measured on bytes written, not the archive's declared sizes, so a
/// lying-header zip bomb is stopped at the budget regardless.
pub(super) const MAX_UNCOMPRESSED_BYTES: u64 = 16 * 1024 * 1024 * 1024;
/// RAM ceiling for the legacy `.zip`, which is buffered whole in memory before
/// unpacking (the 7-Zip path streams to disk instead). Restores the pre-#62
/// 512 MiB download bound so a hostile `.zip`-only release can't force a
/// multi-gigabyte allocation in the desktop process. Distinct from the
/// decompression budget: this caps the COMPRESSED download, that the extracted bytes.
const MAX_LEGACY_ZIP_BYTES: u64 = 512 * 1024 * 1024;
/// Cap on the number of entries unpacked from one payload (a fork-bomb of tiny
/// files is refused before it floods the filesystem).
pub(super) const MAX_PAYLOAD_ENTRIES: usize = 20_000;
/// Cap on the aggregate download size across a payload's assets — a hostile
/// release advertising more than this is refused up front, before any download.
const MAX_DOWNLOAD_BYTES: u64 = 20 * 1024 * 1024 * 1024;
/// Cap on the number of volumes (GitHub allows ≤ 1000 assets per release; a
/// release advertising more is hostile).
const MAX_VOLUMES: usize = 1000;
/// Free-disk headroom required on top of a download / extraction so the install
/// never wedges the disk at exactly full.
const DISK_HEADROOM_BYTES: u64 = 256 * 1024 * 1024;
/// Per-asset download attempts before giving up (one try + retries on transient
/// failures), with exponential backoff between them.
const DOWNLOAD_ATTEMPTS: u32 = 4;
const BACKOFF_BASE: Duration = Duration::from_millis(250);

/// One asset on the latest release, with the download URL the install fetches.
#[derive(Clone, Debug, Deserialize)]
pub(super) struct ReleaseAsset {
    pub name: String,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub browser_download_url: String,
}

/// The discovered, verified payload of a release (model `PayloadPlan`): the ordered
/// assets to fetch and whether it is a 7-Zip payload (vs the legacy `.zip`).
#[derive(Debug)]
struct PayloadPlan {
    volumes: Vec<ReleaseAsset>,
    seven_zip: bool,
}

impl PayloadPlan {
    fn total_bytes(&self) -> u64 {
        self.volumes.iter().map(|a| a.size).sum()
    }
}

/// Fetch the latest release's assets (names, sizes, download URLs) — the input to
/// payload discovery. `GET /repos/{owner}/{name}/releases/latest`.
fn fetch_latest_assets(owner: &str, name: &str, token: &str) -> Result<Vec<ReleaseAsset>, String> {
    #[derive(Deserialize)]
    struct Resp {
        #[serde(default)]
        assets: Vec<ReleaseAsset>,
    }
    let url = format!("{API_BASE}/repos/{owner}/{name}/releases/latest");
    let resp: Resp = github_http::get(&url, token)
        .set("Accept", github_http::ACCEPT_JSON)
        .call()
        .map_err(|e| format!("latest-release request failed: {e}"))?
        .into_json()
        .map_err(|e| format!("latest-release response: {e}"))?;
    Ok(resp.assets)
}

/// The volume index of `name` when it is a `<prefix>*.7z.NNN` volume, else `None`.
/// The number is the decimal run after the final `.7z.` (publish pads to 3 digits,
/// but parses any width).
fn volume_number(name: &str, prefix: &str) -> Option<u64> {
    if !name.starts_with(prefix) {
        return None;
    }
    let idx = name.rfind(".7z.")?;
    let digits = name.get(idx + ".7z.".len()..)?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

/// Classify the latest release's assets into ONE payload shape (model
/// `DiscoverPayload`, the pure core). A `<base>.7z.001` set wins (and must be
/// contiguous `001..00N`); else a single `<base>.7z`; else the legacy `<base>.zip`;
/// else there is no installable payload. `name` drives the `dcs-studio-<name>-`
/// prefix so an unrelated archive on the release can't be installed by mistake.
fn classify_payload(name: &str, assets: &[ReleaseAsset]) -> Result<PayloadPlan, String> {
    let prefix = format!("dcs-studio-{name}-");

    let mut numbered: Vec<(u64, ReleaseAsset)> = assets
        .iter()
        .filter_map(|a| volume_number(&a.name, &prefix).map(|n| (n, a.clone())))
        .collect();
    if !numbered.is_empty() {
        // Pre-empt a hostile release HERE, before sorting/keeping the whole set —
        // the volume-count cap bounds discovery work, not just the download.
        if numbered.len() > MAX_VOLUMES {
            return Err(format!(
                "refusing payload: {} volumes exceeds the {MAX_VOLUMES}-volume limit",
                numbered.len()
            ));
        }
        numbered.sort_by_key(|(n, _)| *n);
        // The set must be a contiguous 1..=len run — a gap is a missing volume.
        for (expected, (got, asset)) in (1u64..).zip(numbered.iter()) {
            if *got != expected {
                return Err(format!(
                    "incomplete volume set: expected volume {expected:03} but the next present is {} ({got:03})",
                    asset.name
                ));
            }
        }
        let volumes = numbered.into_iter().map(|(_, a)| a).collect();
        return Ok(PayloadPlan { volumes, seven_zip: true });
    }

    if let Some(single) =
        assets.iter().find(|a| a.name.starts_with(&prefix) && a.name.ends_with(".7z"))
    {
        return Ok(PayloadPlan { volumes: vec![single.clone()], seven_zip: true });
    }
    if let Some(zip) =
        assets.iter().find(|a| a.name.starts_with(&prefix) && a.name.ends_with(".zip"))
    {
        return Ok(PayloadPlan { volumes: vec![zip.clone()], seven_zip: false });
    }
    Err(format!(
        "this release has no installable `{prefix}*.7z` / `.7z.NNN` / legacy `.zip` payload (re-publish from DCS Studio)"
    ))
}

/// Read the first `SIGNATURE_HEADER_LEN` bytes of `url` (a Range request, capped
/// regardless so a server ignoring Range can't stream the whole volume at us) and
/// return the archive length its start header implies, via the `studio_archive`
/// facade.
fn probe_archive_len(url: &str, token: &str) -> Result<u64, String> {
    let resp = github_http::get(url, token)
        .set("Range", &format!("bytes=0-{}", studio_archive::SIGNATURE_HEADER_LEN - 1))
        .call()
        .map_err(|e| format!("payload header probe failed: {e}"))?;
    let mut buf = Vec::with_capacity(studio_archive::SIGNATURE_HEADER_LEN as usize);
    resp.into_reader()
        .take(studio_archive::SIGNATURE_HEADER_LEN)
        .read_to_end(&mut buf)
        .map_err(|e| format!("payload header read failed: {e}"))?;
    studio_archive::archive_len_from_start_header(&buf)
}

/// The shortfall (bytes) when `free` cannot cover `need` plus headroom, else
/// `None`. Pure, so the pre-flight arithmetic is unit-tested without a real disk.
fn disk_shortfall(free: u64, need: u64) -> Option<u64> {
    let required = need.saturating_add(DISK_HEADROOM_BYTES);
    (free < required).then(|| required - free)
}

/// Free bytes on `dir`'s filesystem — a missing `dir` resolves to its nearest
/// existing ancestor for the probe. Shared so the pre-flight and the extraction
/// disk-budget bound read the same number.
fn free_space(dir: &Path) -> Result<u64, String> {
    let probe = dir.ancestors().find(|p| p.exists()).unwrap_or(dir);
    fs2::available_space(probe).map_err(|e| format!("could not check free disk space: {e}"))
}

/// The free-disk figure passed to `studio_archive::extract` as its budget bound:
/// free space minus headroom (the extraction never trusts the declared size, so
/// the running budget can't exceed what the disk actually holds — the lying-header
/// ENOSPC guard). Saturates to 0 when the disk is already under headroom.
fn disk_budget(dir: &Path) -> Result<u64, String> {
    Ok(free_space(dir)?.saturating_sub(DISK_HEADROOM_BYTES))
}

/// Refuse up front when `dir`'s filesystem cannot hold `need` plus headroom.
fn ensure_free_space(dir: &Path, need: u64) -> Result<(), String> {
    match disk_shortfall(free_space(dir)?, need) {
        Some(short) => Err(format!(
            "not enough disk space to install: need ~{short} more byte(s) free"
        )),
        None => Ok(()),
    }
}

/// Download `url` into `dest`, retrying a transient failure with exponential
/// backoff. The body is capped to `expected_size` and a short transfer is an error;
/// a corrupt-but-full body passes here and is caught later by the 7z CRC.
fn download_to_file(url: &str, token: &str, dest: &Path, expected_size: u64) -> Result<(), String> {
    with_backoff(|| {
        let resp = github_http::get(url, token)
            .call()
            .map_err(|e| format!("download failed: {e}"))?;
        let mut file = File::create(dest).map_err(|e| format!("create {}: {e}", dest.display()))?;
        let written = io::copy(&mut resp.into_reader().take(expected_size), &mut file)
            .map_err(|e| format!("write {}: {e}", dest.display()))?;
        if written != expected_size {
            return Err(format!(
                "short download: got {written} of {expected_size} bytes for {}",
                dest.display()
            ));
        }
        Ok(())
    })
}

/// Run `op` up to `DOWNLOAD_ATTEMPTS` times, sleeping `BACKOFF_BASE * 2^n` between
/// tries. The last error is returned if every attempt fails.
fn with_backoff<T>(mut op: impl FnMut() -> Result<T, String>) -> Result<T, String> {
    let mut last = String::new();
    for attempt in 0..DOWNLOAD_ATTEMPTS {
        match op() {
            Ok(value) => return Ok(value),
            Err(e) => {
                last = e;
                if attempt + 1 < DOWNLOAD_ATTEMPTS {
                    std::thread::sleep(BACKOFF_BASE * 2u32.pow(attempt));
                }
            }
        }
    }
    Err(last)
}

/// Download a capped payload wholly into memory — the legacy `.zip` read path
/// (small pre-#62 payloads). Mirrors the original `fetch_asset_bytes` cap.
fn fetch_capped_bytes(url: &str, token: &str, cap: u64) -> Result<Vec<u8>, String> {
    let resp = github_http::get(url, token)
        .call()
        .map_err(|e| format!("payload download failed: {e}"))?;
    if let Some(len) = resp.header("Content-Length").and_then(|l| l.parse::<u64>().ok()) {
        if len > cap {
            return Err("payload is too large to install".to_string());
        }
    }
    let mut buf = Vec::new();
    resp.into_reader()
        .take(cap + 1)
        .read_to_end(&mut buf)
        .map_err(|e| format!("payload read failed: {e}"))?;
    if buf.len() as u64 > cap {
        return Err("payload exceeds the size limit".to_string());
    }
    Ok(buf)
}

/// Unpack the legacy `.zip` payload into a fresh `store` — the pre-#62 read path,
/// unchanged: Zip-Slip-guarded, entry-count-capped, and bounded by a budget on
/// ACTUAL decompressed bytes (a lying `uncompressed_size` is not trusted).
fn unpack_zip(bytes: &[u8], store: &Path, max_uncompressed: u64, max_entries: usize) -> Result<(), String> {
    let _ = std::fs::remove_dir_all(store);
    std::fs::create_dir_all(store).map_err(|e| format!("create store: {e}"))?;
    let mut archive = zip::ZipArchive::new(io::Cursor::new(bytes)).map_err(|e| format!("open payload: {e}"))?;
    if archive.len() > max_entries {
        return Err("payload has too many files to install".to_string());
    }
    // Same disk bound as the 7z path: the actual-bytes budget is capped at the free
    // disk, so a lying `uncompressed_size` can't write past it to ENOSPC.
    let mut budget = max_uncompressed.min(disk_budget(store)?);
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("payload entry: {e}"))?;
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
            let mut file = File::create(&out).map_err(|e| format!("unpack file: {e}"))?;
            let mut limited = entry.by_ref().take(budget + 1);
            let written = io::copy(&mut limited, &mut file).map_err(|e| format!("unpack write: {e}"))?;
            if written > budget {
                return Err("payload is too large when decompressed".to_string());
            }
            budget -= written;
        }
    }
    Ok(())
}

/// A per-run scratch dir under the content root holding the downloaded volumes,
/// removed (best-effort) when this guard drops — so a cancelled or failed install
/// never strands volumes on disk.
struct DownloadScratch {
    dir: PathBuf,
}

impl DownloadScratch {
    fn new(parent: &Path, owner: &str, name: &str) -> Result<Self, String> {
        let dir = parent.join(format!("{owner}__{name}.dl.{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).map_err(|e| format!("create download dir: {e}"))?;
        Ok(Self { dir })
    }
}

impl Drop for DownloadScratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Download a discovered, verified payload and unpack it into `store`, returning
/// the bytes written (model `FetchPayloadIntoStore`). The 7-Zip shapes download
/// each volume into a per-run scratch dir, then read them through a chained
/// seek-reader straight into the store; the legacy `.zip` takes the in-memory
/// path. The scratch dir (and its volumes) is removed on the way out, success or
/// failure.
fn fetch_into_store(plan: &PayloadPlan, owner: &str, name: &str, token: &str, store: &Path) -> Result<u64, String> {
    let total = plan.total_bytes();
    if total > MAX_DOWNLOAD_BYTES {
        return Err(format!(
            "refusing payload: aggregate {total} bytes exceeds the {MAX_DOWNLOAD_BYTES}-byte install cap"
        ));
    }

    let market_dir = store.parent().unwrap_or(store);
    std::fs::create_dir_all(market_dir).map_err(|e| format!("create content root: {e}"))?;
    // Pre-flight: the disk must hold the download AND the extraction (the volumes
    // stay until extraction completes). The extracted size isn't known before the
    // download, so this guards the download footprint up front; the declared
    // extracted size is re-checked once the archive header is read.
    ensure_free_space(market_dir, total)?;

    if !plan.seven_zip {
        let url = plan.volumes.first().ok_or("legacy payload has no asset")?;
        // The legacy `.zip` is buffered whole in memory, so its download is capped at
        // a RAM-sane bound — NOT the (disk-bounded) decompression budget. This is the
        // path an attacker forces by publishing only a `.zip`; the cap stops a hostile
        // release from forcing a multi-gigabyte allocation in the desktop process.
        let bytes = fetch_capped_bytes(&url.browser_download_url, token, MAX_LEGACY_ZIP_BYTES)?;
        unpack_zip(&bytes, store, MAX_UNCOMPRESSED_BYTES, MAX_PAYLOAD_ENTRIES)?;
        // The legacy zip reader reports no running decompressed total; return the
        // downloaded byte count (callers use it only as a non-zero signal).
        return Ok(bytes.len() as u64);
    }

    let scratch = DownloadScratch::new(market_dir, owner, name)?;
    let mut volume_paths = Vec::with_capacity(plan.volumes.len());
    for (index, asset) in (1u64..).zip(plan.volumes.iter()) {
        let path = scratch.dir.join(format!("vol.{index:03}"));
        download_to_file(&asset.browser_download_url, token, &path, asset.size)?;
        volume_paths.push(path);
    }

    // Reassemble the volumes in place through the chained seek-reader and extract
    // straight into the store, under the untrusted-payload caps (the facade owns
    // the path-confinement + actual-bytes budget; the budget is bounded by the free
    // disk so a lying header can't ENOSPC).
    let reader = studio_archive::ChainedReader::open(&volume_paths)?;
    let limits = studio_archive::ExtractLimits {
        max_uncompressed: MAX_UNCOMPRESSED_BYTES,
        max_entries: MAX_PAYLOAD_ENTRIES,
        max_disk_bytes: disk_budget(market_dir)?,
    };
    let written = studio_archive::extract(reader, store, limits);
    // The volumes are superseded by the extracted store either way; `scratch`
    // removes them on drop. On failure, drop the half-written store too.
    if written.is_err() {
        let _ = std::fs::remove_dir_all(store);
    }
    written
}

/// Discover, download, and unpack a node's install payload into `store`, returning
/// the bytes written (the install-side entry point `place_one` calls). Volume sets
/// are verified complete (count + sizes via the `.001` start header) and pre-empted
/// for hostile counts BEFORE the bulk download.
pub(super) fn download_into_store(owner: &str, name: &str, token: &str, store: &Path) -> Result<u64, String> {
    let assets = fetch_latest_assets(owner, name, token)?;
    let plan = classify_payload(name, &assets)?;

    if plan.seven_zip && plan.volumes.len() > 1 {
        // (The volume-count cap is enforced up front in `classify_payload`.)
        let first = plan.volumes.first().ok_or("volume set has no `.001`")?;
        let archive_len = probe_archive_len(&first.browser_download_url, token)?;
        let sizes: Vec<u64> = plan.volumes.iter().map(|a| a.size).collect();
        studio_archive::verify_volume_set(&sizes, archive_len)?;
    }

    fetch_into_store(&plan, owner, name, token, store)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(name: &str, size: u64) -> ReleaseAsset {
        ReleaseAsset { name: name.to_string(), size, browser_download_url: format!("https://dl.invalid/{name}") }
    }

    // --- payload classification ---------------------------------------------

    #[test]
    fn classify_prefers_an_ordered_volume_set() {
        let assets = vec![
            asset("dcs-studio.toml", 200),
            asset("dcs-studio-cool-v1.7z.002", 10),
            asset("dcs-studio-cool-v1.7z.001", 100),
        ];
        let plan = classify_payload("cool", &assets).expect("a volume set");
        assert!(plan.seven_zip);
        let names: Vec<&str> = plan.volumes.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(names, vec!["dcs-studio-cool-v1.7z.001", "dcs-studio-cool-v1.7z.002"], "ordered by index");
    }

    #[test]
    fn classify_falls_back_to_single_7z_then_legacy_zip() {
        let single = classify_payload("cool", &[asset("dcs-studio-cool-v1.7z", 100)]).expect("single .7z");
        assert!(single.seven_zip && single.volumes.len() == 1);

        let legacy = classify_payload("cool", &[asset("dcs-studio-cool-v1.zip", 100)]).expect("legacy .zip");
        assert!(!legacy.seven_zip, "legacy zip is not the 7z path");
    }

    #[test]
    fn classify_rejects_a_gap_in_the_volume_set() {
        let assets = vec![
            asset("dcs-studio-cool-v1.7z.001", 100),
            asset("dcs-studio-cool-v1.7z.003", 10),
        ];
        let err = classify_payload("cool", &assets).expect_err("a gap is rejected");
        assert!(err.contains("incomplete volume set"), "{err}");
    }

    #[test]
    fn classify_ignores_an_unrelated_archive() {
        // A `.7z` not matching the `dcs-studio-<name>-` prefix can't be installed.
        let err = classify_payload("cool", &[asset("someone-elses.7z", 100)]).expect_err("no payload");
        assert!(err.contains("no installable"), "{err}");
    }

    #[test]
    fn volume_number_parses_only_well_formed_suffixes() {
        let p = "dcs-studio-cool-";
        assert_eq!(volume_number("dcs-studio-cool-v1.7z.001", p), Some(1));
        assert_eq!(volume_number("dcs-studio-cool-v1.7z.1000", p), Some(1000));
        assert_eq!(volume_number("dcs-studio-cool-v1.7z", p), None, "single archive is not a volume");
        assert_eq!(volume_number("dcs-studio-cool-v1.7z.x", p), None, "non-numeric suffix");
        assert_eq!(volume_number("other-v1.7z.001", p), None, "wrong prefix");
    }

    // --- disk pre-flight (the `.7z` reassembly + extraction + completeness
    // checks live in `studio_archive`; this module keeps the classify, disk
    // pre-flight, and legacy-`.zip` tests) -----------------------------------

    #[test]
    fn disk_shortfall_accounts_for_headroom() {
        assert!(disk_shortfall(DISK_HEADROOM_BYTES + 1000, 0).is_none(), "headroom satisfied");
        assert!(disk_shortfall(10, 1_000_000).is_some(), "obviously insufficient");
        // Exactly need+headroom is enough; one byte short is not.
        assert!(disk_shortfall(1000 + DISK_HEADROOM_BYTES, 1000).is_none());
        assert_eq!(disk_shortfall(DISK_HEADROOM_BYTES, 1000), Some(1000));
    }

    // --- legacy zip path (moved from library.rs, unchanged behaviour) -------

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

    /// A single STORED zip entry whose declared `uncompressed_size` is a LIE.
    fn forged_zip(name: &str, data: &[u8], forged_uncompressed: u32) -> Vec<u8> {
        let crc = crc32(data);
        let csize = data.len() as u32;
        let nlen = name.len() as u16;
        let mut z = Vec::new();
        z.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        z.extend_from_slice(&20u16.to_le_bytes());
        z.extend_from_slice(&0u16.to_le_bytes());
        z.extend_from_slice(&0u16.to_le_bytes());
        z.extend_from_slice(&0u16.to_le_bytes());
        z.extend_from_slice(&0u16.to_le_bytes());
        z.extend_from_slice(&crc.to_le_bytes());
        z.extend_from_slice(&csize.to_le_bytes());
        z.extend_from_slice(&forged_uncompressed.to_le_bytes());
        z.extend_from_slice(&nlen.to_le_bytes());
        z.extend_from_slice(&0u16.to_le_bytes());
        z.extend_from_slice(name.as_bytes());
        z.extend_from_slice(data);
        let cd_off = z.len() as u32;
        z.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        z.extend_from_slice(&20u16.to_le_bytes());
        z.extend_from_slice(&20u16.to_le_bytes());
        z.extend_from_slice(&0u16.to_le_bytes());
        z.extend_from_slice(&0u16.to_le_bytes());
        z.extend_from_slice(&0u16.to_le_bytes());
        z.extend_from_slice(&0u16.to_le_bytes());
        z.extend_from_slice(&crc.to_le_bytes());
        z.extend_from_slice(&csize.to_le_bytes());
        z.extend_from_slice(&forged_uncompressed.to_le_bytes());
        z.extend_from_slice(&nlen.to_le_bytes());
        z.extend_from_slice(&0u16.to_le_bytes());
        z.extend_from_slice(&0u16.to_le_bytes());
        z.extend_from_slice(&0u16.to_le_bytes());
        z.extend_from_slice(&0u16.to_le_bytes());
        z.extend_from_slice(&0u32.to_le_bytes());
        z.extend_from_slice(&0u32.to_le_bytes());
        z.extend_from_slice(name.as_bytes());
        let cd_size = z.len() as u32 - cd_off;
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
    fn unpack_zip_caps_actual_bytes_against_a_lying_header() {
        let data = vec![b'A'; 4096];
        let zip = forged_zip("big.bin", &data, 0);
        let store = std::env::temp_dir().join(format!("dcs-zbomb-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&store);
        let err = unpack_zip(&zip, &store, 1024, 100).expect_err("lying-header bomb rejected");
        assert!(err.contains("too large when decompressed"), "{err}");
        let _ = std::fs::remove_dir_all(&store);
    }

    #[test]
    fn unpack_zip_accepts_a_payload_within_budget() {
        let data = b"hello world";
        let zip = forged_zip("ok.txt", data, data.len() as u32);
        let store = std::env::temp_dir().join(format!("dcs-zok-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&store);
        unpack_zip(&zip, &store, 1024, 100).expect("a small honest payload unpacks");
        assert_eq!(std::fs::read(store.join("ok.txt")).unwrap(), data);
        let _ = std::fs::remove_dir_all(&store);
    }
}
