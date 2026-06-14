//! Content hashing — a stable SHA-256 over a payload tree that binds every byte.
//!
//! The digest folds each file's relative path and its bytes in path-sorted
//! order, so it is identical across machines and changes if any file is added,
//! removed, or altered. The signed manifest carries this hash, so a tampered
//! payload no longer matches and the install is refused before any link.

use std::path::Path;

use sha2::{Digest, Sha256};

/// SHA-256 (hex) over the sorted file tree under `dir`.
///
/// # Errors
/// Returns `Err` when the tree cannot be walked or a file cannot be read.
pub fn content_hash(dir: &Path) -> Result<String, String> {
    let mut entries = crate::fsutil::walk(dir)?;
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    let mut hasher = Sha256::new();
    for (rel, path) in entries {
        hasher.update(rel.as_bytes());
        hasher.update([0u8]);
        let bytes = std::fs::read(&path).map_err(|e| format!("reading {}: {e}", path.display()))?;
        hasher.update((bytes.len() as u64).to_le_bytes());
        hasher.update(&bytes);
    }
    Ok(hex(&hasher.finalize()))
}

/// Lower-case hex of a byte slice.
#[must_use]
pub(crate) fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes.iter().fold(String::new(), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}
