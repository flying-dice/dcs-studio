//! studio-archive — the 7-Zip multi-volume payload facade for DCS Studio
//! (issue #62). The ONE place that names `sevenz-rust2`.
//!
//! * **Publish** packages the manifest + `[[install]]` sources into a `.7z`
//!   ([`SevenZipWriter`]) and byte-splits it into GitHub-safe volumes
//!   ([`split_into_volumes`]) — a raw split of one `.7z` stream, so concatenating
//!   the volumes reproduces the archive and `7z x <base>.7z.001` reassembles it
//!   natively.
//! * **Install** verifies a volume set is complete from the `.001` start header
//!   ([`archive_len_from_start_header`] + [`verify_volume_set`]), reads the volumes
//!   in place through a chained seek-reader ([`ChainedReader`]), and extracts them
//!   ([`extract`]) under the untrusted-payload guards: path-confinement, a budget
//!   measured on ACTUAL decompressed bytes (a lying declared size is never trusted)
//!   bounded by the caller's free-disk figure, and an entry-count cap.
//!
//! No GitHub, no manifest, no store/ledger policy lives here — only the archive
//! mechanism. The caller owns naming conventions, the network, free-disk probing,
//! and where the bytes land. `sevenz-rust2` is blocking — callers run it off the
//! UI thread.

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};

use sevenz_rust2::{ArchiveEntry, ArchiveReader, ArchiveWriter, Password};

/// The 6-byte 7-Zip signature that opens every `.7z` (and thus every `.001`).
const SEVENZ_SIGNATURE: [u8; 6] = [0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C];

/// The fixed 7-Zip signature-header length: 6 sig + 2 version + 4 CRC + 20 start
/// header. `NextHeaderOffset` is relative to its end, so the whole archive is
/// `SIGNATURE_HEADER_LEN + NextHeaderOffset + NextHeaderSize` bytes — what callers
/// Range-fetch from `.001` to size the volume set before downloading it.
pub const SIGNATURE_HEADER_LEN: u64 = 32;

// --- writing (publish side) ---------------------------------------------------

/// A streaming 7-Zip writer: push entries one at a time (each source streamed,
/// never buffered whole) into a `.7z` file. Wraps `sevenz-rust2`'s `ArchiveWriter`
/// so callers never name the dependency.
pub struct SevenZipWriter {
    inner: ArchiveWriter<File>,
}

impl SevenZipWriter {
    /// Create a `.7z` at `path`.
    pub fn create(path: &Path) -> Result<Self, String> {
        let inner = ArchiveWriter::create(path).map_err(|e| format!("create 7z payload: {e}"))?;
        Ok(Self { inner })
    }

    /// Add `source` under the archive-relative `entry_name` (forward-slashed),
    /// streaming the file and preserving its timestamps. UTF-8 names keep
    /// non-ASCII (e.g. Cyrillic) filenames byte-for-byte.
    pub fn push_file(&mut self, entry_name: &str, source: &Path) -> Result<(), String> {
        let file = File::open(source).map_err(|e| format!("read {}: {e}", source.display()))?;
        let entry = ArchiveEntry::from_path(source, entry_name.to_string());
        self.inner
            .push_archive_entry(entry, Some(file))
            .map_err(|e| format!("7z entry {entry_name}: {e}"))?;
        Ok(())
    }

    /// Add an entry from an in-memory / streaming reader under `entry_name`.
    pub fn push_reader(&mut self, entry_name: &str, reader: impl Read) -> Result<(), String> {
        self.inner
            .push_archive_entry(ArchiveEntry::new_file(entry_name), Some(reader))
            .map_err(|e| format!("7z entry {entry_name}: {e}"))?;
        Ok(())
    }

    /// Finish the archive, flushing the footer.
    pub fn finish(self) -> Result<(), String> {
        self.inner.finish().map_err(|e| format!("finish 7z payload: {e}"))?;
        Ok(())
    }
}

// --- splitting (publish side) -------------------------------------------------

