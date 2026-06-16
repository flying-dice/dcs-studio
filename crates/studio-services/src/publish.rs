//! studio::publish — share a project to GitHub and cut a release (model
//! `model/studio/publish.pds`, issue #12). `share` creates a public repo, tags
//! it `dcs-studio` (so studio::market discovers it), then init/commit/push the
//! project via the installed `git`. `publish_release` creates a GitHub release
//! and uploads `dcs-studio.toml` so the Marketplace product page shows the
//! install plan (the source-file payload lands with the install slice). Both run
//! as the logged-in user with a `public_repo`-scoped token (issue #11/#12); the
//! REST calls use ureq, the git calls shell out. ureq + git are blocking —
//! callers run this off the UI thread.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Deserialize;

const API_BASE: &str = "https://api.github.com";
const UPLOADS_BASE: &str = "https://uploads.github.com";
const USER_AGENT: &str = concat!("dcs-studio/", env!("CARGO_PKG_VERSION"));
/// The marketplace marker topic every shared repo gets (model `DISCOVERY_TOPIC`).
const DISCOVERY_TOPIC: &str = "dcs-studio";
/// The branch the initial commit is pushed to (model `DEFAULT_BRANCH`).
const DEFAULT_BRANCH: &str = "main";
/// The manifest uploaded as the release's installability anchor.
const MANIFEST_FILE: &str = "dcs-studio.toml";

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
fn plan_for(project_name: &str) -> RepoPlan {
    let slug = slugify(project_name);
    let name = if slug.is_empty() { "dcs-mod".to_string() } else { slug };
    RepoPlan {
        name,
        description: format!("{project_name} — a DCS World mod built with DCS Studio"),
        topics: vec![DISCOVERY_TOPIC.to_string()],
        commit_message: "Initial commit (DCS Studio)".to_string(),
    }
}

