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
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::Deserialize;

use crate::github_http::{self, API_BASE};
use dcs_studio_project::{DISCOVERY_TOPIC, LIBRARY_TOPIC, MANIFEST_FILE, Manifest};

const UPLOADS_BASE: &str = "https://uploads.github.com";
/// The branch the initial commit is pushed to (model `DEFAULT_BRANCH`).
const DEFAULT_BRANCH: &str = "main";

/// How many times a transient release-asset upload is attempted before failing.
const UPLOAD_ATTEMPTS: u32 = 3;
/// Base backoff between upload attempts; doubled each retry.
const UPLOAD_BACKOFF: Duration = Duration::from_millis(500);

/// GitHub REST base (`https://api.github.com`). A seam: production always returns
/// the const; the REST tests point it at a local faked-transport server.
#[cfg(not(test))]
fn api_base() -> String {
    API_BASE.to_string()
}
/// GitHub uploads base (`https://uploads.github.com`). Same seam as [`api_base`].
#[cfg(not(test))]
fn uploads_base() -> String {
    UPLOADS_BASE.to_string()
}

#[cfg(test)]
thread_local! {
    /// Per-test override of the REST/uploads base, pointed at the local mock
    /// server so the publish flow's URL-building, JSON-parsing, and retry logic
    /// run against faked transport. `None` falls back to the production const.
    static API_BASE_OVERRIDE: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
    static UPLOADS_BASE_OVERRIDE: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}
#[cfg(test)]
fn api_base() -> String {
    API_BASE_OVERRIDE.with(|o| o.borrow().clone()).unwrap_or_else(|| API_BASE.to_string())
}
#[cfg(test)]
fn uploads_base() -> String {
    UPLOADS_BASE_OVERRIDE.with(|o| o.borrow().clone()).unwrap_or_else(|| UPLOADS_BASE.to_string())
}

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
    match github_http::post(&format!("{}/user/repos", api_base()), token)
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
    Ok(github_http::get(&format!("{}/repos/{owner}/{name}", api_base()), token)
        .set("Accept", github_http::ACCEPT_JSON)
        .call()
        .map_err(|e| rest_error("fetch repo", e))?
        .into_json::<RepoResp>()
        .map_err(|e| format!("fetch-repo response: {e}"))?
        .into())
}

fn set_topics(repo: &RepoInfo, topics: &[String], token: &str) -> Result<(), String> {
    let body = serde_json::json!({ "names": topics });
    github_http::put(&format!("{}/repos/{}/{}/topics", api_base(), repo.owner, repo.name), token)
        .set("Accept", github_http::ACCEPT_JSON)
        .send_json(body)
        .map_err(|e| rest_error("set topics", e))?;
    Ok(())
}

/// A created or resolved release plus the id used to upload assets and publish it
/// (model `ReleaseRef`). `draft` is carried so a re-publish can tell an in-flight
/// draft (reuse as-is) from an already-published tag (re-draft before mutating).
struct ReleaseRef {
    id: u64,
    draft: bool,
    info: ReleaseInfo,
}

/// A GitHub release as create/find return it. `draft` distinguishes an in-flight
/// draft from a published release (absent in some payloads → defaults to false).
#[derive(Deserialize)]
struct ReleaseResp {
    id: u64,
    html_url: String,
    tag_name: String,
    #[serde(default)]
    draft: bool,
}