/// Byte-split `archive` into ordered `<archive>.001`, `.002`, … volumes of
/// `volume_size` bytes each (the last is the remainder), streamed through a fixed
/// buffer so the payload is never fully in RAM. Concatenating the volumes
/// reproduces `archive` exactly, so `7z x <base>.7z.001` reassembles it natively.
/// Removes `archive`; returns the volume paths in order. A mid-split failure leaks
/// nothing (the partial volume, every prior volume, and the source `.7z` are
/// removed).
pub fn split_into_volumes(archive: &Path, volume_size: u64) -> Result<Vec<PathBuf>, String> {
    let total = std::fs::metadata(archive).map_err(|e| format!("stat payload: {e}"))?.len();
    let mut src = File::open(archive).map_err(|e| format!("open payload: {e}"))?;
    let count = total.div_ceil(volume_size);
    let mut volumes = Vec::new();
    for index in 1..=count {
        let vol = volume_path(archive, index);
        if let Err(e) = write_one_volume(&mut src, &vol, volume_size, total, index) {
            drop(src);
            let _ = std::fs::remove_file(&vol);
            for written in &volumes {
                let _ = std::fs::remove_file(written);
            }
            let _ = std::fs::remove_file(archive);
            return Err(e);
        }
        volumes.push(vol);
    }
    drop(src);
    let _ = std::fs::remove_file(archive); // the volumes supersede the whole `.7z`
    Ok(volumes)
}

/// Copy the `index`-th `volume_size`-byte slice of `src` (the last is the
/// remainder) into a fresh volume file at `vol`, streamed through a fixed buffer.
fn write_one_volume(src: &mut File, vol: &Path, volume_size: u64, total: u64, index: u64) -> Result<(), String> {
    let mut out = File::create(vol).map_err(|e| format!("create volume {index}: {e}"))?;
    let want = volume_size.min(total - (index - 1) * volume_size);
    let copied =
        io::copy(&mut src.take(want), &mut out).map_err(|e| format!("write volume {index}: {e}"))?;
    if copied != want {
        return Err(format!("payload split short at volume {index}: {copied} of {want} bytes"));
    }
    Ok(())
}

/// The `index`-th volume path: `<archive>.001`, `.002`, … (3-digit minimum,
/// 7-Zip's own naming).
#[must_use]
pub fn volume_path(archive: &Path, index: u64) -> PathBuf {
    PathBuf::from(format!("{}.{index:03}", archive.display()))
}

// --- volume-set completeness (install side) -----------------------------------

