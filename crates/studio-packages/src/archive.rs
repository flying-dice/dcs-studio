//! The `.dcspkg` artifact — a zip of `package.json` (the signed manifest),
//! `signature.json`, and the payload tree under `files/`.

use std::io::{Read, Write};
use std::path::Path;

use crate::manifest::PackageManifest;
use crate::signing::Signature;

const MANIFEST_NAME: &str = "package.json";
const SIGNATURE_NAME: &str = "signature.json";
const FILES_PREFIX: &str = "files/";

/// Hard cap on total extracted payload bytes — extraction runs on UNTRUSTED
/// input BEFORE the signature gate, so a decompression bomb or a forged
/// uncompressed size must not exhaust memory/disk. 512 MiB is generous for a
/// real mod and bounds the bomb.
const MAX_PAYLOAD_BYTES: u64 = 512 * 1024 * 1024;
/// Cap on the header JSON entries (`package.json` / `signature.json`) — small
/// by construction; anything larger is hostile.
const MAX_HEADER_BYTES: u64 = 4 * 1024 * 1024;

/// Write a `.dcspkg` to `out_path`: the manifest, the signature, and every file
/// under `payload_root` placed at `files/<rel>`.
///
/// # Errors
/// Returns `Err` on any I/O or zip failure.
pub fn write(
    out_path: &Path,
    manifest: &PackageManifest,
    signature: &Signature,
    payload_root: &Path,
) -> Result<(), String> {
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("creating {}: {e}", parent.display()))?;
    }
    let file = std::fs::File::create(out_path)
        .map_err(|e| format!("creating {}: {e}", out_path.display()))?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default();

    write_entry(&mut zip, opts, MANIFEST_NAME, &to_pretty(manifest)?)?;
    write_entry(&mut zip, opts, SIGNATURE_NAME, &to_pretty(signature)?)?;

    let mut files = crate::fsutil::walk(payload_root)?;
    files.sort_by(|a, b| a.0.cmp(&b.0));
    for (rel, path) in files {
        let bytes = std::fs::read(&path).map_err(|e| format!("reading {}: {e}", path.display()))?;
        write_entry(&mut zip, opts, &format!("{FILES_PREFIX}{rel}"), &bytes)?;
    }
    zip.finish().map_err(|e| format!("finishing zip: {e}"))?;
    Ok(())
}

/// Read just the header (manifest + signature) — for discovery and install.
///
/// # Errors
/// Returns `Err` when the artifact is unreadable or missing its header entries.
pub fn read_header(artifact: &Path) -> Result<(PackageManifest, Signature), String> {
    let file = std::fs::File::open(artifact)
        .map_err(|e| format!("opening {}: {e}", artifact.display()))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("reading zip: {e}"))?;
    let manifest: PackageManifest = read_json(&mut zip, MANIFEST_NAME)?;
    let signature: Signature = read_json(&mut zip, SIGNATURE_NAME)?;
    Ok((manifest, signature))
}

/// Extract the `files/` payload tree to `dest_dir` (created fresh).
///
/// # Errors
/// Returns `Err` on any I/O or zip failure.
pub fn extract_payload(artifact: &Path, dest_dir: &Path) -> Result<(), String> {
    extract_payload_bounded(artifact, dest_dir, MAX_PAYLOAD_BYTES)
}