impl From<ReleaseResp> for ReleaseRef {
    fn from(r: ReleaseResp) -> Self {
        ReleaseRef {
            id: r.id,
            draft: r.draft,
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
    format!("{}/repos/{}/{}{suffix}", api_base(), repo.owner, repo.name)
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

/// The existing release for `tag`, or `None`. Matched over the paginated release
/// LIST (`GET .../releases?per_page=100&page=N`), NOT `GET .../releases/tags/{tag}`:
/// the by-tag endpoint returns *published* releases only, and a draft's git tag
/// isn't cut until publish — so a draft would be invisible there and every retry
/// would orphan a fresh duplicate draft. Listing surfaces drafts to a push-access
/// token, so a partially-published draft is found and reused.
fn find_release_by_tag(repo: &RepoInfo, tag: &str, token: &str) -> Result<Option<ReleaseRef>, String> {
    let mut page = 1;
    loop {
        let batch: Vec<ReleaseResp> = github_http::get(
            &repo_api(repo, &format!("/releases?per_page=100&page={page}")),
            token,
        )
        .set("Accept", github_http::ACCEPT_JSON)
        .call()
        .map_err(|e| rest_error("list releases", e))?
        .into_json()
        .map_err(|e| format!("list-releases response: {e}"))?;
        let full_page = batch.len() == 100;
        if let Some(found) = batch.into_iter().find(|r| r.tag_name == tag) {
            return Ok(Some(found.into()));
        }
        if !full_page {
            return Ok(None);
        }
        page += 1;
    }
}

/// Reuse the existing release for `tag` (idempotent re-publish), else create a
/// fresh draft. A tag found already PUBLISHED is flipped back to draft before it
/// is returned, so the asset-mutation window is never a publicly visible release
/// — the caller re-publishes only once every asset has landed again.
fn find_or_create_draft(repo: &RepoInfo, tag: &str, token: &str) -> Result<ReleaseRef, String> {
    match find_release_by_tag(repo, tag, token)? {
        Some(mut existing) => {
            if !existing.draft {
                set_release_draft(repo, existing.id, true, token)?;
                existing.draft = true;
            }
            Ok(existing)
        }
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

/// Set a release's `draft` flag (`PATCH .../releases/{id}`): `false` flips a
/// fully-uploaded draft to published; `true` re-drafts an already-published tag
/// before a re-publish, so assets are never mutated on a public release.
fn set_release_draft(repo: &RepoInfo, release_id: u64, draft: bool, token: &str) -> Result<(), String> {
    let context = if draft { "re-draft release" } else { "publish release" };
    github_http::patch(&repo_api(repo, &format!("/releases/{release_id}")), token)
        .set("Accept", github_http::ACCEPT_JSON)
        .send_json(serde_json::json!({ "draft": draft }))
        .map_err(|e| rest_error(context, e))?;
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
        "{}/repos/{}/{}/releases/{release_id}/assets?name={filename}",
        uploads_base(),
        repo.owner,
        repo.name
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
        upload_release_assets(&repo, &release, &packaged, tag, &token)?;
        set_release_draft(&repo, release.id, false, &token)
    })();
    // `packaged` drops at scope end, removing the per-run temp dir on every path
    // (success here, an upload failure, or the draft lookup above having failed).
    // The manifest lives in the project, never a temp.
    result?;
    Ok(release.info)
}

/// Upload the standalone manifest + every payload volume as assets of `release`.
/// First the prior asset family — the manifest plus every `<base>.7z` / `.7z.NNN`
/// payload volume — is deleted, NOT just the assets whose names collide with the
/// new ones: a re-publish that changed the payload shape (single `.7z` ⇄ volumes,
/// or N → fewer volumes) would otherwise leave the previous shape's volumes
/// orphaned beside the new set, so the release would end a superset, not "the
/// complete asset set" (AC `RepublishingATagIsIdempotent`) — and 1b discovery
/// globbing `<base>.7z*` would then see an ambiguous archive+volume-set. Purging
/// the whole family first leaves exactly the new set, idempotent on a shape change.
fn upload_release_assets(
    repo: &RepoInfo,
    release: &ReleaseRef,
    packaged: &PackagedRelease,
    tag: &str,
    token: &str,
) -> Result<(), String> {
    let manifest_name = asset_filename(&packaged.manifest_path)?;
    let payload_archive = payload_archive_name(&repo.name, tag);
    let volume_prefix = format!("{payload_archive}."); // `<base>.7z.` → every volume
    let is_prior_family = |name: &str| {
        name == manifest_name || name == payload_archive || name.starts_with(&volume_prefix)
    };
    for old in release_assets(repo, release.id, token)? {
        if is_prior_family(&old.name) {
            delete_asset(repo, old.id, token)?;
        }
    }
    // The standalone manifest first, then every payload volume.
    let assets = std::iter::once(&packaged.manifest_path).chain(&packaged.volume_paths);
    for asset in assets {
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

/// The single-archive payload asset name `<base>.7z` (volumes append `.NNN`). The
/// one place the `.7z` extension joins the base, so the package-time filename and
/// the upload-time family purge can never drift apart.
fn payload_archive_name(repo_name: &str, tag: &str) -> String {
    format!("{}.7z", payload_base(repo_name, tag))
}

/// A packaged release ready to upload (model `PackagedRelease`): the in-project
/// standalone manifest, plus the payload as the temp `.7z`/volume files — a
/// single `<base>.7z` for a small payload, ordered `<base>.7z.NNN` for a large
/// one, and empty for a manifest-only project. The volume files live in a
/// per-run `temp_dir`, removed after the run; the manifest is never a temp.
#[derive(Debug)]
struct PackagedRelease {
    manifest_path: PathBuf,
    /// The per-run temp dir holding the payload volumes, removed when the publish
    /// ends. `None` for a manifest-only project (no payload, nothing temp).
    temp_dir: Option<PathBuf>,
    volume_paths: Vec<PathBuf>,
}

impl PackagedRelease {
    /// Remove the per-run temp dir and the payload volumes within it. Best-effort
    /// and idempotent; a no-op for a manifest-only release.
    fn cleanup(&self) {
        if let Some(dir) = &self.temp_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

impl Drop for PackagedRelease {
    /// RAII: the per-run temp dir is removed however `publish_release` exits —
    /// success, an upload failure, or an early return before upload (e.g. the
    /// draft lookup failing) — so nothing leaks on any path.
    fn drop(&mut self) {
        self.cleanup();
    }
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
        return Ok(PackagedRelease { manifest_path, temp_dir: None, volume_paths: Vec::new() }); // manifest-only
    }
    let sized = manifest.release.volume_size_bytes()?;
    if let Some(warning) = &sized.warning {
        tracing::warn!("{warning}");
    }
    // Every payload temp lives in one per-run dir, so concurrent publishes of the
    // same (repo, tag) never write to the same files, and a packaging failure
    // leaks nothing — the whole dir is dropped on any error below.
    let temp_dir = create_run_temp_dir()?;
    let built = (|| -> Result<Vec<PathBuf>, String> {
        let archive = package_payload_7z(&temp_dir, root, repo_name, tag, manifest)?;
        let archive_len = std::fs::metadata(&archive)
            .map_err(|e| format!("stat payload: {e}"))?
            .len();
        Ok(if archive_len <= sized.bytes {
            vec![archive] // small payload stays a single `.7z`
        } else {
            studio_archive::split_into_volumes(&archive, sized.bytes)?
        })
    })();
    match built {
        Ok(volume_paths) => Ok(PackagedRelease { manifest_path, temp_dir: Some(temp_dir), volume_paths }),
        Err(e) => {
            let _ = std::fs::remove_dir_all(&temp_dir);
            Err(e)
        }
    }
}

/// A fresh per-run temp directory, unique across concurrent publishes of the same
/// (repo, tag): `dcs-studio-publish-<pid>-<seq>`, where `<seq>` is a
/// process-monotonic counter (so two publishes in one process never collide) and
/// `<pid>` separates processes. The payload `.7z` and its volumes are written
/// here under their real asset names — so the upload names stay `<base>.7z[.NNN]`,
/// the nonce living in the directory, not the file — and the whole directory is
/// removed when the publish ends.
fn create_run_temp_dir() -> Result<PathBuf, String> {
    static RUN_SEQ: AtomicU64 = AtomicU64::new(0);
    let pid = std::process::id();
    let seq = RUN_SEQ.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("dcs-studio-publish-{pid}-{seq}"));
    std::fs::create_dir_all(&dir).map_err(|e| format!("create publish temp dir: {e}"))?;
    Ok(dir)
}

/// Stream the manifest + every `[[install]]` source into a `<base>.7z` FILE in
/// `out_dir` (each source streamed entry-by-entry, so the payload is never fully
/// held in RAM). A symlink in any source tree is refused — never silently
/// omitted. On any failure the partial archive is removed, so a failed package
/// leaks nothing. Returns the archive path.
fn package_payload_7z(out_dir: &Path, root: &Path, repo_name: &str, tag: &str, manifest: &Manifest) -> Result<PathBuf, String> {
    let archive = out_dir.join(payload_archive_name(repo_name, tag));
    match write_payload_7z(&archive, root, manifest) {
        Ok(()) => Ok(archive),
        Err(e) => {
            let _ = std::fs::remove_file(&archive);
            Err(e)
        }
    }
}

/// Write the manifest + every `[[install]]` source into the `.7z` at `archive`,
/// through the `studio_archive` writer facade (the one place that names the 7-Zip
/// dependency). Publish keeps the source-tree policy — what to include, and the
/// symlink / special-file refusals — while the facade owns the archive mechanism.
fn write_payload_7z(archive: &Path, root: &Path, manifest: &Manifest) -> Result<(), String> {
    let mut writer = studio_archive::SevenZipWriter::create(archive)?;
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
    writer.finish()?;
    Ok(())
}

/// Add `root/rel` to the archive under its forward-slashed project-relative path,
/// streaming the file rather than buffering it. UTF-8 entry names preserve
/// non-ASCII (e.g. Cyrillic) filenames byte-for-byte.
fn add_file_entry(writer: &mut studio_archive::SevenZipWriter, root: &Path, rel: &Path) -> Result<(), String> {
    let abs = root.join(rel);
    let name = rel.to_string_lossy().replace('\\', "/");
    writer.push_file(&name, &abs)
}

/// Recursively add every file under `root/rel`, in sorted order for determinism,
/// refusing any symlink or other special file (fifo / socket / device) so nothing
/// is silently omitted from the payload — at parity with the top-level guard.
fn add_dir_entries(writer: &mut studio_archive::SevenZipWriter, root: &Path, rel: &Path) -> Result<(), String> {
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
        } else {
            // A non-symlink special file (fifo / socket / device): refuse it
            // rather than silently drop it — parity with the top-level guard, so
            // nothing is omitted from the payload without an error.
            return Err(format!("source contains a special file (refused): {}", child_rel.display()));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read as _, Write as _};
    use std::net::{TcpListener, TcpStream};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread::JoinHandle;

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

    // The `.7z` packaging mechanism (writer) + the byte-split into volumes — and
    // their round-trip / sizing / cleanup tests — live in `studio_archive`; publish
    // keeps only the source-tree policy tests below.

    #[cfg(unix)]
    #[test]
    fn package_payload_7z_rejects_a_symlinked_source() {
        use std::os::unix::fs::symlink;
        let tree = TempTree::new("symlink");
        let out = TempTree::new("symlink-out");
        tree.write("dcs-studio.toml", b"[project]\nname = \"x\"\n");
        tree.write("src/real.txt", b"hi");
        symlink(tree.0.join("src/real.txt"), tree.0.join("src/link.txt")).expect("symlink");
        let manifest = manifest_of(
            "[project]\nname = \"x\"\n\n[[install]]\nsource = \"src\"\ndest = \"{SavedGames}/x\"\n",
        );
        let err =
            package_payload_7z(&out.0, &tree.0, "symx", "v1", &manifest).expect_err("symlink refused");
        assert!(err.contains("symlink"), "error names it a symlink: {err}");
        assert!(err.contains("link.txt"), "error names the offending path: {err}");
        // The partial archive self-cleans on failure — nothing leaks.
        assert!(!out.0.join("dcs-studio-symx-v1.7z").exists());
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
        assert!(packaged.temp_dir.is_none(), "a manifest-only project allocates no temp dir");
        packaged.cleanup();
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
        assert!(packaged.temp_dir.is_some(), "the payload lives in a per-run temp dir");
        packaged.cleanup();
        assert!(!archive.exists(), "cleanup removes the per-run temp dir and its volumes");
    }

    // --- guard parity + temp isolation (issue #62 review) -------------------

    #[cfg(unix)]
    #[test]
    fn nested_special_file_is_refused_not_silently_omitted() {
        use std::os::unix::net::UnixListener;
        let tree = TempTree::new("special");
        let manifest_path = tree.write("dcs-studio.toml", b"[project]\nname = \"x\"\n");
        tree.write("src/real.txt", b"hi");
        // A unix socket nested in the source dir: neither file, dir, nor symlink —
        // the recursive walker must refuse it, not silently drop it.
        let sock = tree.0.join("src/sock");
        let _listener = UnixListener::bind(&sock).expect("bind unix socket");
        let manifest = manifest_of(
            "[project]\nname = \"x\"\n\n[[install]]\nsource = \"src\"\ndest = \"{SavedGames}/x\"\n",
        );
        let err = package_release(&tree.0, "specialx", "v1", &manifest, &manifest_path)
            .expect_err("nested special file refused");
        assert!(err.contains("special file"), "names it a special file: {err}");
        assert!(err.contains("sock"), "names the offending path: {err}");
    }

    #[test]
    fn same_repo_tag_packaged_twice_gets_distinct_temp_dirs_but_stable_asset_names() {
        let tree = TempTree::new("distinct");
        let manifest_path = tree.write("dcs-studio.toml", b"[project]\nname = \"x\"\n");
        tree.write("scripts/a.lua", b"return 1\n");
        let manifest = manifest_of(
            "[project]\nname = \"x\"\n\n[[install]]\nsource = \"scripts\"\ndest = \"{SavedGames}/x\"\n",
        );
        let a = package_release(&tree.0, "mod", "v1", &manifest, &manifest_path).expect("package a");
        let b = package_release(&tree.0, "mod", "v1", &manifest, &manifest_path).expect("package b");
        // Distinct per-run dirs → concurrent same-(repo,tag) publishes can't write
        // the same files and truncate each other.
        let dir_a = a.temp_dir.clone().expect("a has a temp dir");
        let dir_b = b.temp_dir.clone().expect("b has a temp dir");
        assert_ne!(dir_a, dir_b, "same (repo, tag) packaged twice must not share a temp dir");
        // …yet the uploaded asset name is identical (the nonce is in the dir, not
        // the file), so discovery still sees the stable `<base>.7z` name.
        let name_of = |p: &PackagedRelease| {
            asset_filename(p.volume_paths.first().expect("one volume")).expect("name").to_string()
        };
        assert_eq!(name_of(&a), "dcs-studio-mod-v1.7z");
        assert_eq!(name_of(&a), name_of(&b), "asset name is stable across runs");
        a.cleanup();
        b.cleanup();
    }

    // --- faked-transport REST orchestration (issue #62 review) --------------
    //
    // A throwaway in-memory GitHub release API on a loopback socket: exercises
    // the real URL-building, JSON round-trip, and retry logic against faked
    // transport (the seam `api_base`/`uploads_base` is pointed here). Covers the
    // create/find/upload/publish flow, draft idempotency, and the shape-change
    // family purge — none of which the packaging tests reach.

    #[derive(Clone)]
    struct FakeAsset {
        id: u64,
        name: String,
    }
    struct FakeRelease {
        id: u64,
        tag: String,
        draft: bool,
        assets: Vec<FakeAsset>,
    }
    #[derive(Clone)]
    struct Hit {
        method: String,
        path: String,
    }
    #[derive(Default)]
    struct Fake {
        releases: Vec<FakeRelease>,
        next_id: u64,
        hits: Vec<Hit>,
        /// Each scripted unit turns one asset-upload POST into a 503, to drive the
        /// transient-retry path.
        upload_failures_left: u32,
    }
    impl Fake {
        fn alloc_id(&mut self) -> u64 {
            self.next_id += 1;
            self.next_id
        }
        fn release_mut(&mut self, id: u64) -> Option<&mut FakeRelease> {
            self.releases.iter_mut().find(|r| r.id == id)
        }
        fn asset_names(&self, id: u64) -> Vec<String> {
            self.releases
                .iter()
                .find(|r| r.id == id)
                .map(|r| r.assets.iter().map(|a| a.name.clone()).collect())
                .unwrap_or_default()
        }
    }

    fn release_json(r: &FakeRelease) -> serde_json::Value {
        serde_json::json!({
            "id": r.id,
            "html_url": format!("https://example.test/r/{}", r.id),
            "tag_name": r.tag,
            "draft": r.draft,
        })
    }
    fn query_value<'a>(query: &'a str, key: &str) -> Option<&'a str> {
        query.split('&').find_map(|kv| {
            let (k, v) = kv.split_once('=')?;
            (k == key).then_some(v)
        })
    }
    /// The release id in `.../releases/{id}` or `.../releases/{id}/assets`.
    fn release_id_in(path: &str) -> u64 {
        let mut segs = path.split('/').filter(|s| !s.is_empty());
        while let Some(s) = segs.next() {
            if s == "releases" {
                return segs.next().and_then(|s| s.parse().ok()).unwrap_or(0);
            }
        }
        0
    }

    /// Route one request against the fake's state; returns `(status, json body)`.
    fn route(method: &str, full_path: &str, body: &[u8], fake: &mut Fake) -> (u16, String) {
        let (path, query) = full_path.split_once('?').unwrap_or((full_path, ""));
        fake.hits.push(Hit { method: method.to_string(), path: path.to_string() });
        let message = |m: &str| serde_json::json!({ "message": m }).to_string();

        // Delete an asset: DELETE .../releases/assets/{id}
        if method == "DELETE" && path.contains("/releases/assets/") {
            let aid: u64 = path.rsplit('/').next().and_then(|s| s.parse().ok()).unwrap_or(0);
            for r in &mut fake.releases {
                r.assets.retain(|a| a.id != aid);
            }
            return (204, String::new());
        }
        // Asset collection: .../releases/{id}/assets  (GET list, POST upload)
        if path.ends_with("/assets") {
            let rid = release_id_in(path);
            if method == "POST" {
                if fake.upload_failures_left > 0 {
                    fake.upload_failures_left -= 1;
                    return (503, message("temporarily unavailable"));
                }
                let name = query_value(query, "name").unwrap_or("").to_string();
                let aid = fake.alloc_id();
                if let Some(r) = fake.release_mut(rid) {
                    r.assets.push(FakeAsset { id: aid, name: name.clone() });
                }
                return (201, serde_json::json!({ "id": aid, "name": name }).to_string());
            }
            let page = query_value(query, "page").and_then(|s| s.parse::<u32>().ok()).unwrap_or(1);
            let arr: Vec<serde_json::Value> = if page == 1 {
                fake.release_mut(rid)
                    .map(|r| r.assets.iter().map(|a| serde_json::json!({ "id": a.id, "name": a.name })).collect())
                    .unwrap_or_default()
            } else {
                Vec::new()
            };
            return (200, serde_json::Value::Array(arr).to_string());
        }
        // Release collection: .../releases  (GET list, POST create)
        if path.ends_with("/releases") {
            if method == "POST" {
                let v: serde_json::Value = serde_json::from_slice(body).unwrap_or_default();
                let tag = v.get("tag_name").and_then(|t| t.as_str()).unwrap_or("").to_string();
                let draft = v.get("draft").and_then(|d| d.as_bool()).unwrap_or(false);
                let id = fake.alloc_id();
                fake.releases.push(FakeRelease { id, tag, draft, assets: Vec::new() });
                let created = fake.release_mut(id).map(|r| release_json(r)).unwrap_or_default();
                return (201, created.to_string());
            }
            let page = query_value(query, "page").and_then(|s| s.parse::<u32>().ok()).unwrap_or(1);
            let arr: Vec<serde_json::Value> =
                if page == 1 { fake.releases.iter().map(release_json).collect() } else { Vec::new() };
            return (200, serde_json::Value::Array(arr).to_string());
        }
        // Single release: PATCH .../releases/{id}  (set the draft flag)
        if method == "PATCH" && path.contains("/releases/") {
            let rid = release_id_in(path);
            let v: serde_json::Value = serde_json::from_slice(body).unwrap_or_default();
            if let Some(d) = v.get("draft").and_then(|d| d.as_bool()) {
                if let Some(r) = fake.release_mut(rid) {
                    r.draft = d;
                }
            }
            let updated = fake.release_mut(rid).map(|r| release_json(r)).unwrap_or_default();
            return (200, updated.to_string());
        }
        (404, message("not found"))
    }

    struct MockGitHub {
        addr: String,
        fake: Arc<Mutex<Fake>>,
        shutdown: Arc<AtomicBool>,
        handle: Option<JoinHandle<()>>,
    }
    impl MockGitHub {
        fn start() -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock");
            let addr = listener.local_addr().expect("addr").to_string();
            let fake = Arc::new(Mutex::new(Fake::default()));
            let shutdown = Arc::new(AtomicBool::new(false));
            let (f, sd) = (Arc::clone(&fake), Arc::clone(&shutdown));
            let handle = std::thread::spawn(move || {
                for stream in listener.incoming() {
                    if sd.load(Ordering::Relaxed) {
                        break;
                    }
                    match stream {
                        Ok(s) => serve_one(s, &f),
                        Err(_) => break,
                    }
                }
            });
            // Point the publish flow's REST + uploads base at this server.
            let base = format!("http://{addr}");
            API_BASE_OVERRIDE.with(|o| *o.borrow_mut() = Some(base.clone()));
            UPLOADS_BASE_OVERRIDE.with(|o| *o.borrow_mut() = Some(base));
            MockGitHub { addr, fake, shutdown, handle: Some(handle) }
        }
        fn lock(&self) -> std::sync::MutexGuard<'_, Fake> {
            self.fake.lock().expect("lock fake")
        }
    }
    impl Drop for MockGitHub {
        fn drop(&mut self) {
            API_BASE_OVERRIDE.with(|o| *o.borrow_mut() = None);
            UPLOADS_BASE_OVERRIDE.with(|o| *o.borrow_mut() = None);
            self.shutdown.store(true, Ordering::Relaxed);
            // Unblock the pending accept() so the server thread sees shutdown.
            let _ = TcpStream::connect(&self.addr);
            if let Some(h) = self.handle.take() {
                let _ = h.join();
            }
        }
    }

