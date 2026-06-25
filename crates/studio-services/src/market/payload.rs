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
use std::io::{self, Read, Seek, SeekFrom};
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
/// The 6-byte 7-Zip signature that opens every `.7z` (and thus every `.001`).
const SEVENZ_SIGNATURE: [u8; 6] = [0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C];
/// The fixed 7-Zip signature-header length: 6 sig + 2 version + 4 CRC + 20 start
/// header. `NextHeaderOffset` is relative to its end, so the whole archive is
/// `SIGNATURE_HEADER_LEN + NextHeaderOffset + NextHeaderSize` bytes.
const SIGNATURE_HEADER_LEN: u64 = 32;
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

/// The whole-archive length encoded in a `.7z` 32-byte signature header:
/// `SIGNATURE_HEADER_LEN + NextHeaderOffset + NextHeaderSize`. This is what 7-Zip
/// itself reads from `.001` to know how many volumes a set must have.
fn archive_len_from_start_header(buf: &[u8]) -> Result<u64, String> {
    let sig = buf.get(0..6).ok_or("payload start header is truncated")?;
    if sig != SEVENZ_SIGNATURE {
        return Err("payload is not a 7-Zip archive (bad signature in `.001`)".to_string());
    }
    let next_offset = u64_le(buf.get(12..20).ok_or("payload start header is truncated")?)?;
    let next_size = u64_le(buf.get(20..28).ok_or("payload start header is truncated")?)?;
    SIGNATURE_HEADER_LEN
        .checked_add(next_offset)
        .and_then(|n| n.checked_add(next_size))
        .ok_or_else(|| "payload start header declares an implausibly large archive".to_string())
}

fn u64_le(bytes: &[u8]) -> Result<u64, String> {
    let arr: [u8; 8] = bytes.try_into().map_err(|_| "malformed 7-Zip header field".to_string())?;
    Ok(u64::from_le_bytes(arr))
}

/// Verify a volume set is COMPLETE and self-consistent against the archive length
/// the `.001` start header implies. The `.001` size is taken as the volume size
/// (every volume but the last must be exactly that, the last the remainder), and
/// the volumes must total the archive length. A missing tail, a short interior
/// volume, or a wrong count is caught HERE, before the bulk download — a cheap
/// fail-fast. (It anchors completeness to the header-derived length, not the
/// publisher's exact chunking, which only the per-block 7z CRC fully proves on
/// extraction.) Pure over the sizes so it is unit-tested without a network call.
fn verify_volume_set(sizes: &[u64], archive_len: u64) -> Result<(), String> {
    let count = sizes.len();
    let volume_size = *sizes.first().ok_or("incomplete volume set: no `.001` volume")?;
    if volume_size == 0 {
        return Err("incomplete volume set: the `.001` volume is empty".to_string());
    }
    let expected = archive_len.div_ceil(volume_size) as usize;
    if expected != count {
        return Err(format!(
            "incomplete volume set: the start header implies {expected} volume(s), but {count} are present"
        ));
    }
    let aggregate: u64 = sizes.iter().sum();
    if aggregate != archive_len {
        return Err(format!(
            "incomplete volume set: volumes total {aggregate} bytes, the archive expects {archive_len}"
        ));
    }
    // Each volume but the last is exactly the volume size; the last is the
    // remainder. (The aggregate check above already implies the last; this names
    // the offending volume when an interior one is short.)
    for (i, &size) in sizes.iter().enumerate() {
        let want = if i + 1 == count { archive_len - (count as u64 - 1) * volume_size } else { volume_size };
        if size != want {
            return Err(format!(
                "incomplete volume set: volume {:03} is {size} bytes, expected {want}",
                i + 1
            ));
        }
    }
    Ok(())
}

