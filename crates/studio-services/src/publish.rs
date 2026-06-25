//! studio::publish — share a project to GitHub and cut a release (model
//! `model/studio/publish.pds`, issue #12). `share` creates a public repo, tags
//! it `dcs-studio` (so studio::market discovers it), then init/commit/push the
//! project via the installed `git`. `publish_release` packages the manifest +
//! every `[[install]]` source into a 7-Zip payload — split into GitHub-safe
//! volumes when large (issue #62) — creates a DRAFT release, uploads the
//! standalone `dcs-studio.toml` plus every payload volume, and only then flips
//! the release to published (so a partial failure never leaves a half-populated
//! public release). Both run as the logged-in user with a `public_repo`-scoped
//! token (issue #11/#12); the REST calls use ureq, the git calls shell out.
//! ureq + git are blocking — callers run this off the UI thread.

use std::fs::File;
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde::Deserialize;
use sevenz_rust2::{ArchiveEntry, ArchiveWriter};

use crate::github_http::{self, API_BASE};
use dcs_studio_project::{DISCOVERY_TOPIC, LIBRARY_TOPIC, MANIFEST_FILE, Manifest};

const UPLOADS_BASE: &str = "https://uploads.github.com";
/// The branch the initial commit is pushed to (model `DEFAULT_BRANCH`).
const DEFAULT_BRANCH: &str = "main";

/// How many times a transient release-asset upload is attempted before failing.
const UPLOAD_ATTEMPTS: u32 = 3;
/// Base backoff between upload attempts; doubled each retry.
const UPLOAD_BACKOFF: Duration = Duration::from_millis(500);

/// A created (or resolved) GitHub repository (model `RepoInfo`).
#[derive(Clone, Debug, serde::Serialize, Deserialize)]
pub struct RepoInfo {
    pub full_name: String,
    pub html_url: String,
    pub owner: String,
    pub name: String,
}

/// A created GitHub release (model `ReleaseInfo`).
#[derive(Clone, Debug, serde::Serialize, Deserialize)]
pub struct ReleaseInfo {
    pub tag: String,
    pub html_url: String,
}

/// The repo plan derived from the project manifest (model `RepoPlan`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RepoPlan {
    pub name: String,
    pub description: String,
    pub topics: Vec<String>,
    pub commit_message: String,
}

/// A read GitHub error body's `message`, or a transport error.
fn rest_error(context: &str, e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(code, resp) => {
            let msg = resp
                .into_json::<serde_json::Value>()
                .ok()
                .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(String::from))
                .unwrap_or_default();
            format!("{context} ({code}): {msg}")
        }
        other => format!("{context}: {other}"),
    }
}

// --- repo plan (pure) -------------------------------------------------------