/// The whole-archive length encoded in a `.7z` 32-byte signature header:
/// `SIGNATURE_HEADER_LEN + NextHeaderOffset + NextHeaderSize`. This is what 7-Zip
/// itself reads from `.001` to know how many volumes a set must have.
pub fn archive_len_from_start_header(buf: &[u8]) -> Result<u64, String> {
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
pub fn verify_volume_set(sizes: &[u64], archive_len: u64) -> Result<(), String> {
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

// --- reassembly (install side) ------------------------------------------------

/// A `Read + Seek` view over an ordered set of volume files as one contiguous
/// stream — the chained seek-reader (reassemble in place, no concatenated temp
/// copy). The 7-Zip reader seeks freely across pack streams and the end header;
/// this resolves each absolute position to the volume that holds it.
pub struct ChainedReader {
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
    pub fn open(paths: &[PathBuf]) -> Result<Self, String> {
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
        let Some(vol) = self.volumes.iter_mut().find(|v| pos >= v.start && pos < v.start + v.len) else {
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

// --- extraction (install side) ------------------------------------------------

/// The untrusted-payload ceilings the caller imposes on [`extract`]: the
/// decompression budget (default ~16 GiB), the entry-count cap, and the free-disk
/// figure (free space minus the caller's headroom). The running budget is bounded
/// by `max_disk_bytes` so a lying header that under-declares its size can't drive
/// the decoder to ENOSPC — the actual-bytes guard trips first.
///
/// Contract: [`extract`] refuses up front when the DECLARED size exceeds
/// `max_disk_bytes`, and caps the actual-bytes budget at it — but it does NOT
/// pre-flight the download footprint (the compressed volumes already on disk). The
/// caller owns that pre-flight; on the install path it is `ensure_free_space`
/// against the aggregate download size before any volume lands.
pub struct ExtractLimits {
    pub max_uncompressed: u64,
    pub max_entries: usize,
    pub max_disk_bytes: u64,
}

/// Extract a 7-Zip archive (read through `reader`) into a fresh `dest`, capped by
/// entry count and a running budget of ACTUAL decompressed bytes (the smaller of
/// the decompression cap and what the disk can hold), and confined to `dest`.
/// Returns the bytes actually written. The 7-Zip decoder verifies block CRCs as it
/// reads, so a corrupt volume surfaces as an extraction error. A failure leaves a
/// half-written `dest`, which the caller drops.
pub fn extract<R: Read + Seek>(reader: R, dest: &Path, limits: ExtractLimits) -> Result<u64, String> {
    let _ = std::fs::remove_dir_all(dest);
    std::fs::create_dir_all(dest).map_err(|e| format!("create store: {e}"))?;

    let mut archive =
        ArchiveReader::new(reader, Password::empty()).map_err(|e| format!("open 7-Zip payload: {e}"))?;
    let entry_count = archive.archive().files.len();
    if entry_count > limits.max_entries {
        return Err("payload has too many files to install".to_string());
    }
    // Friendly fast-fail on the DECLARED total — a clear "not enough disk" before
    // any write, when an HONEST archive obviously won't fit. The hard guarantee is
    // the disk-bounded budget below, which never trusts `declared`.
    let declared: u64 = archive.archive().files.iter().filter(|f| !f.is_directory()).map(|f| f.size()).sum();
    if declared > limits.max_disk_bytes {
        return Err("not enough disk space to install the payload".to_string());
    }

    let dest = dest.to_path_buf();
    let mut budget = limits.max_uncompressed.min(limits.max_disk_bytes);
    let mut written_total: u64 = 0;
    let mut guard_error: Option<String> = None;

    let result = archive.for_each_entries(|entry, entry_reader| {
        let Some(rel) = confined_relative(entry.name()) else {
            guard_error =
                Some(format!("payload entry '{}' escapes the content store — refusing", entry.name()));
            return Ok(false);
        };
        let out = dest.join(&rel);
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
        // `saturating_add` so an effectively-unbounded budget can't overflow.
        let mut limited = entry_reader.take(budget.saturating_add(1));
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

/// Confine an archive entry name under the content store: backslashes normalised,
/// then every path component must be a plain name (no `..`, root, or drive prefix)
/// — the Zip-Slip / 7z-slip guard. Returns the store-relative path when safe.
fn confined_relative(entry_name: &str) -> Option<PathBuf> {
    let normalised = entry_name.replace('\\', "/");
    if normalised.is_empty() {
        return None;
    }
    let path = Path::new(&normalised);
    if path.components().all(|c| matches!(c, Component::Normal(_))) {
        Some(path.to_path_buf())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    // --- helpers ------------------------------------------------------------

    /// Build a real `.7z` in memory from `(name, bytes)` entries via the writer
    /// facade, so the read path is exercised against a genuine archive.
    fn build_7z(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut inner = ArchiveWriter::new(Cursor::new(Vec::new())).expect("writer");
        for (name, data) in entries {
            inner
                .push_archive_entry(ArchiveEntry::new_file(name), Some(Cursor::new(data.to_vec())))
                .expect("entry");
        }
        inner.finish().expect("finish").into_inner()
    }

    /// Write `bytes` split into `chunk`-sized files under a temp dir, returning the
    /// ordered volume paths — the raw byte-split publish produces.
    fn split_to_files(bytes: &[u8], chunk: usize, tag: &str) -> (PathBuf, Vec<PathBuf>) {
        let dir = std::env::temp_dir().join(format!("studio-archive-{tag}-{}", std::process::id()));
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

    /// Incompressible bytes (a cheap LCG), so the `.7z` stays large enough to
    /// genuinely span several volumes — repetitive data would compress to one chunk.
    fn incompressible(n: usize) -> Vec<u8> {
        (0..n as u32)
            .map(|i| {
                let x = i.wrapping_mul(2_654_435_761).wrapping_add(12345);
                ((x >> 24) ^ (x >> 8)) as u8
            })
            .collect()
    }

    fn unbounded() -> ExtractLimits {
        ExtractLimits { max_uncompressed: u64::MAX, max_entries: 20_000, max_disk_bytes: u64::MAX }
    }

    // --- writer + split round-trip ------------------------------------------

    #[test]
    fn writer_streams_entries_and_split_round_trips() {
        let dir = std::env::temp_dir().join(format!("studio-archive-w-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        let archive = dir.join("payload.7z");
        let payload = incompressible(8192);
        let mut w = SevenZipWriter::create(&archive).expect("create");
        w.push_reader("models/jet.bin", Cursor::new(payload.clone())).expect("push");
        w.finish().expect("finish");
        let whole = std::fs::read(&archive).expect("archive bytes");

        let volumes = split_into_volumes(&archive, 1024).expect("split");
        assert!(volumes.len() > 1, "incompressible payload really splits");
        assert!(!archive.exists(), "source `.7z` removed after split");
        let restitched: Vec<u8> = volumes.iter().flat_map(|v| std::fs::read(v).expect("vol")).collect();
        assert_eq!(restitched, whole, "volumes concatenate back to the archive");

        // And the split set verifies + extracts back to the original tree.
        let sizes: Vec<u64> = volumes.iter().map(|v| std::fs::metadata(v).unwrap().len()).collect();
        verify_volume_set(&sizes, whole.len() as u64).expect("complete set");
        let store = dir.join("store");
        let reader = ChainedReader::open(&volumes).expect("reader");
        extract(reader, &store, unbounded()).expect("extract");
        assert_eq!(std::fs::read(store.join("models/jet.bin")).unwrap(), payload);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn volume_path_pads_to_three_digits() {
        let base = Path::new("/tmp/dcs-studio-mod-v1.7z");
        assert_eq!(volume_path(base, 1), PathBuf::from("/tmp/dcs-studio-mod-v1.7z.001"));
        assert_eq!(volume_path(base, 42), PathBuf::from("/tmp/dcs-studio-mod-v1.7z.042"));
        assert_eq!(volume_path(base, 1000), PathBuf::from("/tmp/dcs-studio-mod-v1.7z.1000"));
    }

    #[test]
    fn split_into_volumes_sizes_each_volume_and_cleans_up_on_error() {
        let dir = std::env::temp_dir().join(format!("studio-archive-split-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        // 2500 bytes split at 1000 → 1000 + 1000 + 500.
        let archive = dir.join("payload.7z");
        std::fs::write(&archive, vec![7u8; 2500]).expect("write");
        let volumes = split_into_volumes(&archive, 1000).expect("split");
        let sizes: Vec<u64> = volumes.iter().map(|v| std::fs::metadata(v).unwrap().len()).collect();
        assert_eq!(sizes, vec![1000, 1000, 500]);

        // A mid-split failure cleans up: volume 2's path is a pre-existing dir.
        let archive2 = dir.join("payload2.7z");
        std::fs::write(&archive2, vec![1u8; 2500]).expect("write");
        std::fs::create_dir_all(volume_path(&archive2, 2)).expect("blocker dir");
        let err = split_into_volumes(&archive2, 1000).expect_err("split fails at volume 2");
        assert!(err.contains("volume 2"), "names the failing volume: {err}");
        assert!(!volume_path(&archive2, 1).exists(), "partial volume 1 cleaned");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // --- start header + verification ----------------------------------------

    fn start_header(archive_len: u64) -> Vec<u8> {
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
        assert_eq!(archive_len_from_start_header(&start_header(2500)).unwrap(), 2500);
        let err = archive_len_from_start_header(&[0u8; 32]).expect_err("bad signature");
        assert!(err.contains("not a 7-Zip archive"), "{err}");
    }

    #[test]
    fn a_complete_set_passes_and_a_missing_or_short_volume_fails_fast() {
        verify_volume_set(&[1000, 1000, 500], 2500).expect("a complete set");
        let missing = verify_volume_set(&[1000, 1000], 2500).expect_err("missing final volume");
        assert!(missing.contains("incomplete volume set"), "{missing}");
        let short = verify_volume_set(&[1000, 900, 500], 2500).expect_err("short interior volume");
        assert!(short.contains("incomplete volume set"), "{short}");
    }

    // --- confinement --------------------------------------------------------

    #[test]
    fn confined_relative_rejects_escapes() {
        assert!(confined_relative("a/b.txt").is_some());
        assert!(confined_relative("..\\..\\evil").is_none(), "windows-style parent escape");
        assert!(confined_relative("../evil").is_none(), "posix parent escape");
        assert!(confined_relative("/abs").is_none(), "absolute path");
        assert!(confined_relative("").is_none(), "empty name");
    }

    // --- extract: round-trip, big file, caps, i18n --------------------------

    #[test]
    fn a_single_file_larger_than_a_volume_round_trips() {
        let big = incompressible(16384);
        let archive = build_7z(&[("liveries/huge.dds", &big)]);
        let (dir, paths) = split_to_files(&archive, 1024, "bigfile");
        assert!(paths.len() > 1, "the archive really did split");
        let store = dir.join("store");
        let reader = ChainedReader::open(&paths).expect("reader");
        extract(reader, &store, unbounded()).expect("extract");
        assert_eq!(std::fs::read(store.join("liveries/huge.dds")).unwrap(), big);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn extraction_stops_at_the_actual_byte_budget() {
        let payload = vec![b'A'; 8192];
        let archive = build_7z(&[("big.bin", &payload)]);
        let (dir, paths) = split_to_files(&archive, 4096, "bomb");
        let store = dir.join("store");
        let reader = ChainedReader::open(&paths).expect("reader");
        let limits = ExtractLimits { max_uncompressed: 1024, max_entries: 20_000, max_disk_bytes: u64::MAX };
        let err = extract(reader, &store, limits).expect_err("budget tripped");
        assert!(err.contains("too large when decompressed"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_budget_is_bounded_by_the_disk_figure() {
        // A generous decompression cap but a tiny disk figure: the disk bound wins,
        // so the 8 KiB payload is refused — the lying-header ENOSPC guard.
        let payload = incompressible(8192);
        let archive = build_7z(&[("big.bin", &payload)]);
        let (dir, paths) = split_to_files(&archive, 4096, "disk");
        let store = dir.join("store");
        let reader = ChainedReader::open(&paths).expect("reader");
        let limits = ExtractLimits { max_uncompressed: u64::MAX, max_entries: 20_000, max_disk_bytes: 1024 };
        // declared (8192) already exceeds the disk figure → friendly fast-fail.
        let err = extract(reader, &store, limits).expect_err("disk bound trips");
        assert!(err.contains("not enough disk space"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn too_many_entries_is_refused() {
        let archive = build_7z(&[("a.txt", b"a"), ("b.txt", b"b"), ("c.txt", b"c")]);
        let (dir, paths) = split_to_files(&archive, 4096, "entries");
        let store = dir.join("store");
        let reader = ChainedReader::open(&paths).expect("reader");
        let limits = ExtractLimits { max_uncompressed: u64::MAX, max_entries: 2, max_disk_bytes: u64::MAX };
        let err = extract(reader, &store, limits).expect_err("entry cap");
        assert!(err.contains("too many files"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn non_ascii_filenames_round_trip() {
        let archive = build_7z(&[("Скрипты/миссия.lua", b"-- ok")]);
        let (dir, paths) = split_to_files(&archive, 512, "utf8");
        let store = dir.join("store");
        let reader = ChainedReader::open(&paths).expect("reader");
        extract(reader, &store, unbounded()).expect("extract");
        assert_eq!(std::fs::read(store.join("Скрипты/миссия.lua")).unwrap(), b"-- ok");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