/// Read the first `SIGNATURE_HEADER_LEN` bytes of `url` (a Range request, capped
/// regardless so a server ignoring Range can't stream the whole volume at us) and
/// return the archive length its start header implies.
fn probe_archive_len(url: &str, token: &str) -> Result<u64, String> {
    let resp = github_http::get(url, token)
        .set("Range", &format!("bytes=0-{}", SIGNATURE_HEADER_LEN - 1))
        .call()
        .map_err(|e| format!("payload header probe failed: {e}"))?;
    let mut buf = Vec::with_capacity(SIGNATURE_HEADER_LEN as usize);
    resp.into_reader()
        .take(SIGNATURE_HEADER_LEN)
        .read_to_end(&mut buf)
        .map_err(|e| format!("payload header read failed: {e}"))?;
    archive_len_from_start_header(&buf)
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

/// The extraction budget: the smaller of the decompression cap and what the disk
/// can actually hold (free minus headroom). Bounding the running budget to the free
/// disk is what stops a lying header that under-declares `size()` from driving the
/// decoder to ENOSPC — the actual-bytes guard trips first. Pure, so the bound is
/// unit-tested without a real disk.
fn disk_bounded_budget(max_uncompressed: u64, free: u64) -> u64 {
    max_uncompressed.min(free.saturating_sub(DISK_HEADROOM_BYTES))
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

/// A `Read + Seek` view over an ordered set of volume files as one contiguous
/// stream — the chained seek-reader (model: reassemble in place, no concatenated
/// temp copy). The 7-Zip reader seeks freely across pack streams and the end
/// header; this resolves each absolute position to the volume that holds it.
struct ChainedReader {
    volumes: Vec<Volume>,
    total: u64,
    pos: u64,
}

struct Volume {
    file: File,
    start: u64,
    len: u64,
}

impl ChainedReader {
    /// Open every path in order as one stream. Each file's length is taken from
    /// its metadata, so the virtual offsets line up with the split publish wrote.
    fn open(paths: &[PathBuf]) -> Result<Self, String> {
        let mut volumes = Vec::with_capacity(paths.len());
        let mut start = 0u64;
        for path in paths {
            let file = File::open(path).map_err(|e| format!("open volume {}: {e}", path.display()))?;
            let len = file
                .metadata()
                .map_err(|e| format!("stat volume {}: {e}", path.display()))?
                .len();
            volumes.push(Volume { file, start, len });
            start += len;
        }
        Ok(Self { volumes, total: start, pos: 0 })
    }
}

impl Read for ChainedReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.pos >= self.total || buf.is_empty() {
            return Ok(0);
        }
        let pos = self.pos;
        let Some(vol) = self.volumes.iter_mut().find(|v| pos >= v.start && pos < v.start + v.len)
        else {
            return Ok(0);
        };
        let local = pos - vol.start;
        vol.file.seek(SeekFrom::Start(local))?;
        let avail = vol.len - local;
        let want = avail.min(buf.len() as u64) as usize;
        let dst = buf
            .get_mut(..want)
            .ok_or_else(|| io::Error::other("volume read window overflow"))?;
        let n = vol.file.read(dst)?;
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for ChainedReader {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        let target = match from {
            SeekFrom::Start(n) => n as i128,
            SeekFrom::End(n) => self.total as i128 + n as i128,
            SeekFrom::Current(n) => self.pos as i128 + n as i128,
        };
        if target < 0 {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "seek before start of payload"));
        }
        self.pos = target as u64;
        Ok(self.pos)
    }
}

/// Confine an archive entry name under the content store: backslashes normalised,
/// then every path component must be a plain name (no `..`, root, or drive prefix)
/// — the Zip-Slip / 7z-slip guard, mirroring the trusted installer's source guard.
/// Returns the store-relative path when safe, else `None`.
fn confined_relative(entry_name: &str) -> Option<PathBuf> {
    let normalised = entry_name.replace('\\', "/");
    if normalised.is_empty() {
        return None;
    }
    if dcs_studio_project::install::stays_under(&normalised) {
        Some(PathBuf::from(normalised))
    } else {
        None
    }
}