    /// Read one HTTP/1.1 request off `stream`, route it, write the response, close.
    fn serve_one(stream: TcpStream, fake: &Arc<Mutex<Fake>>) {
        let mut reader = BufReader::new(stream.try_clone().expect("clone stream"));
        let mut request_line = String::new();
        if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
            return; // a shutdown ping or a dropped connection
        }
        let mut parts = request_line.split_whitespace();
        let method = parts.next().unwrap_or("").to_string();
        let target = parts.next().unwrap_or("").to_string();
        let mut content_length = 0usize;
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).unwrap_or(0) == 0 {
                break;
            }
            let trimmed = line.trim_end();
            if trimmed.is_empty() {
                break; // end of headers
            }
            if let Some((name, value)) = trimmed.split_once(':') {
                if name.trim().eq_ignore_ascii_case("content-length") {
                    content_length = value.trim().parse().unwrap_or(0);
                }
            }
        }
        let mut body = vec![0u8; content_length];
        if content_length > 0 {
            reader.read_exact(&mut body).expect("read body");
        }
        let (status, payload) = {
            let mut guard = fake.lock().expect("lock fake");
            route(&method, &target, &body, &mut guard)
        };
        let reason = match status {
            200 => "OK",
            201 => "Created",
            204 => "No Content",
            503 => "Service Unavailable",
            _ => "Not Found",
        };
        let header = format!(
            "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            payload.len()
        );
        let mut writer = stream;
        let _ = writer.write_all(header.as_bytes());
        let _ = writer.write_all(payload.as_bytes());
        let _ = writer.flush();
    }

    fn test_repo() -> RepoInfo {
        RepoInfo {
            full_name: "octocat/cool-mod".to_string(),
            html_url: "https://github.com/octocat/cool-mod".to_string(),
            owner: "octocat".to_string(),
            name: "cool-mod".to_string(),
        }
    }

    #[test]
    fn find_or_create_draft_finds_an_existing_draft_via_the_release_list() {
        let mock = MockGitHub::start();
        // Seed a DRAFT — invisible to the published-only `GET /releases/tags/{tag}`.
        {
            let mut f = mock.lock();
            let id = f.alloc_id();
            f.releases.push(FakeRelease { id, tag: "v1".to_string(), draft: true, assets: Vec::new() });
        }
        let r = find_or_create_draft(&test_repo(), "v1", "tok").expect("find existing draft");
        assert!(r.draft, "the found release is the seeded draft");
        let f = mock.lock();
        assert_eq!(f.releases.len(), 1, "existing draft reused, not duplicated");
        assert!(
            f.hits.iter().any(|h| h.method == "GET" && h.path.ends_with("/releases")),
            "found via the paginated release LIST",
        );
        assert!(
            !f.hits.iter().any(|h| h.path.contains("/releases/tags/")),
            "never hits the published-only by-tag endpoint",
        );
    }

    #[test]
    fn find_or_create_draft_redrafts_an_already_published_tag() {
        let mock = MockGitHub::start();
        {
            let mut f = mock.lock();
            let id = f.alloc_id();
            f.releases.push(FakeRelease { id, tag: "v2".to_string(), draft: false, assets: Vec::new() });
        }
        let r = find_or_create_draft(&test_repo(), "v2", "tok").expect("re-draft published");
        assert!(r.draft, "a published tag is flipped back to draft before reuse");
        let f = mock.lock();
        assert!(f.releases.iter().all(|rel| rel.draft), "the release is now a draft");
        assert!(f.hits.iter().any(|h| h.method == "PATCH"), "re-draft goes through a PATCH");
        assert_eq!(f.releases.len(), 1, "no duplicate release");
    }

    #[test]
    fn find_or_create_draft_creates_a_fresh_draft_when_the_tag_is_absent() {
        let mock = MockGitHub::start();
        let r = find_or_create_draft(&test_repo(), "v9", "tok").expect("create draft");
        assert!(r.draft);
        let f = mock.lock();
        assert_eq!(f.releases.len(), 1, "one draft created");
        assert!(f.releases.iter().any(|rel| rel.tag == "v9" && rel.draft));
        assert!(
            f.hits.iter().any(|h| h.method == "POST" && h.path.ends_with("/releases")),
            "created via POST /releases",
        );
    }

    #[test]
    fn upload_release_assets_purges_the_whole_prior_payload_family_on_a_shape_change() {
        let mock = MockGitHub::start();
        // Previously published as a SINGLE archive (manifest + `<base>.7z`), plus an
        // unrelated asset that must survive.
        let rid;
        {
            let mut f = mock.lock();
            rid = f.alloc_id();
            let (a1, a2, a3) = (f.alloc_id(), f.alloc_id(), f.alloc_id());
            f.releases.push(FakeRelease {
                id: rid,
                tag: "v1".to_string(),
                draft: true,
                assets: vec![
                    FakeAsset { id: a1, name: "dcs-studio.toml".to_string() },
                    FakeAsset { id: a2, name: "dcs-studio-cool-mod-v1.7z".to_string() },
                    FakeAsset { id: a3, name: "NOTES.md".to_string() },
                ],
            });
        }
        // New shape: two volumes (real temp files to stream up).
        let tree = TempTree::new("shape");
        let manifest_path = tree.write("dcs-studio.toml", b"[project]\nname=\"x\"\n");
        let v1 = tree.write("dcs-studio-cool-mod-v1.7z.001", b"aaaa");
        let v2 = tree.write("dcs-studio-cool-mod-v1.7z.002", b"bb");
        let packaged = PackagedRelease { manifest_path, temp_dir: None, volume_paths: vec![v1, v2] };
        let release =
            ReleaseRef { id: rid, draft: true, info: ReleaseInfo { tag: "v1".to_string(), html_url: "x".to_string() } };

        upload_release_assets(&test_repo(), &release, &packaged, "v1", "tok").expect("upload");

        let names = mock.lock().asset_names(rid);
        assert!(names.iter().any(|n| n == "dcs-studio.toml"), "manifest re-uploaded");
        assert!(names.iter().any(|n| n == "dcs-studio-cool-mod-v1.7z.001"), "new volume 1 present");
        assert!(names.iter().any(|n| n == "dcs-studio-cool-mod-v1.7z.002"), "new volume 2 present");
        assert!(
            !names.iter().any(|n| n == "dcs-studio-cool-mod-v1.7z"),
            "the stale single-archive orphan is purged",
        );
        assert!(names.iter().any(|n| n == "NOTES.md"), "an unrelated asset is left untouched");
        assert_eq!(names.len(), 4, "complete asset set — no orphans, no duplicates");
    }

    #[test]
    fn upload_asset_retries_a_transient_failure_then_succeeds() {
        let mock = MockGitHub::start();
        let rid;
        {
            let mut f = mock.lock();
            rid = f.alloc_id();
            f.releases.push(FakeRelease { id: rid, tag: "v1".to_string(), draft: true, assets: Vec::new() });
            f.upload_failures_left = 1; // first upload POST → 503, then retried
        }
        let tree = TempTree::new("retry");
        let asset = tree.write("dcs-studio-cool-mod-v1.7z", b"payload-bytes");
        upload_asset(&test_repo(), rid, &asset, "tok").expect("upload succeeds after one retry");
        let f = mock.lock();
        let upload_posts =
            f.hits.iter().filter(|h| h.method == "POST" && h.path.ends_with("/assets")).count();
        assert_eq!(upload_posts, 2, "one failed attempt, then one success");
        assert_eq!(f.asset_names(rid), vec!["dcs-studio-cool-mod-v1.7z".to_string()], "landed exactly once");
    }
}