/// The repo plan from the project's `dcs-studio.toml` (model `Registry.PlanRepo`).
pub fn plan_repo(root: &Path) -> Result<RepoPlan, String> {
    let manifest = dcs_studio_project::manifest::load(root)?;
    Ok(plan_for(&manifest.project.name))
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
fn create_repo(name: &str, description: &str, token: &str) -> Result<RepoInfo, String> {
    let body = serde_json::json!({
        "name": name,
        "description": description,
        "private": false,
        "auto_init": false,
    });
    match ureq::post(&format!("{API_BASE}/user/repos"))
        .set("Accept", "application/vnd.github+json")
        .set("User-Agent", USER_AGENT)
        .set("Authorization", &format!("Bearer {token}"))
        .send_json(body)
    {
        Ok(resp) => Ok(resp
            .into_json::<RepoResp>()
            .map_err(|e| format!("create-repo response: {e}"))?
            .into()),
        // Already exists for this user — continue with the existing repo.
        Err(ureq::Error::Status(422, _)) => {
            let login = crate::github::current_session()
                .map(|s| s.login)
                .ok_or_else(|| "repo exists but no session to resolve it".to_string())?;
            fetch_repo(&login, name, token)
        }
        Err(e) => Err(rest_error("create repo", e)),
    }
}

/// Resolve an existing repo (`GET /repos/{owner}/{name}`).
fn fetch_repo(owner: &str, name: &str, token: &str) -> Result<RepoInfo, String> {
    Ok(ureq::get(&format!("{API_BASE}/repos/{owner}/{name}"))
        .set("Accept", "application/vnd.github+json")
        .set("User-Agent", USER_AGENT)
        .set("Authorization", &format!("Bearer {token}"))
        .call()
        .map_err(|e| rest_error("fetch repo", e))?
        .into_json::<RepoResp>()
        .map_err(|e| format!("fetch-repo response: {e}"))?
        .into())
}

fn set_topics(repo: &RepoInfo, topics: &[String], token: &str) -> Result<(), String> {
    let body = serde_json::json!({ "names": topics });
    ureq::put(&format!("{API_BASE}/repos/{}/{}/topics", repo.owner, repo.name))
        .set("Accept", "application/vnd.github+json")
        .set("User-Agent", USER_AGENT)
        .set("Authorization", &format!("Bearer {token}"))
        .send_json(body)
        .map_err(|e| rest_error("set topics", e))?;
    Ok(())
}

/// A created release plus its id (the id is plumbing for the asset upload).
struct CreatedRelease {
    info: ReleaseInfo,
    id: u64,
}

fn create_release(repo: &RepoInfo, tag: &str, body: &str, token: &str) -> Result<CreatedRelease, String> {
    #[derive(Deserialize)]
    struct Resp {
        id: u64,
        html_url: String,
        tag_name: String,
    }
    let payload = serde_json::json!({ "tag_name": tag, "name": tag, "body": body });
    let resp: Resp = ureq::post(&format!("{API_BASE}/repos/{}/{}/releases", repo.owner, repo.name))
        .set("Accept", "application/vnd.github+json")
        .set("User-Agent", USER_AGENT)
        .set("Authorization", &format!("Bearer {token}"))
        .send_json(payload)
        .map_err(|e| rest_error("create release", e))?
        .into_json()
        .map_err(|e| format!("create-release response: {e}"))?;
    Ok(CreatedRelease {
        info: ReleaseInfo {
            tag: resp.tag_name,
            html_url: resp.html_url,
        },
        id: resp.id,
    })
}

fn upload_asset(repo: &RepoInfo, release_id: u64, path: &Path, token: &str) -> Result<(), String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let filename = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "asset has no filename".to_string())?;
    ureq::post(&format!(
        "{UPLOADS_BASE}/repos/{}/{}/releases/{release_id}/assets?name={filename}",
        repo.owner, repo.name
    ))
    .set("Content-Type", "application/octet-stream")
    .set("User-Agent", USER_AGENT)
    .set("Authorization", &format!("Bearer {token}"))
    .send_bytes(&bytes)
    .map_err(|e| rest_error("upload asset", e))?;
    Ok(())
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

/// The commit identity: the signed-in GitHub login, or a generic fallback.
fn committer_identity() -> (String, String) {
    match crate::github::current_session() {
        Some(s) => {
            let email = format!("{}@users.noreply.github.com", s.login);
            (s.login, email)
        }
        None => (
            "DCS Studio".to_string(),
            "dcs-studio@users.noreply.github.com".to_string(),
        ),
    }
}