/// Extract a 7-Zip archive (read through `reader`) into a fresh `store`, capped by
/// entry count and a running budget of ACTUAL decompressed bytes, and confined to
/// the store. Returns the bytes actually written. The 7-Zip decoder verifies block
/// CRCs as it reads, so a corrupt volume surfaces as an extraction error. A failure
/// leaves a half-written store, which the caller drops.
fn extract_7z<R: Read + Seek>(
    reader: R,
    store: &Path,
    max_uncompressed: u64,
    max_entries: usize,
) -> Result<u64, String> {
    use sevenz_rust2::{ArchiveReader, Password};

    let _ = std::fs::remove_dir_all(store);
    std::fs::create_dir_all(store).map_err(|e| format!("create store: {e}"))?;

    let mut archive = ArchiveReader::new(reader, Password::empty())
        .map_err(|e| format!("open 7-Zip payload: {e}"))?;
    let entry_count = archive.archive().files.len();
    if entry_count > max_entries {
        return Err("payload has too many files to install".to_string());
    }
    // Friendly fast-fail on the DECLARED total — a clear "not enough disk" before any
    // write, when an HONEST archive obviously won't fit. The hard guarantee is the
    // disk-bounded budget below, which never trusts `declared`.
    let declared: u64 = archive.archive().files.iter().filter(|f| !f.is_directory()).map(|f| f.size()).sum();
    ensure_free_space(store, declared)?;

    let store = store.to_path_buf();
    let mut budget = disk_bounded_budget(max_uncompressed, free_space(&store)?);
    let mut written_total: u64 = 0;
    let mut guard_error: Option<String> = None;

    let result = archive.for_each_entries(|entry, entry_reader| {
        let Some(rel) = confined_relative(entry.name()) else {
            guard_error =
                Some(format!("payload entry '{}' escapes the content store — refusing", entry.name()));
            return Ok(false);
        };
        let out = store.join(&rel);
        if entry.is_directory() {
            if let Err(e) = std::fs::create_dir_all(&out) {
                guard_error = Some(format!("unpack dir {}: {e}", rel.display()));
                return Ok(false);
            }
            return Ok(true);
        }
        if let Some(parent) = out.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                guard_error = Some(format!("unpack parent {}: {e}", rel.display()));
                return Ok(false);
            }
        }
        let mut file = match File::create(&out) {
            Ok(f) => f,
            Err(e) => {
                guard_error = Some(format!("unpack file {}: {e}", rel.display()));
                return Ok(false);
            }
        };
        // Read at most budget+1 so an oversize entry (honest OR lying-header) trips
        // the check on bytes actually written, never on the declared size.
        let mut limited = entry_reader.take(budget + 1);
        match io::copy(&mut limited, &mut file) {
            Ok(written) => {
                if written > budget {
                    guard_error = Some("payload is too large when decompressed".to_string());
                    return Ok(false);
                }
                budget -= written;
                written_total += written;
                Ok(true)
            }
            Err(e) => {
                guard_error = Some(format!("unpack write {}: {e}", rel.display()));
                Ok(false)
            }
        }
    });

    if let Err(e) = result {
        return Err(format!("payload extraction failed (corrupt or unreadable archive): {e}"));
    }
    if let Some(e) = guard_error {
        return Err(e);
    }
    Ok(written_total)
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
    let mut budget = disk_bounded_budget(max_uncompressed, free_space(store)?);
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

    let reader = ChainedReader::open(&volume_paths)?;
    let written = extract_7z(reader, store, MAX_UNCOMPRESSED_BYTES, MAX_PAYLOAD_ENTRIES);
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
        verify_volume_set(&sizes, archive_len)?;
    }

    fetch_into_store(&plan, owner, name, token, store)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

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

    // --- start header + volume verification ---------------------------------

    fn start_header(archive_len: u64) -> Vec<u8> {
        // SIGNATURE_HEADER_LEN + next_offset + next_size == archive_len.
        let next_size = 20u64;
        let next_offset = archive_len - SIGNATURE_HEADER_LEN - next_size;
        let mut h = Vec::new();
        h.extend_from_slice(&SEVENZ_SIGNATURE);
        h.extend_from_slice(&[0u8, 4u8]); // version
        h.extend_from_slice(&0u32.to_le_bytes()); // start header CRC (unchecked here)
        h.extend_from_slice(&next_offset.to_le_bytes());
        h.extend_from_slice(&next_size.to_le_bytes());
        h.extend_from_slice(&0u32.to_le_bytes()); // next header CRC
        h
    }

    #[test]
    fn archive_len_is_derived_from_the_start_header() {
        let header = start_header(2500);
        assert_eq!(archive_len_from_start_header(&header).unwrap(), 2500);
    }

    #[test]
    fn a_non_7z_start_header_is_rejected() {
        let err = archive_len_from_start_header(&[0u8; 32]).expect_err("bad signature");
        assert!(err.contains("not a 7-Zip archive"), "{err}");
    }

    #[test]
    fn a_complete_volume_set_passes_verification() {
        // 2500-byte archive at 1000/volume → 1000 + 1000 + 500.
        verify_volume_set(&[1000, 1000, 500], 2500).expect("a complete set");
    }

    #[test]
    fn a_missing_final_volume_fails_fast() {
        // The header implies 2500 bytes (3 volumes), but the last is absent.
        let err = verify_volume_set(&[1000, 1000], 2500).expect_err("missing final volume");
        assert!(err.contains("incomplete volume set"), "{err}");
        assert!(err.contains("3 volume") || err.contains("2 are present"), "names the shortfall: {err}");
    }

    #[test]
    fn a_short_interior_volume_is_named() {
        let err = verify_volume_set(&[1000, 900, 500], 2500).expect_err("short interior volume");
        assert!(err.contains("incomplete volume set"), "{err}");
    }

    // --- confinement guard --------------------------------------------------

    #[test]
    fn confined_relative_rejects_escapes() {
        assert!(confined_relative("a/b.txt").is_some());
        assert!(confined_relative("..\\..\\evil").is_none(), "windows-style parent escape");
        assert!(confined_relative("../evil").is_none(), "posix parent escape");
        assert!(confined_relative("/abs").is_none(), "absolute path");
        assert!(confined_relative("").is_none(), "empty name");
    }

    // --- disk pre-flight ----------------------------------------------------

    #[test]
    fn disk_shortfall_accounts_for_headroom() {
        assert!(disk_shortfall(DISK_HEADROOM_BYTES + 1000, 0).is_none(), "headroom satisfied");
        assert!(disk_shortfall(10, 1_000_000).is_some(), "obviously insufficient");
        // Exactly need+headroom is enough; one byte short is not.
        assert!(disk_shortfall(1000 + DISK_HEADROOM_BYTES, 1000).is_none());
        assert_eq!(disk_shortfall(DISK_HEADROOM_BYTES, 1000), Some(1000));
    }

    #[test]
    fn budget_is_bounded_by_free_disk_not_just_the_cap() {
        // Ample disk → the decompression cap governs.
        assert_eq!(disk_bounded_budget(16 * 1024, 1 << 40), 16 * 1024);
        // Scarce disk → free-minus-headroom governs, BELOW the cap: the lying-header
        // disk guard, the budget can't exceed what the disk actually holds.
        assert_eq!(disk_bounded_budget(u64::MAX, DISK_HEADROOM_BYTES + 4096), 4096);
        // Disk at/under headroom → zero budget; the first byte trips before ENOSPC.
        assert_eq!(disk_bounded_budget(u64::MAX, DISK_HEADROOM_BYTES), 0);
    }

    // --- chained reader + 7z round-trip -------------------------------------

    /// Build a real `.7z` in memory from `(name, bytes)` entries via the writer
    /// the publish side uses, so the read path is exercised against a genuine
    /// archive (not a hand-rolled fixture).
    fn build_7z(entries: &[(&str, &[u8])]) -> Vec<u8> {
        use sevenz_rust2::{ArchiveEntry, ArchiveWriter};
        let mut writer = ArchiveWriter::new(Cursor::new(Vec::new())).expect("writer");
        for (name, data) in entries {
            writer
                .push_archive_entry(ArchiveEntry::new_file(name), Some(Cursor::new(data.to_vec())))
                .expect("entry");
        }
        writer.finish().expect("finish").into_inner()
    }

    /// Write `bytes` split into `chunk`-sized files under a temp dir, returning the
    /// ordered volume paths — the raw byte-split publish produces.
    fn split_to_files(bytes: &[u8], chunk: usize, tag: &str) -> (PathBuf, Vec<PathBuf>) {
        let dir = std::env::temp_dir().join(format!("dcs-7z-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        let mut paths = Vec::new();
        for (i, part) in bytes.chunks(chunk).enumerate() {
            let path = dir.join(format!("vol.{:03}", i + 1));
            std::fs::write(&path, part).expect("write volume");
            paths.push(path);
        }
        (dir, paths)
    }

    #[test]
    fn chained_reader_reassembles_and_extracts_a_split_archive() {
        let payload = vec![b'Z'; 5000];
        let archive = build_7z(&[("models/jet.bin", &payload), ("readme.txt", b"hi")]);
        // Split across volumes much smaller than the archive — and verify the set.
        let (dir, paths) = split_to_files(&archive, 256, "roundtrip");
        let sizes: Vec<u64> = paths.iter().map(|p| std::fs::metadata(p).unwrap().len()).collect();
        verify_volume_set(&sizes, archive.len() as u64).expect("a complete split");

        let store = dir.join("store");
        let reader = ChainedReader::open(&paths).expect("chained reader");
        extract_7z(reader, &store, MAX_UNCOMPRESSED_BYTES, MAX_PAYLOAD_ENTRIES).expect("extract");

        assert_eq!(std::fs::read(store.join("models/jet.bin")).unwrap(), payload, "byte-for-byte");
        assert_eq!(std::fs::read(store.join("readme.txt")).unwrap(), b"hi");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Incompressible bytes (a cheap LCG), so the `.7z` stays large enough to
    /// genuinely span several volumes — repetitive data would compress to one
    /// chunk and defeat the point of the test.
    fn incompressible(n: usize) -> Vec<u8> {
        (0..n as u32)
            .map(|i| {
                let x = i.wrapping_mul(2_654_435_761).wrapping_add(12345);
                ((x >> 24) ^ (x >> 8)) as u8
            })
            .collect()
    }

    #[test]
    fn a_single_file_larger_than_a_volume_round_trips() {
        // One entry whose bytes span several volumes (the case "many independent
        // zips" can't handle — a single oversized file split across volumes).
        let big = incompressible(16384);
        let archive = build_7z(&[("liveries/huge.dds", &big)]);
        let (dir, paths) = split_to_files(&archive, 1024, "bigfile");
        assert!(paths.len() > 1, "the archive really did split");

        let store = dir.join("store");
        let reader = ChainedReader::open(&paths).expect("reader");
        extract_7z(reader, &store, MAX_UNCOMPRESSED_BYTES, MAX_PAYLOAD_ENTRIES).expect("extract");
        assert_eq!(std::fs::read(store.join("liveries/huge.dds")).unwrap(), big);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn extraction_stops_at_the_actual_byte_budget() {
        // 8 KiB of real payload, a 1 KiB budget — the 7z path must trip on actual
        // bytes (the zip-bomb guard ported to 7z).
        let payload = vec![b'A'; 8192];
        let archive = build_7z(&[("big.bin", &payload)]);
        let (dir, paths) = split_to_files(&archive, 4096, "bomb");
        let store = dir.join("store");
        let reader = ChainedReader::open(&paths).expect("reader");
        let err = extract_7z(reader, &store, 1024, MAX_PAYLOAD_ENTRIES).expect_err("budget tripped");
        assert!(err.contains("too large when decompressed"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn too_many_entries_is_refused() {
        let archive = build_7z(&[("a.txt", b"a"), ("b.txt", b"b"), ("c.txt", b"c")]);
        let (dir, paths) = split_to_files(&archive, 4096, "entries");
        let store = dir.join("store");
        let reader = ChainedReader::open(&paths).expect("reader");
        let err = extract_7z(reader, &store, MAX_UNCOMPRESSED_BYTES, 2).expect_err("entry cap");
        assert!(err.contains("too many files"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn non_ascii_filenames_round_trip() {
        // UTF-8 / Cyrillic entry names preserved byte-for-byte through extraction.
        let archive = build_7z(&[("Скрипты/миссия.lua", b"-- ok")]);
        let (dir, paths) = split_to_files(&archive, 512, "utf8");
        let store = dir.join("store");
        let reader = ChainedReader::open(&paths).expect("reader");
        extract_7z(reader, &store, MAX_UNCOMPRESSED_BYTES, MAX_PAYLOAD_ENTRIES).expect("extract");
        assert_eq!(std::fs::read(store.join("Скрипты/миссия.lua")).unwrap(), b"-- ok");
        let _ = std::fs::remove_dir_all(&dir);
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