/// A GitHub-safe repo slug: lowercase, non-alphanumerics → single `-`, trimmed.
fn slugify(name: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for c in name.trim().to_lowercase().chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '.' {
            out.push(c);
            prev_dash = false;
        } else if !prev_dash && !out.is_empty() {
            out.push('-');
            prev_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

/// The repo plan for a project named `project_name` (pure; the topic always
/// includes `dcs-studio`).
fn plan_for(project_name: &str, as_library: bool) -> RepoPlan {
    let slug = slugify(project_name);
    let name = if slug.is_empty() { "dcs-mod".to_string() } else { slug };
    // A library carries BOTH topics: it's still a discoverable dcs-studio repo,
    // additionally marked as a dependency-only library (issue #48).
    let mut topics = vec![DISCOVERY_TOPIC.to_string()];
    if as_library {
        topics.push(LIBRARY_TOPIC.to_string());
    }
    RepoPlan {
        name,
        description: format!("{project_name} — a DCS World mod built with DCS Studio"),
        topics,
        commit_message: "Initial commit (DCS Studio)".to_string(),
    }
}

/// The repo plan from the project's `dcs-studio.toml` (model `Registry.PlanRepo`).
/// `as_library` (a publish-time choice, no manifest field) tags the repo as a
/// dependency-only library.
pub fn plan_repo(root: &Path, as_library: bool) -> Result<RepoPlan, String> {
    let manifest = dcs_studio_project::manifest::load(root)?;
    Ok(plan_for(&manifest.project.name, as_library))
}

// --- GitHub write REST (model GitHubWrite) ----------------------------------

#[derive(Deserialize)]
struct RepoResp {
    full_name: String,
    html_url: String,
    name: String,
    owner: RepoOwner,
}
#[derive(Deserialize)]
struct RepoOwner {
    login: String,
}

impl From<RepoResp> for RepoInfo {
    fn from(r: RepoResp) -> Self {
        RepoInfo {
            full_name: r.full_name,
            html_url: r.html_url,
            owner: r.owner.login,
            name: r.name,
        }
    }
}

/// Create the repo, or — when it already exists for this user (422) — resolve and
/// return the existing one, so `share` is idempotent: a retry after a partial
/// failure re-tags/commits/pushes instead of dying on "name already exists".
fn create_repo(
    name: &str,
    description: &str,
    token: &str,
    login: Option<&str>,
) -> Result<RepoInfo, String> {
    let body = serde_json::json!({
        "name": name,
        "description": description,
        "private": false,
        "auto_init": false,
    });
    match github_http::post(&format!("{API_BASE}/user/repos"), token)
        .set("Accept", github_http::ACCEPT_JSON)
        .send_json(body)
    {
        Ok(resp) => Ok(resp
            .into_json::<RepoResp>()
            .map_err(|e| format!("create-repo response: {e}"))?
            .into()),
        // Already exists for this user — continue with the existing repo.
        Err(ureq::Error::Status(422, _)) => {
            let login =
                login.ok_or_else(|| "repo exists but no session to resolve it".to_string())?;
            fetch_repo(login, name, token)
        }
        Err(e) => Err(rest_error("create repo", e)),
    }
}

/// Resolve an existing repo (`GET /repos/{owner}/{name}`).
fn fetch_repo(owner: &str, name: &str, token: &str) -> Result<RepoInfo, String> {
    Ok(github_http::get(&format!("{API_BASE}/repos/{owner}/{name}"), token)
        .set("Accept", github_http::ACCEPT_JSON)
        .call()
        .map_err(|e| rest_error("fetch repo", e))?
        .into_json::<RepoResp>()
        .map_err(|e| format!("fetch-repo response: {e}"))?
        .into())
}

fn set_topics(repo: &RepoInfo, topics: &[String], token: &str) -> Result<(), String> {
    let body = serde_json::json!({ "names": topics });
    github_http::put(&format!("{API_BASE}/repos/{}/{}/topics", repo.owner, repo.name), token)
        .set("Accept", github_http::ACCEPT_JSON)
        .send_json(body)
        .map_err(|e| rest_error("set topics", e))?;
    Ok(())
}

/// A created or resolved release plus the id used to upload assets and publish it
/// (model `ReleaseRef`).
struct ReleaseRef {
    id: u64,
    info: ReleaseInfo,
}

/// A GitHub release as create/find return it.
#[derive(Deserialize)]
struct ReleaseResp {
    id: u64,
    html_url: String,
    tag_name: String,
}

impl From<ReleaseResp> for ReleaseRef {
    fn from(r: ReleaseResp) -> Self {
        ReleaseRef {
            id: r.id,
            info: ReleaseInfo {
                tag: r.tag_name,
                html_url: r.html_url,
            },
        }
    }
}

/// One asset already on a release (model `ReleaseAsset`) — its id (to delete) and
/// name (to match a re-upload against).
#[derive(Deserialize)]
struct AssetResp {
    id: u64,
    name: String,
}

/// `{API_BASE}/repos/{owner}/{name}{suffix}` — the repo-scoped API prefix every
/// release REST call shares (so the owner/name pair lives in one place).
fn repo_api(repo: &RepoInfo, suffix: &str) -> String {
    format!("{API_BASE}/repos/{}/{}{suffix}", repo.owner, repo.name)
}

/// Create a DRAFT release for `tag` (`draft: true`), so a half-uploaded release
/// is never publicly visible until every asset has landed.
fn create_draft_release(repo: &RepoInfo, tag: &str, body: &str, token: &str) -> Result<ReleaseRef, String> {
    let payload = serde_json::json!({ "tag_name": tag, "name": tag, "body": body, "draft": true });
    let resp: ReleaseResp = github_http::post(&repo_api(repo, "/releases"), token)
        .set("Accept", github_http::ACCEPT_JSON)
        .send_json(payload)
        .map_err(|e| rest_error("create draft release", e))?
        .into_json()
        .map_err(|e| format!("create-release response: {e}"))?;
    Ok(resp.into())
}

/// The existing release for `tag`, or `None` on 404 — reused so a re-publish
/// after a partial failure is idempotent rather than creating a duplicate.
fn find_release_by_tag(repo: &RepoInfo, tag: &str, token: &str) -> Result<Option<ReleaseRef>, String> {
    match github_http::get(&repo_api(repo, &format!("/releases/tags/{tag}")), token)
        .set("Accept", github_http::ACCEPT_JSON)
        .call()
    {
        Ok(resp) => {
            let r: ReleaseResp = resp
                .into_json()
                .map_err(|e| format!("find-release response: {e}"))?;
            Ok(Some(r.into()))
        }
        Err(ureq::Error::Status(404, _)) => Ok(None),
        Err(e) => Err(rest_error("find release", e)),
    }
}

/// Reuse the existing release for `tag` (idempotent), else create a fresh draft.
fn find_or_create_draft(repo: &RepoInfo, tag: &str, token: &str) -> Result<ReleaseRef, String> {
    match find_release_by_tag(repo, tag, token)? {
        Some(existing) => Ok(existing),
        None => create_draft_release(repo, tag, &format!("Release {tag}"), token),
    }
}

/// Every asset already on a release (paginated), for delete-then-replace.
fn release_assets(repo: &RepoInfo, release_id: u64, token: &str) -> Result<Vec<AssetResp>, String> {
    let mut all = Vec::new();
    let mut page = 1;
    loop {
        let batch: Vec<AssetResp> = github_http::get(
            &repo_api(repo, &format!("/releases/{release_id}/assets?per_page=100&page={page}")),
            token,
        )
        .set("Accept", github_http::ACCEPT_JSON)
        .call()
        .map_err(|e| rest_error("list assets", e))?
        .into_json()
        .map_err(|e| format!("list-assets response: {e}"))?;
        let full_page = batch.len() == 100;
        all.extend(batch);
        if !full_page {
            return Ok(all);
        }
        page += 1;
    }
}

/// Delete one release asset by id.
fn delete_asset(repo: &RepoInfo, asset_id: u64, token: &str) -> Result<(), String> {
    github_http::delete(&repo_api(repo, &format!("/releases/assets/{asset_id}")), token)
        .set("Accept", github_http::ACCEPT_JSON)
        .call()
        .map_err(|e| rest_error("delete asset", e))?;
    Ok(())
}

/// Flip a draft release to published.
fn publish_draft(repo: &RepoInfo, release_id: u64, token: &str) -> Result<(), String> {
    github_http::patch(&repo_api(repo, &format!("/releases/{release_id}")), token)
        .set("Accept", github_http::ACCEPT_JSON)
        .send_json(serde_json::json!({ "draft": false }))
        .map_err(|e| rest_error("publish release", e))?;
    Ok(())
}

/// A transient failure worth retrying: a 5xx status or a transport-level error.
fn is_transient(e: &ureq::Error) -> bool {
    matches!(e, ureq::Error::Status(code, _) if *code >= 500)
        || matches!(e, ureq::Error::Transport(_))
}

/// The file name of `path` as a `&str`, or an error naming the offending path.
fn asset_filename(path: &Path) -> Result<&str, String> {
    path.file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("asset has no filename: {}", path.display()))
}

/// Upload one file as a release asset, streaming its bytes from disk (a multi-GiB
/// volume is never fully read into RAM) and retrying a transient failure with
/// exponential backoff.
fn upload_asset(repo: &RepoInfo, release_id: u64, path: &Path, token: &str) -> Result<(), String> {
    let filename = asset_filename(path)?;
    let len = std::fs::metadata(path)
        .map_err(|e| format!("stat {}: {e}", path.display()))?
        .len();
    let url = format!(
        "{UPLOADS_BASE}/repos/{}/{}/releases/{release_id}/assets?name={filename}",
        repo.owner, repo.name
    );
    let mut attempt: u32 = 0;
    loop {
        attempt += 1;
        let file = File::open(path).map_err(|e| format!("read {}: {e}", path.display()))?;
        match github_http::post(&url, token)
            .set("Content-Type", "application/octet-stream")
            .set("Content-Length", &len.to_string())
            .send(file)
        {
            Ok(_) => return Ok(()),
            Err(e) if attempt < UPLOAD_ATTEMPTS && is_transient(&e) => {
                std::thread::sleep(UPLOAD_BACKOFF * 2_u32.pow(attempt - 1));
            }
            Err(e) => return Err(rest_error(&format!("upload asset {filename}"), e)),
        }
    }
}

// --- local git (model GitLocal), shelled ------------------------------------

/// Run `git -C <root> <args>`; map a non-zero exit to its stderr.
fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .map_err(|e| format!("git not found on PATH ({e}); install git to publish"))?;
    if !out.status.success() {
        return Err(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// The commit identity for `login` (the signed-in GitHub login resolved once at
/// the `share` entry), or a generic fallback when logged out — pure, no keyring.
fn committer_identity(login: Option<&str>) -> (String, String) {
    match login {
        Some(login) => (
            login.to_string(),
            format!("{login}@users.noreply.github.com"),
        ),
        None => (
            "DCS Studio".to_string(),
            "dcs-studio@users.noreply.github.com".to_string(),
        ),
    }
}

fn init_and_commit(root: &Path, message: &str, login: Option<&str>) -> Result<(), String> {
    git(root, &["init"])?;
    git(root, &["add", "-A"])?;
    let (name, email) = committer_identity(login);
    // Explicit -c identity so the commit works without global git config.
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args([
            "-c",
            &format!("user.name={name}"),
            "-c",
            &format!("user.email={email}"),
            "commit",
            "-m",
            message,
        ])
        .output()
        .map_err(|e| format!("git not found on PATH ({e}); install git to publish"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        // An already-committed tree ("nothing to commit") is fine to proceed past.
        if !stderr.contains("nothing to commit") {
            return Err(format!("git commit failed: {}", stderr.trim()));
        }
    }
    // Normalise the branch name regardless of the user's init.defaultBranch.
    git(root, &["branch", "-M", DEFAULT_BRANCH])?;
    Ok(())
}

fn set_remote(root: &Path, url: &str) -> Result<(), String> {
    // Replace any existing origin so re-sharing is idempotent.
    let _ = git(root, &["remote", "remove", "origin"]);
    git(root, &["remote", "add", "origin", url])?;
    Ok(())
}

/// The `http.extraheader` value authenticating as `token`, base64 basic-auth
/// (`x-access-token:<token>`, the GitHub-over-HTTPS convention). Passed to git
/// via env (`GIT_CONFIG_*`), never argv, so the token is not in the process
/// command line — nor written to `.git/config` (origin stays the clean URL).
fn basic_auth_header(token: &str) -> String {
    use base64::Engine as _;
    let creds =
        base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{token}"));
    format!("AUTHORIZATION: basic {creds}")
}

fn push(root: &Path, token: &str) -> Result<(), String> {
    // Auth via env-provided git config (GIT_CONFIG_*), NOT argv, so the token
    // never appears in the world-readable process command line. origin is the
    // clean https URL set by `set_remote`.
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .env("GIT_CONFIG_COUNT", "1")
        .env("GIT_CONFIG_KEY_0", "http.https://github.com/.extraheader")
        .env("GIT_CONFIG_VALUE_0", basic_auth_header(token))
        .env("GIT_TERMINAL_PROMPT", "0")
        .args(["push", "origin", &format!("{DEFAULT_BRANCH}:{DEFAULT_BRANCH}")])
        .output()
        .map_err(|e| format!("git not found on PATH ({e}); install git to publish"))?;
    if !out.status.success() {
        return Err(format!(
            "git push failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

/// The repo the project's `origin` points at (model `Registry.RepoOfProject`).
fn repo_of_project(root: &Path) -> Result<RepoInfo, String> {
    let origin = git(root, &["remote", "get-url", "origin"])?;
    parse_repo_url(&origin)
}

/// Parse `owner`/`name` from a GitHub `https://` remote URL.
fn parse_repo_url(url: &str) -> Result<RepoInfo, String> {
    let rest = url
        .trim()
        .strip_prefix("https://github.com/")
        .ok_or_else(|| format!("not a github.com remote: {url}"))?;
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let mut parts = rest.split('/');
    let owner = parts.next().filter(|s| !s.is_empty());
    let name = parts.next().filter(|s| !s.is_empty());
    match (owner, name) {
        (Some(owner), Some(name)) => Ok(RepoInfo {
            full_name: format!("{owner}/{name}"),
            html_url: format!("https://github.com/{owner}/{name}"),
            owner: owner.to_string(),
            name: name.to_string(),
        }),
        _ => Err(format!("could not parse owner/name from remote: {url}")),
    }
}

// --- orchestration (model Publisher) ----------------------------------------

fn publish_token() -> Result<String, String> {
    crate::github::current_token()
        .ok_or_else(|| "Sign in and authorize publishing first.".to_string())
}

/// Share the project at `root` to GitHub (model `Publisher.Share`): create the
/// repo, tag it `dcs-studio`, init/commit/push. The caller ensures the token
/// carries `public_repo` first (the UI escalates the scope).
pub fn share(root: &str, as_library: bool) -> Result<RepoInfo, String> {
    let root = Path::new(root);
    let token = publish_token()?;
    // Resolve the signed-in identity ONCE at the entry and thread it down, so the
    // commit identity and the existing-repo (422) lookup don't each reach into
    // the keyring deep in the flow.
    let login = crate::github::current_session().map(|s| s.login);
    let plan = plan_repo(root, as_library)?;
    let repo = create_repo(&plan.name, &plan.description, &token, login.as_deref())?;
    set_topics(&repo, &plan.topics, &token)?;
    init_and_commit(root, &plan.commit_message, login.as_deref())?;
    set_remote(root, &repo.html_url)?;
    push(root, &token)?;
    Ok(repo)
}

/// Publish a release for the already-shared project at `root` (model
/// `Publisher.PublishRelease`, issue #62): package the manifest + every
/// `[[install]]` source into a 7-Zip payload — split into GitHub-safe volumes
/// when large — BEFORE any GitHub call (so a packaging failure leaves GitHub
/// untouched); create or reuse a DRAFT release for `tag`; upload the standalone
/// `dcs-studio.toml` plus every payload volume (deleting any same-named asset
/// first, so a re-publish is idempotent); and only once every asset has landed,
/// flip the release to published.
pub fn publish_release(root: &str, tag: &str) -> Result<ReleaseInfo, String> {
    let root = Path::new(root);
    let token = publish_token()?;
    let repo = repo_of_project(root)?;
    let manifest_path = root.join(MANIFEST_FILE);
    if !manifest_path.is_file() {
        return Err(format!("no {MANIFEST_FILE} at the project root — nothing to publish"));
    }
    let manifest = dcs_studio_project::manifest::load(root)?;

    // Package + split first: a packaging failure must touch nothing on GitHub.
    let packaged = package_release(root, &repo.name, tag, &manifest, &manifest_path)?;

    let release = find_or_create_draft(&repo, tag, &token)?;
    // Upload every asset, then flip the draft to published — published only once
    // every asset has landed, so a failure partway leaves the draft, never a
    // half-populated public release.
    let result = (|| {
        upload_release_assets(&repo, &release, &packaged, &token)?;
        publish_draft(&repo, release.id, &token)
    })();

    // Best-effort temp cleanup regardless of outcome. Only the payload volumes
    // are temps; the manifest lives in the project.
    for temp in &packaged.volume_paths {
        let _ = std::fs::remove_file(temp);
    }
    result?;
    Ok(release.info)
}

/// Upload the standalone manifest + every payload volume as assets of `release`,
/// deleting any same-named asset first so a re-upload is idempotent.
fn upload_release_assets(
    repo: &RepoInfo,
    release: &ReleaseRef,
    packaged: &PackagedRelease,
    token: &str,
) -> Result<(), String> {
    let existing = release_assets(repo, release.id, token)?;
    // The standalone manifest first, then every payload volume.
    let assets = std::iter::once(&packaged.manifest_path).chain(&packaged.volume_paths);
    for asset in assets {
        let name = asset_filename(asset)?;
        if let Some(old) = existing.iter().find(|a| a.name == name) {
            delete_asset(repo, old.id, token)?;
        }
        upload_asset(repo, release.id, asset, token)?;
    }
    Ok(())
}

/// The payload archive base name (no volume suffix): `dcs-studio-<repo>-<tag>`,
/// the tag sanitised to a filename-safe form. The single-archive asset is
/// `<base>.7z`; volumes are `<base>.7z.001`, `<base>.7z.002`, …
fn payload_base(repo_name: &str, tag: &str) -> String {
    let safe_tag: String = tag
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '-' })
        .collect();
    format!("dcs-studio-{repo_name}-{safe_tag}")
}

/// A packaged release ready to upload (model `PackagedRelease`): the in-project
/// standalone manifest, plus the payload as the temp `.7z`/volume files — a
/// single `<base>.7z` for a small payload, ordered `<base>.7z.NNN` for a large
/// one, and empty for a manifest-only project. The volume files are temps,
/// removed after the run; the manifest is never a temp.
struct PackagedRelease {
    manifest_path: PathBuf,
    volume_paths: Vec<PathBuf>,
}

/// Package the release (model `Publisher.PackageRelease`): the standalone
/// manifest always, plus — when the project declares `[[install]]` rules — a
/// 7-Zip payload, split into `volume_size` volumes when it exceeds that size. A
/// manifest-only project yields no payload. Runs entirely before any GitHub call.
fn package_release(
    root: &Path,
    repo_name: &str,
    tag: &str,
    manifest: &Manifest,
    manifest_path: &Path,
) -> Result<PackagedRelease, String> {
    let manifest_path = manifest_path.to_path_buf();
    if manifest.install.is_empty() {
        return Ok(PackagedRelease { manifest_path, volume_paths: Vec::new() }); // manifest-only
    }
    let sized = manifest.release.volume_size_bytes()?;
    if let Some(warning) = &sized.warning {
        tracing::warn!("{warning}");
    }
    let archive = package_payload_7z(root, repo_name, tag, manifest)?;
    let archive_len = std::fs::metadata(&archive)
        .map_err(|e| format!("stat payload: {e}"))?
        .len();
    let volume_paths = if archive_len <= sized.bytes {
        vec![archive] // small payload stays a single `.7z`
    } else {
        split_into_volumes(&archive, sized.bytes)?
    };
    Ok(PackagedRelease { manifest_path, volume_paths })
}

/// Stream the manifest + every `[[install]]` source into a temp `<base>.7z` FILE
/// (each source streamed entry-by-entry, so the payload is never fully held in
/// RAM). A symlink in any source tree is refused — never silently omitted. On
/// any failure the partial archive is removed, so a failed package leaks nothing.
/// Returns the archive path.
fn package_payload_7z(root: &Path, repo_name: &str, tag: &str, manifest: &Manifest) -> Result<PathBuf, String> {
    let archive = std::env::temp_dir().join(format!("{}.7z", payload_base(repo_name, tag)));
    match write_payload_7z(&archive, root, manifest) {
        Ok(()) => Ok(archive),
        Err(e) => {
            let _ = std::fs::remove_file(&archive);
            Err(e)
        }
    }
}

/// Write the manifest + every `[[install]]` source into the `.7z` at `archive`.
fn write_payload_7z(archive: &Path, root: &Path, manifest: &Manifest) -> Result<(), String> {
    let mut writer =
        ArchiveWriter::create(archive).map_err(|e| format!("create 7z payload: {e}"))?;
    add_file_entry(&mut writer, root, Path::new(MANIFEST_FILE))?;
    for rule in &manifest.install {
        let rel = Path::new(&rule.source);
        let abs = root.join(rel);
        let file_type = std::fs::symlink_metadata(&abs)
            .map_err(|e| format!("install source not found: {} ({e})", rule.source))?
            .file_type();
        if file_type.is_symlink() {
            return Err(format!("install source is a symlink (refused): {}", rule.source));
        } else if file_type.is_file() {
            add_file_entry(&mut writer, root, rel)?;
        } else if file_type.is_dir() {
            add_dir_entries(&mut writer, root, rel)?;
        } else {
            return Err(format!("install source is neither a file nor a directory: {}", rule.source));
        }
    }
    writer.finish().map_err(|e| format!("finish 7z payload: {e}"))?;
    Ok(())
}

/// Add `root/rel` to the archive under its forward-slashed project-relative path,
/// streaming the file rather than buffering it. UTF-8 entry names preserve
/// non-ASCII (e.g. Cyrillic) filenames byte-for-byte.
fn add_file_entry(writer: &mut ArchiveWriter<File>, root: &Path, rel: &Path) -> Result<(), String> {
    let abs = root.join(rel);
    let name = rel.to_string_lossy().replace('\\', "/");
    let file = File::open(&abs).map_err(|e| format!("read {}: {e}", rel.display()))?;
    let entry = ArchiveEntry::from_path(&abs, name);
    writer
        .push_archive_entry(entry, Some(file))
        .map_err(|e| format!("7z entry {}: {e}", rel.display()))?;
    Ok(())
}

/// Recursively add every file under `root/rel`, in sorted order for determinism,
/// refusing any symlink so nothing is silently omitted from the payload.
fn add_dir_entries(writer: &mut ArchiveWriter<File>, root: &Path, rel: &Path) -> Result<(), String> {
    let dir = root.join(rel);
    let mut names: Vec<_> = std::fs::read_dir(&dir)
        .map_err(|e| format!("read dir {}: {e}", dir.display()))?
        .map(|entry| entry.map(|e| e.file_name()))
        .collect::<Result<_, _>>()
        .map_err(|e| format!("dir entry in {}: {e}", dir.display()))?;
    names.sort();
    for name in names {
        let child_rel = rel.join(&name);
        let abs = root.join(&child_rel);
        let file_type = std::fs::symlink_metadata(&abs)
            .map_err(|e| format!("stat {}: {e}", child_rel.display()))?
            .file_type();
        if file_type.is_symlink() {
            return Err(format!("source contains a symlink (refused): {}", child_rel.display()));
        } else if file_type.is_dir() {
            add_dir_entries(writer, root, &child_rel)?;
        } else if file_type.is_file() {
            add_file_entry(writer, root, &child_rel)?;
        }
    }
    Ok(())
}

/// Byte-split `archive` into ordered `<archive>.001`, `.002`, … volumes of
/// `volume_size` bytes each (the last is the remainder), streamed through a
/// fixed buffer so the payload is never fully in RAM. Concatenating the volumes
/// reproduces `archive` exactly, so `7z x <base>.7z.001` reassembles natively.
/// Removes `archive`; returns the volume paths in order.
fn split_into_volumes(archive: &Path, volume_size: u64) -> Result<Vec<PathBuf>, String> {
    let total = std::fs::metadata(archive)
        .map_err(|e| format!("stat payload: {e}"))?
        .len();
    let mut src = File::open(archive).map_err(|e| format!("open payload: {e}"))?;
    let count = total.div_ceil(volume_size);
    let mut volumes = Vec::new();
    for index in 1..=count {
        let vol = volume_path(archive, index);
        let mut out = File::create(&vol).map_err(|e| format!("create volume {index}: {e}"))?;
        let want = volume_size.min(total - (index - 1) * volume_size);
        let copied = std::io::copy(&mut (&mut src).take(want), &mut out)
            .map_err(|e| format!("write volume {index}: {e}"))?;
        if copied != want {
            return Err(format!("payload split short at volume {index}: {copied} of {want} bytes"));
        }
        volumes.push(vol);
    }
    drop(src);
    let _ = std::fs::remove_file(archive); // the volumes supersede the whole `.7z`
    Ok(volumes)
}

/// The `index`-th volume path: `<archive>.001`, `.002`, … (3-digit minimum,
/// 7-Zip's own naming).
fn volume_path(archive: &Path, index: u64) -> PathBuf {
    PathBuf::from(format!("{}.{index:03}", archive.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn committer_identity_uses_the_login_else_a_generic_fallback() {
        // Pure now — the login is threaded in, so the commit identity is
        // testable without the keyring singleton.
        assert_eq!(
            committer_identity(Some("octocat")),
            (
                "octocat".to_string(),
                "octocat@users.noreply.github.com".to_string(),
            ),
        );
        assert_eq!(
            committer_identity(None),
            (
                "DCS Studio".to_string(),
                "dcs-studio@users.noreply.github.com".to_string(),
            ),
        );
    }

    #[test]
    fn slugify_makes_github_safe_names() {
        assert_eq!(slugify("My Script Mod"), "my-script-mod");
        assert_eq!(slugify("  A-10C  HUD!! "), "a-10c-hud");
        assert_eq!(slugify("already-ok_1.2"), "already-ok_1.2");
        assert_eq!(slugify("???"), "");
    }

    #[test]
    fn plan_always_tags_dcs_studio_and_falls_back_to_a_name() {
        let plan = plan_for("My Script Mod", false);
        assert_eq!(plan.name, "my-script-mod");
        assert!(plan.topics.contains(&"dcs-studio".to_string()));
        // A non-library is NOT tagged as a library.
        assert!(!plan.topics.contains(&"dcs-studio-library".to_string()));
        // An unusable name still yields a valid repo slug.
        assert_eq!(plan_for("???", false).name, "dcs-mod");
    }

    #[test]
    fn library_publish_adds_the_library_topic_alongside_discovery() {
        let plan = plan_for("My Lib", true);
        assert!(plan.topics.contains(&"dcs-studio".to_string()), "still discoverable");
        assert!(plan.topics.contains(&"dcs-studio-library".to_string()), "marked a library");
    }

    #[test]
    fn basic_auth_header_base64_encodes_the_token_for_env_not_argv() {
        use base64::Engine as _;
        let header = basic_auth_header("gho_secret");
        let b64 = header
            .strip_prefix("AUTHORIZATION: basic ")
            .expect("basic-auth prefix");
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .expect("valid base64");
        // The token rides in the header (→ git env), never in a URL/argv.
        assert_eq!(String::from_utf8(decoded).unwrap(), "x-access-token:gho_secret");
    }

    #[test]
    fn parse_repo_url_handles_with_and_without_dot_git() {
        let a = parse_repo_url("https://github.com/octocat/cool-mod").unwrap();
        assert_eq!(a.owner, "octocat");
        assert_eq!(a.name, "cool-mod");
        let b = parse_repo_url("https://github.com/octocat/cool-mod.git").unwrap();
        assert_eq!(b.full_name, "octocat/cool-mod");
        assert!(parse_repo_url("https://gitlab.com/x/y").is_err());
    }

    // --- packaging + volume split (issue #62) -------------------------------

    /// A throwaway temp tree, removed on drop so a panicking assert never leaks.
    struct TempTree(PathBuf);
    impl TempTree {
        fn new(tag: &str) -> Self {
            let root =
                std::env::temp_dir().join(format!("dcs-publish-test-{tag}-{}", std::process::id()));
            std::fs::create_dir_all(&root).expect("create temp root");
            TempTree(root)
        }
        fn write(&self, rel: &str, contents: &[u8]) -> PathBuf {
            let path = self.0.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).expect("create parent");
            std::fs::write(&path, contents).expect("write file");
            path
        }
    }
    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn manifest_of(text: &str) -> Manifest {
        dcs_studio_project::manifest::parse(text).expect("manifest parses")
    }

    #[test]
    fn payload_base_sanitises_the_tag() {
        assert_eq!(payload_base("cool-mod", "v1.2.3"), "dcs-studio-cool-mod-v1.2.3");
        // Anything outside [A-Za-z0-9._-] collapses to '-' (filename-safe).
        assert_eq!(payload_base("mod", "v1/0 beta"), "dcs-studio-mod-v1-0-beta");
    }

    #[test]
    fn volume_path_pads_to_three_digits() {
        let base = Path::new("/tmp/dcs-studio-mod-v1.7z");
        assert_eq!(volume_path(base, 1), PathBuf::from("/tmp/dcs-studio-mod-v1.7z.001"));
        assert_eq!(volume_path(base, 42), PathBuf::from("/tmp/dcs-studio-mod-v1.7z.042"));
        // Past 999 it widens rather than truncating, so lexical order is preserved.
        assert_eq!(volume_path(base, 1000), PathBuf::from("/tmp/dcs-studio-mod-v1.7z.1000"));
    }

    #[test]
    fn split_into_volumes_round_trips_and_sizes_each_volume() {
        let tree = TempTree::new("split");
        // 2500 bytes split at 1000 → 1000 + 1000 + 500.
        let original: Vec<u8> = (0..2500u32).map(|i| (i % 251) as u8).collect();
        let archive = tree.write("payload.7z", &original);
        let volumes = split_into_volumes(&archive, 1000).expect("split");
        let sizes: Vec<u64> = volumes
            .iter()
            .map(|v| std::fs::metadata(v).expect("volume exists").len())
            .collect();
        assert_eq!(sizes, vec![1000, 1000, 500]);
        // The whole-archive temp is removed; the volumes concatenate back to it.
        assert!(!archive.exists(), "the source `.7z` is removed after split");
        let restitched: Vec<u8> = volumes
            .iter()
            .flat_map(|v| std::fs::read(v).expect("read volume"))
            .collect();
        assert_eq!(restitched, original, "volumes reassemble the original byte-for-byte");
    }

    #[cfg(unix)]
    #[test]
    fn package_payload_7z_rejects_a_symlinked_source() {
        use std::os::unix::fs::symlink;
        let tree = TempTree::new("symlink");
        tree.write("dcs-studio.toml", b"[project]\nname = \"x\"\n");
        tree.write("src/real.txt", b"hi");
        symlink(tree.0.join("src/real.txt"), tree.0.join("src/link.txt")).expect("symlink");
        let manifest = manifest_of(
            "[project]\nname = \"x\"\n\n[[install]]\nsource = \"src\"\ndest = \"{SavedGames}/x\"\n",
        );
        let err = package_payload_7z(&tree.0, "symx", "v1", &manifest).expect_err("symlink refused");
        assert!(err.contains("symlink"), "error names it a symlink: {err}");
        assert!(err.contains("link.txt"), "error names the offending path: {err}");
        // The partial archive self-cleans on failure — nothing leaks to temp.
        assert!(!std::env::temp_dir().join("dcs-studio-symx-v1.7z").exists());
    }

    #[test]
    fn manifest_only_project_packages_only_the_manifest() {
        let tree = TempTree::new("manifestonly");
        let manifest_path = tree.write("dcs-studio.toml", b"[project]\nname = \"x\"\n");
        let manifest = manifest_of("[project]\nname = \"x\"\n");
        let packaged =
            package_release(&tree.0, "x", "v1", &manifest, &manifest_path).expect("package");
        assert_eq!(packaged.manifest_path, manifest_path, "the manifest is the standalone asset");
        assert!(packaged.volume_paths.is_empty(), "no payload volumes for a manifest-only project");
    }

    #[test]
    fn small_payload_packages_a_single_7z_asset() {
        let tree = TempTree::new("single");
        let manifest_path = tree.write("dcs-studio.toml", b"[project]\nname = \"x\"\n");
        tree.write("scripts/a.lua", b"return 1\n");
        let manifest = manifest_of(
            "[project]\nname = \"x\"\n\n[[install]]\nsource = \"scripts\"\ndest = \"{SavedGames}/x\"\n",
        );
        let packaged =
            package_release(&tree.0, "x", "single-v1", &manifest, &manifest_path).expect("package");
        // Standalone manifest + one `.7z` payload (well under the default volume size).
        assert_eq!(packaged.manifest_path, manifest_path, "manifest is the standalone asset");
        assert_eq!(packaged.volume_paths.len(), 1, "a small payload stays a single `.7z`");
        let archive = packaged.volume_paths.first().expect("one payload file");
        assert!(archive.to_string_lossy().ends_with(".7z"), "single archive, not volumes");
        assert!(archive.is_file(), "the `.7z` exists on disk");
        for temp in &packaged.volume_paths {
            let _ = std::fs::remove_file(temp);
        }
    }
}