fn init_and_commit(root: &Path, message: &str) -> Result<(), String> {
    git(root, &["init"])?;
    git(root, &["add", "-A"])?;
    let (name, email) = committer_identity();
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
pub fn share(root: &str) -> Result<RepoInfo, String> {
    let root = Path::new(root);
    let token = publish_token()?;
    let plan = plan_repo(root)?;
    let repo = create_repo(&plan.name, &plan.description, &token)?;
    set_topics(&repo, &plan.topics, &token)?;
    init_and_commit(root, &plan.commit_message)?;
    set_remote(root, &repo.html_url)?;
    push(root, &token)?;
    Ok(repo)
}

/// Publish a release for the already-shared project at `root` (model
/// `Publisher.PublishRelease`): create the release for `tag`, then upload
/// `dcs-studio.toml` (so discovery/product can read the install plan without the
/// whole payload) AND a `<repo>-<tag>.zip` payload of the manifest + every
/// `[[install]]` source, so the Marketplace can actually download + install it.
pub fn publish_release(root: &str, tag: &str) -> Result<ReleaseInfo, String> {
    let root = Path::new(root);
    let token = publish_token()?;
    let repo = repo_of_project(root)?;
    let manifest_path = root.join(MANIFEST_FILE);
    if !manifest_path.is_file() {
        return Err(format!("no {MANIFEST_FILE} at the project root — nothing to publish"));
    }
    let manifest = dcs_studio_project::manifest::load(root)?;
    // Build the payload archive first so a packaging error fails before we create
    // an empty release on GitHub.
    let payload = package_payload(root, &repo.name, tag, &manifest)?;

    let created = create_release(&repo, tag, &format!("Release {tag}"), &token)?;
    let result = (|| {
        upload_asset(&repo, created.id, &manifest_path, &token)?;
        upload_asset(&repo, created.id, &payload, &token)
    })();
    let _ = std::fs::remove_file(&payload); // best-effort temp cleanup
    result?;
    Ok(created.info)
}

/// Zip the manifest + every `[[install]]` source into a temp `<repo>-<tag>.zip`
/// at project-relative paths, so unpacking it yields a project-shaped tree the
/// installer can deploy. Returns the temp archive path.
fn package_payload(
    root: &Path,
    repo_name: &str,
    tag: &str,
    manifest: &dcs_studio_project::manifest::Manifest,
) -> Result<PathBuf, String> {
    let safe_tag: String = tag
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let zip_path = std::env::temp_dir().join(format!("dcs-studio-{repo_name}-{safe_tag}.zip"));
    let file = std::fs::File::create(&zip_path).map_err(|e| format!("create payload: {e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default();

    zip_add_file(&mut zip, root, Path::new(MANIFEST_FILE), opts)?;
    for rule in &manifest.install {
        let rel = Path::new(&rule.source);
        let abs = root.join(rel);
        if abs.is_file() {
            zip_add_file(&mut zip, root, rel, opts)?;
        } else if abs.is_dir() {
            zip_add_dir(&mut zip, root, rel, opts)?;
        } else {
            return Err(format!("install source not found: {}", rule.source));
        }
    }
    zip.finish().map_err(|e| format!("finish payload: {e}"))?;
    Ok(zip_path)
}

/// Add `root/rel` to the zip under its forward-slashed relative path.
fn zip_add_file(
    zip: &mut zip::ZipWriter<std::fs::File>,
    root: &Path,
    rel: &Path,
    opts: zip::write::SimpleFileOptions,
) -> Result<(), String> {
    let bytes = std::fs::read(root.join(rel)).map_err(|e| format!("read {}: {e}", rel.display()))?;
    let name = rel.to_string_lossy().replace('\\', "/");
    zip.start_file(name, opts).map_err(|e| format!("zip entry: {e}"))?;
    zip.write_all(&bytes).map_err(|e| format!("zip write: {e}"))?;
    Ok(())
}

/// Recursively add every file under `root/rel` to the zip (relative to `root`).
fn zip_add_dir(
    zip: &mut zip::ZipWriter<std::fs::File>,
    root: &Path,
    rel: &Path,
    opts: zip::write::SimpleFileOptions,
) -> Result<(), String> {
    let dir = root.join(rel);
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("read dir {}: {e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("dir entry: {e}"))?;
        let child_rel = rel.join(entry.file_name());
        let kind = entry.file_type().map_err(|e| format!("file type: {e}"))?;
        if kind.is_dir() {
            zip_add_dir(zip, root, &child_rel, opts)?;
        } else if kind.is_file() {
            zip_add_file(zip, root, &child_rel, opts)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_makes_github_safe_names() {
        assert_eq!(slugify("My Script Mod"), "my-script-mod");
        assert_eq!(slugify("  A-10C  HUD!! "), "a-10c-hud");
        assert_eq!(slugify("already-ok_1.2"), "already-ok_1.2");
        assert_eq!(slugify("???"), "");
    }

    #[test]
    fn plan_always_tags_dcs_studio_and_falls_back_to_a_name() {
        let plan = plan_for("My Script Mod");
        assert_eq!(plan.name, "my-script-mod");
        assert!(plan.topics.contains(&"dcs-studio".to_string()));
        // An unusable name still yields a valid repo slug.
        assert_eq!(plan_for("???").name, "dcs-mod");
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
}