/// [`extract_payload`] with an explicit total-byte cap (the cap is injectable
/// so the bomb guard is testable without a 512 MiB fixture).
fn extract_payload_bounded(artifact: &Path, dest_dir: &Path, max_bytes: u64) -> Result<(), String> {
    let file = std::fs::File::open(artifact)
        .map_err(|e| format!("opening {}: {e}", artifact.display()))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("reading zip: {e}"))?;
    let mut total: u64 = 0;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| format!("zip entry {i}: {e}"))?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().to_string();
        let Some(rel) = name.strip_prefix(FILES_PREFIX) else {
            continue;
        };
        // A zip entry name is attacker-controlled — reject any `..`/absolute
        // path so extraction cannot escape `dest_dir`.
        if !dcs_studio_project::install::stays_under(
            &rel.replace('/', std::path::MAIN_SEPARATOR_STR),
        ) {
            return Err(format!("package entry '{name}' escapes the payload root"));
        }
        let out = dest_dir.join(rel);
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("creating {}: {e}", parent.display()))?;
        }
        // Read BOUNDED — never trust the zip's declared `size()` for allocation
        // (a forged size overflows `with_capacity`; the real decompressed stream
        // may be a bomb). Read at most the remaining budget + 1, and reject if
        // the total would exceed the cap.
        let remaining = max_bytes.saturating_sub(total);
        let mut bytes = Vec::new();
        entry
            .by_ref()
            .take(remaining + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("reading entry {name}: {e}"))?;
        if bytes.len() as u64 > remaining {
            return Err("package payload exceeds the size limit".to_string());
        }
        total += bytes.len() as u64;
        std::fs::write(&out, &bytes).map_err(|e| format!("writing {}: {e}", out.display()))?;
    }
    Ok(())
}

fn write_entry<W: Write + std::io::Seek>(
    zip: &mut zip::ZipWriter<W>,
    opts: zip::write::SimpleFileOptions,
    name: &str,
    bytes: &[u8],
) -> Result<(), String> {
    zip.start_file(name, opts)
        .map_err(|e| format!("zip start {name}: {e}"))?;
    zip.write_all(bytes)
        .map_err(|e| format!("zip write {name}: {e}"))
}

fn read_json<T: serde::de::DeserializeOwned, R: Read + std::io::Seek>(
    zip: &mut zip::ZipArchive<R>,
    name: &str,
) -> Result<T, String> {
    let mut entry = zip
        .by_name(name)
        .map_err(|e| format!("package is missing {name}: {e}"))?;
    // Bounded: the header is small by construction; a forged size must not
    // exhaust memory. A truncated read fails to parse below — also rejected.
    let mut text = String::new();
    entry
        .by_ref()
        .take(MAX_HEADER_BYTES)
        .read_to_string(&mut text)
        .map_err(|e| format!("reading {name}: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("parsing {name}: {e}"))
}

fn to_pretty<T: serde::Serialize>(value: &T) -> Result<Vec<u8>, String> {
    serde_json::to_vec_pretty(value).map_err(|e| format!("serialising: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn extract_payload_refuses_a_zip_entry_that_escapes() {
        let dir = std::env::temp_dir().join(format!("pkg-zip-escape-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let archive = dir.join("evil.dcspkg");
        // A hand-built zip whose payload entry climbs out via `..` (zip-slip).
        {
            let file = std::fs::File::create(&archive).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let opts = zip::write::SimpleFileOptions::default();
            zip.start_file("files/../escape.txt", opts).unwrap();
            zip.write_all(b"pwned").unwrap();
            zip.finish().unwrap();
        }
        let dest = dir.join("out");
        let err = extract_payload(&archive, &dest).expect_err("escape must be refused");
        assert!(err.contains("escapes the payload root"), "{err}");
        // Nothing was written outside the destination.
        assert!(!dir.join("escape.txt").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn extract_payload_is_bounded_against_a_decompression_bomb() {
        let dir = std::env::temp_dir().join(format!("pkg-bomb-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let archive = dir.join("bomb.dcspkg");
        {
            let file = std::fs::File::create(&archive).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let opts = zip::write::SimpleFileOptions::default();
            zip.start_file("files/big.bin", opts).unwrap();
            zip.write_all(&vec![0u8; 4096]).unwrap();
            zip.finish().unwrap();
        }
        // A tiny cap stands in for the 512 MiB production cap: extraction must
        // refuse rather than write the over-budget payload.
        let dest = dir.join("out");
        let err = extract_payload_bounded(&archive, &dest, 64).expect_err("must be capped");
        assert!(err.contains("exceeds the size limit"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
