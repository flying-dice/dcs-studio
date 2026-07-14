// @ts-nocheck
// Documentation content for the Docs panel. Pure data: sections → pages with
// HTML bodies, rendered by docs.js. Internal links use data-page="<id>";
// buttons with data-command="<cmd>" run extension commands in the host.
window.__DOCS__ = {
  sections: [
    {
      title: "Getting Started",
      pages: [
        {
          id: "overview",
          title: "Welcome to DCS Studio",
          lede: "DCS Studio brings DCS World mod tooling into VS Code: a community marketplace, one-click mod management, a live in-sim Lua console and debugger, and a guided path from empty folder to published mod.",
          body: `
<h2>The sidebar at a glance</h2>
<ul>
  <li><strong>Browse Mods</strong> — the Marketplace. Discover and install community mods published on GitHub. <a data-page="finding-mods">Finding mods</a></li>
  <li><strong>My Mods</strong> — everything you have installed: enable, disable, update or uninstall. <a data-page="updating-uninstalling">Managing installed mods</a></li>
  <li><strong>Create a Mod</strong> — start a project from a template, or edit the current project's manifest. Reads as <em>Edit Project</em> once your workspace has a <code>dcs-studio.toml</code>. Just want to share a mission? Use the <strong>Share a Mission</strong> template. <a data-page="creating-a-project">Creating a project</a></li>
  <li><strong>Publish Mod</strong> — preflight checks, share to GitHub, create a release. Appears once the workspace has a manifest. <a data-page="publishing">Publishing</a></li>
  <li><strong>DCS Console</strong> — a live Lua REPL inside the running sim. <a data-page="dcs-console">DCS Console</a></li>
  <li><strong>MissionScripting</strong> — safely desanitize / re-sanitize DCS's Lua sandbox. <a data-page="mission-scripting">MissionScripting</a></li>
  <li><strong>Documentation</strong> — this panel.</li>
  <li><strong>Settings</strong> — DCS paths and options. <a data-page="settings">Settings &amp; paths</a></li>
</ul>

<h2>First-run setup</h2>
<p>Most features need to know where DCS lives. Open Settings and confirm two paths:</p>
<ul>
  <li><strong>Saved Games write dir</strong> — usually <code>%USERPROFILE%\\Saved Games\\DCS</code>. Auto-detected; this is where mods get linked and where the bridge is injected.</li>
  <li><strong>Game install dir</strong> — e.g. <code>C:\\Program Files\\Eagle Dynamics\\DCS World</code>. Detected from the registry; needed to launch DCS and for mods that install into the game folder.</li>
</ul>
<div class="cmd-row">
  <button class="cmd-btn" data-command="dcs.setup.open">Open Settings</button>
  <button class="cmd-btn" data-command="dcs.marketplace.open">Open Marketplace</button>
</div>

<h2>The status bar</h2>
<p>Two items live in the status bar: <strong>DCS Marketplace</strong> (always available) and the <strong>bridge status</strong> — <em>offline</em>, <em>at menu</em>, or <em>mission running</em> with the sim time. The same status is mirrored at the bottom of the sidebar. Clicking the bridge item opens the Lua console.</p>
`,
        },
      ],
    },
    {
      title: "Mod Manager",
      pages: [
        {
          id: "finding-mods",
          title: "Finding Mods",
          lede: "The Marketplace is a storefront over GitHub: any public repository tagged with the dcs-studio topic shows up automatically — there is no central registry, no account, no gatekeeper.",
          body: `
<h2>How discovery works</h2>
<p>When you open <strong>Browse Mods</strong>, DCS Studio queries the GitHub search API for repositories carrying the <code>dcs-studio</code> topic (up to 100 results, most-starred first). If a mod author has tagged their repo, it appears in the grid — that's the whole mechanism. See <a data-page="publishing">Publishing</a> for how a mod gets that tag.</p>
<div class="note">
  <p>You can point the storefront at a different topic with the <code>dcsStudio.discoveryTopic</code> setting — handy for a squadron running its own curated tag.</p>
</div>

<h2>What a listing shows</h2>
<ul>
  <li><strong>Name, author &amp; avatar</strong> — taken from the GitHub repository and its owner.</li>
  <li><strong>Description</strong> — the repo description.</li>
  <li><strong>Stars</strong> — GitHub stars, the popularity signal (there is no download counter).</li>
  <li><strong>Labels</strong> — every <em>other</em> topic on the repo becomes a filterable tag. An author who tags their repo <code>a-10c</code>, <code>missions</code> gets those as labels.</li>
</ul>
<p>Opening a listing shows the full product page: the rendered README, the latest release tag, and the download size summed from the release assets.</p>

<h2>Searching and filtering</h2>
<p>Search, tag filters and sorting (by stars or name) all run instantly in the panel — the listing set is fetched once and filtered client-side. Click a tag on any card to filter by it, and use <strong>Refresh</strong> (or the <code>DCS Studio: Refresh Marketplace</code> command) to re-query GitHub.</p>

<h2>Installable mods</h2>
<p>A mod's <strong>Install</strong> button is live only when its latest GitHub release ships a <code>dcs-studio.toml</code> asset (see <a data-page="mod-bundles">Mod bundles</a>). A repo with the topic but no proper release is browsable but not installable.</p>

<div class="note warn">
  <p><strong>Rate limits:</strong> anonymous GitHub API access is rate-limited. If the marketplace reports a rate limit, sign in to GitHub to raise it, or wait a minute and refresh.</p>
</div>
<div class="cmd-row">
  <button class="cmd-btn" data-command="dcs.marketplace.open">Open Marketplace</button>
</div>
`,
        },
        {
          id: "installing-mods",
          title: "Installing Mods",
          lede: "Install is a two-step lifecycle under the hood — download once, then link into DCS. Your DCS folders only ever receive lightweight links, never unpacked copies.",
          body: `
<h2>What happens when you click Install</h2>
<ol>
  <li><strong>Subscribe</strong> — the mod's <a data-page="mod-bundles">bundle</a> (its <code>.7z</code> payload, possibly split into numbered volumes) is downloaded from the GitHub release and extracted with 7-Zip into your local mod data directory. The payload contains every <code>[[bundle]]</code> path the author declared.</li>
  <li><strong>Enable</strong> — each <code>[[symlink]]</code> rule in the mod's manifest is resolved and a link is created from the unpacked files into your DCS folders (Saved Games and/or the game install). Because bundling and linking are separate, a mod can ship a whole folder but link only a file or two from inside it.</li>
</ol>
<p>Before installing, the marketplace shows you the <strong>install plan</strong> — exactly which paths will be linked where — by reading the standalone <code>dcs-studio.toml</code> asset from the release, without downloading the payload.</p>

<h2>Where mods live on disk</h2>
<p>Downloaded mods are unpacked to the <strong>data directory</strong>:</p>
<pre><code>%USERPROFILE%\\DCSStudio\\mods\\
  &lt;owner&gt;__&lt;repo&gt;\\        one folder per mod (e.g. viper-drivers__f16-weapons)
  subscriptions.json        the ledger of everything installed
  uninstall-all.bat         clean-uninstall escape hatch</code></pre>
<p>This directory is deliberately <em>outside</em> DCS's folders so the sim never scans raw unpacked assets. Change it with the <code>dcsStudio.dataDir</code> setting.</p>

<h2>Links, not copies</h2>
<p>Enabling a mod places links into DCS's folders instead of copying files. The primitive depends on what the <code>[[symlink]].source</code> is and whether it lands on the same drive:</p>
<table>
  <tr><th>Source</th><th>Destination</th><th>Link primitive</th></tr>
  <tr><td>Directory</td><td>Does not exist yet</td><td>NTFS <em>junction</em> (no elevation needed)</td></tr>
  <tr><td>Directory</td><td><strong>Existing real directory</strong> (e.g. <code>Scripts/Hooks</code>)</td><td><em>Merged into</em>: each child is linked individually, so the shared DCS folder is never replaced</td></tr>
  <tr><td>File</td><td>Same drive</td><td><em>Hard link</em></td></tr>
  <tr><td>File</td><td>Another drive</td><td><em>Symlink</em> (Windows may show a one-time elevation prompt)</td></tr>
</table>
<p>Re-enabling a mod whose links are already in place is idempotent — a link DCS Studio already created for that source is re-adopted, not treated as a clash. A destination occupied by a <em>foreign</em> file (or a link pointing elsewhere) is a conflict: the enable fails, naming the exact path, so an unrelated file is never overwritten.</p>
<p>Links cost no disk space, and disabling a mod is instant — the links are removed while the downloaded files stay put. If any link fails to create, the whole enable is rolled back so you're never left half-installed.</p>

<h2>Uninstall semantics</h2>
<p>Disabling or uninstalling removes <strong>only the links DCS Studio created</strong>. Junctions are removed with a plain directory-unlink that can never delete <em>through</em> the link into your real mod files or DCS install, and a folder that was merged-into keeps everything that wasn't ours. Uninstall additionally deletes the mod's unpacked payload from the data directory; the surrounding DCS folders are left exactly as they were.</p>

<h2>Prerequisites shown on the product page</h2>
<ul>
  <li><strong>Required modules</strong> — stock DCS modules (aircraft, terrains) the mod expects you to own, e.g. <code>ed/f16c</code>. These are informational; DCS Studio can't install DCS modules for you.</li>
</ul>
<div class="cmd-row">
  <button class="cmd-btn" data-command="dcs.marketplace.open">Open Marketplace</button>
  <button class="cmd-btn" data-command="dcs.mymods.open">Open My Mods</button>
</div>
`,
        },
        {
          id: "mod-bundles",
          title: "What Is a Mod Bundle?",
          lede: "A mod bundle is a GitHub release carrying two kinds of asset: the manifest, and one or more 7-Zip payload volumes that mirror the project's folder layout.",
          body: `
<h2>Anatomy of a bundle</h2>
<p>Every installable mod release contains:</p>
<table>
  <tr><th>Asset</th><th>Purpose</th></tr>
  <tr><td><code>dcs-studio.toml</code></td><td>The manifest, uploaded standalone so the marketplace can read the install plan <em>without</em> downloading the payload. Its presence is also what makes the release installable.</td></tr>
  <tr><td><code>dcs-studio-&lt;name&gt;-&lt;tag&gt;.7z</code></td><td>The payload: the manifest plus every <code>[[bundle]]</code> path, compressed with 7-Zip.</td></tr>
  <tr><td><code>…&#8203;.7z.001</code>, <code>.002</code>, …</td><td>Large payloads are split into numbered volumes (1.5&nbsp;GiB each by default) because GitHub rejects single assets over 2&nbsp;GiB. The installer downloads all volumes and extracts them as one archive.</td></tr>
</table>

<h2>Inside the archive</h2>
<p>The archive's internal structure <strong>mirrors the project layout</strong> — files are stored relative to the project root, exactly as the author's repo is laid out:</p>
<pre><code>dcs-studio.toml
Scripts/my-mod.lua
Scripts/Hooks/my-mod_hook.lua
target/release/my-mod.dll</code></pre>
<p>On install this tree is extracted verbatim into the mod's folder under the <a data-page="installing-mods">data directory</a>. The manifest's <code>[[symlink]]</code> rules then map paths in that tree to destinations in DCS:</p>
<pre><code>[[symlink]]
source = "Scripts/my-mod.lua"                # path inside the bundle
dest   = "{SavedGames}/Scripts/my-mod.lua"   # where it gets linked</code></pre>
<p><code>{SavedGames}</code> resolves to your DCS Saved Games write dir; <code>{GameInstall}</code> to the game install folder. See the <a data-page="manifest-reference">manifest reference</a> for the full rules.</p>

<h2>Why this format?</h2>
<ul>
  <li><strong>Inspectable</strong> — the standalone manifest means you can see exactly what a mod will touch before downloading anything.</li>
  <li><strong>Reversible</strong> — because installs are links driven by the manifest, every install can be cleanly undone.</li>
  <li><strong>Plain GitHub</strong> — a bundle is just a normal release; authors need no infrastructure beyond a public repo.</li>
</ul>
`,
        },
        {
          id: "updating-uninstalling",
          title: "Updating & Uninstalling",
          lede: "My Mods is the single place to manage everything you've installed: flip mods on and off, pull updates, and remove them without leftovers.",
          body: `
<h2>Enable / disable</h2>
<p>The toggle on each mod adds or removes its links in your DCS folders. Disabling never deletes the downloaded files — it only removes the links — so re-enabling is instant and needs no download. Use this to quickly deactivate a mod before a multiplayer session with integrity check, then bring it back after.</p>

<h2>Updating a mod</h2>
<p><strong>Update</strong> checks the mod's GitHub repository for the latest release tag and compares it to the version you have installed:</p>
<ul>
  <li>If the latest tag matches yours, you're told the mod is already up to date.</li>
  <li>If it differs, the old links are removed, the new bundle is downloaded and extracted <em>replacing</em> the old files, and — if the mod was enabled — the links are re-created for the new version.</li>
</ul>
<div class="note">
  <p>Updates track the repository's <strong>latest release</strong>. Any different tag counts as an update — DCS Studio doesn't try to compare version numbers, it trusts the author's latest release.</p>
</div>

<h2>Uninstalling</h2>
<p><strong>Uninstall</strong> removes the mod's links from your DCS folders, deletes its unpacked files from the data directory, and drops it from the ledger. Nothing of the mod remains on disk.</p>

<h2>The clean-uninstall escape hatch</h2>
<p>The data directory always contains an up-to-date <code>uninstall-all.bat</code>. Run it (My Mods offers a button, with confirmation) to remove <em>every</em> DCS Studio link from your DCS folders and delete all unpacked mod data — even without VS Code. It removes junctions with plain <code>rmdir</code> so it can never delete through a link into your actual mod files or DCS installation.</p>

<h2>Desktop shortcut</h2>
<p><em>Add My Mods Shortcut</em> creates a Windows shortcut (Desktop and/or Start Menu) that opens My Mods directly in a fresh VS Code window — a launcher for managing mods without opening a project first.</p>
<div class="cmd-row">
  <button class="cmd-btn" data-command="dcs.mymods.open">Open My Mods</button>
  <button class="cmd-btn" data-command="dcs.mymods.createShortcut">Add Desktop Shortcut</button>
</div>
`,
        },
      ],
    },
    {
      title: "Creating Mods",
      pages: [
        {
          id: "creating-a-project",
          title: "Creating a Project",
          lede: "Create a Mod scaffolds a working project from a template — manifest included — and opens the two-way-bound manifest form so you never have to hand-write TOML.",
          body: `
<h2>Starting a project</h2>
<p><strong>Create a Mod</strong> in the sidebar opens the New Project experience (or, if your workspace already has a <code>dcs-studio.toml</code>, jumps straight to editing it). You can scaffold into a <strong>new folder</strong> or <strong>in place</strong> into the current folder — in-place keeps existing files and reports anything it skipped.</p>

<h2>Templates</h2>
<table>
  <tr><th>Template</th><th>What you get</th></tr>
  <tr><td><strong>Blank Project</strong></td><td>Just a <code>dcs-studio.toml</code> with commented examples for bundle + symlink rules.</td></tr>
  <tr><td><strong>Lua Mission Script</strong></td><td>A <code>Scripts/&lt;name&gt;.lua</code> using the mission environment (<code>env</code>, <code>timer</code>, <code>trigger</code>, <code>world</code>), a bundle + symlink pair targeting <code>{SavedGames}/Scripts</code>, and a README.</td></tr>
  <tr><td><strong>Lua GameGUI Hook</strong></td><td>A <code>Scripts/Hooks/&lt;name&gt;_hook.lua</code> using <code>DCS.setUserCallbacks</code>, bundled and linked into <code>{SavedGames}/Scripts/Hooks</code>.</td></tr>
  <tr><td><strong>Rust DLL Mod</strong></td><td>A complete <code>mlua</code> cdylib crate pre-configured to link against DCS's own <code>lua.dll</code>, a loader hook script, and bundle + symlink rules for both the built DLL (<code>{SavedGames}/Mods/tech/&lt;name&gt;/bin</code>) and the hook.</td></tr>
  <tr><td><strong>Share a Mission</strong></td><td>A <code>Missions/</code> folder for your <code>.miz</code>, a bundle + symlink pair targeting <code>{SavedGames}/Missions/&lt;name&gt;.miz</code>, and a README — just save your mission into <code>Missions/</code> (or scaffold in place over a folder that already has one).</td></tr>
</table>

<h2>The manifest form</h2>
<p>Opening any <code>dcs-studio.toml</code> keeps the real text editor and opens an <strong>authoring form beside it</strong>. The two are two-way bound: edit either side and the other follows. The form covers the project info, bundled content, symlinks and required modules; anything it doesn't model (custom sections like <code>[release]</code> or <code>[lints]</code>) is preserved verbatim in the file.</p>
<div class="cmd-row">
  <button class="cmd-btn" data-command="dcs.manifest.author">Create / Edit a Mod</button>
  <button class="cmd-btn" data-command="dcs.project.new">New Project from Template</button>
</div>
<p>Next: the full <a data-page="manifest-reference">dcs-studio.toml reference</a>, then <a data-page="publishing">publishing</a>.</p>
`,
        },
        {
          id: "manifest-reference",
          title: "dcs-studio.toml Reference",
          lede: "The manifest is a TOML file at the project root. It names the mod and declares what gets bundled and what gets linked — it is both the build recipe for publishing and the install plan for users.",
          body: `
<h2>Complete example</h2>
<pre><code>[project]
name = "My F-16 Weapons Expansion"
version = "1.2.0"
author = "Viper Drivers"
description = "Adds new loadout options for the F-16C."
dcs_min_version = "2.9.0"

[[requires_module]]
id = "ed/f16c"
name = "F-16C Viper"

# What gets packed into the release archive.
[[bundle]]
path = "Mods/tech/f16-weapons"

[[bundle]]
path = "Scripts/f16-weapons.lua"

# Which links are created when a user enables the mod. A symlink source is a
# path INSIDE the bundled content — you can bundle a whole folder and link
# just one file from inside it.
[[symlink]]
source = "Mods/tech/f16-weapons/entry.lua"
dest = "{SavedGames}/Mods/tech/f16-weapons/entry.lua"

[[symlink]]
source = "Scripts/f16-weapons.lua"
dest = "{SavedGames}/Scripts/f16-weapons.lua"</code></pre>

<h2><code>[project]</code> — identity</h2>
<table>
  <tr><th>Key</th><th>Required</th><th>Meaning</th></tr>
  <tr><td><code>name</code></td><td><strong>Yes</strong></td><td>The mod's display name. Publishing fails preflight if blank; also the default GitHub repo name.</td></tr>
  <tr><td><code>version</code></td><td>No (default <code>"0.1.0"</code>)</td><td>Suggested as the release tag when you publish.</td></tr>
  <tr><td><code>author</code></td><td>No</td><td>Shown on the product page.</td></tr>
  <tr><td><code>description</code></td><td>No</td><td>Becomes the GitHub repo description on first publish.</td></tr>
  <tr><td><em>anything else</em></td><td>No</td><td>Extra keys (e.g. <code>dcs_min_version</code>, <code>template</code>) are preserved verbatim — the tooling never strips what it doesn't model.</td></tr>
</table>

<h2><code>[[bundle]]</code> — what gets packed</h2>
<p>Zero or more entries. Each declares one path packed into the release <a data-page="mod-bundles">bundle</a> (the <code>.7z</code>) when you publish. Bundling is decoupled from linking: bundle a whole folder here, then link only the pieces you need with <code>[[symlink]]</code>.</p>
<table>
  <tr><th>Key</th><th>Required</th><th>Meaning</th></tr>
  <tr><td><code>path</code></td><td>Yes</td><td>A file or directory, <strong>relative to the project root</strong>. Must exist on disk at publish time and must not itself be a symlink (the packager refuses symlinks). Repeated identical paths are packed once.</td></tr>
</table>

<h2><code>[[symlink]]</code> — what gets linked on enable</h2>
<p>Zero or more links, created when a user enables the mod and removed when they disable it. Each <code>source</code> must resolve to a path <strong>inside the bundled content</strong> — preflight rejects a symlink whose source no <code>[[bundle]]</code> path covers, because the payload would never ship that file.</p>
<table>
  <tr><th>Key</th><th>Required</th><th>Meaning</th></tr>
  <tr><td><code>source</code></td><td>Yes</td><td>A path inside a bundled path (equal to a <code>[[bundle]].path</code>, or nested under one), <strong>relative to the project root</strong>.</td></tr>
  <tr><td><code>dest</code></td><td>Yes</td><td>Destination path beginning with a root token (below).</td></tr>
</table>
<h3>Destination root tokens</h3>
<table>
  <tr><th>Token</th><th>Resolves to</th></tr>
  <tr><td><code>{SavedGames}</code></td><td>The user's DCS write dir, e.g. <code>%USERPROFILE%\\Saved Games\\DCS</code>. The default — a dest with no token is treated as under <code>{SavedGames}</code>.</td></tr>
  <tr><td><code>{GameInstall}</code></td><td>The DCS installation folder. Only resolvable if the user has configured it; prefer <code>{SavedGames}</code> whenever DCS supports it.</td></tr>
</table>

<h3>How a symlink is created (folder vs file)</h3>
<p>The link primitive is chosen from what the <code>source</code> is and where the <code>dest</code> lands; see <a data-page="installing-mods">Installing mods</a> for the full table. In short: a <strong>folder</strong> becomes an NTFS junction; a <strong>file on the same drive</strong> a hard link; a <strong>file on another drive</strong> a symlink. If the <code>dest</code> is an <strong>existing real directory</strong> (e.g. <code>Scripts/Hooks</code>) and the source is a directory, the source is <em>merged into</em> it child-by-child so a shared DCS folder is never clobbered. Uninstalling removes only the links DCS Studio created — never the surrounding real files.</p>

<div class="note">
  <p>A mod with <strong>no</strong> <code>[[bundle]]</code> paths publishes fine (with a warning) but ships only its manifest — useful for metadata-only packages. A mod may bundle content without linking any of it (an asset pack consumed by another mod).</p>
</div>

<h2>Legacy <code>[[install]]</code> (deprecated)</h2>
<p>Older manifests used a single <code>[[install]] { source, dest }</code> array where one rule meant <em>both</em> "pack this" and "link this". That form still installs from old published releases and still loads in the editor, but it is deprecated in favour of the split blocks. Each legacy rule is exactly equivalent to a <code>[[bundle]]</code> plus a <code>[[symlink]]</code>:</p>
<pre><code># legacy
[[install]]
source = "Scripts/mod.lua"
dest = "{SavedGames}/Scripts/mod.lua"

# equivalent modern form
[[bundle]]
path = "Scripts/mod.lua"

[[symlink]]
source = "Scripts/mod.lua"
dest = "{SavedGames}/Scripts/mod.lua"</code></pre>
<div class="note">
  <p><strong>Migration:</strong> DCS Studio reads a legacy <code>[[install]]</code> file without rewriting it, but the moment you edit and save through the form it is re-emitted as <code>[[bundle]]</code> + <code>[[symlink]]</code> — that save <em>is</em> the migration, and it is one-way. A manifest may carry both forms at once; the legacy rules are folded in and identical entries de-duplicated.</p>
</div>

<h2><code>[[entrypoint]]</code> — executables the mod can launch</h2>
<p>Zero or more executable entrypoints. Some mods are not (only) DCS content — they ship a companion app (e.g. an SRS server) meant to be launched as a process. Each block declares one executable that appears with a <strong>Launch / Stop</strong> control in <a data-page="installing-mods">My Mods</a> once the mod is enabled.</p>
<table>
  <tr><th>Key</th><th>Required</th><th>Meaning</th></tr>
  <tr><td><code>id</code></td><td>Yes</td><td>A unique slug identifying this entrypoint (e.g. <code>srs-server</code>). Must be unique within the manifest — preflight rejects duplicates.</td></tr>
  <tr><td><code>name</code></td><td>Yes</td><td>Display name shown in My Mods, e.g. <code>"SRS Server"</code>.</td></tr>
  <tr><td><code>exe</code></td><td>Yes</td><td>Path to the executable, <strong>relative to the unpacked mod dir</strong>. Must be covered by a <code>[[bundle]]</code> path (the payload has to ship it), exactly like a symlink source.</td></tr>
  <tr><td><code>args</code></td><td>No</td><td>Array of command-line arguments, e.g. <code>["--minimized"]</code>. Each may contain the <code>{SavedGames}</code>/<code>{GameInstall}</code> root tokens, expanded at launch. In the form, enter one argument per line.</td></tr>
  <tr><td><code>cwd</code></td><td>No</td><td>Working directory, relative to the unpacked mod dir. Defaults to the directory containing the <code>exe</code>.</td></tr>
</table>
<pre><code>[[bundle]]
path = "Server"

[[entrypoint]]
id = "srs-server"
name = "SRS Server"
exe = "Server/SR-Server.exe"
args = ["--minimized"]
cwd = "Server"</code></pre>
<div class="note">
  <p><strong>Exe-only mods are valid.</strong> A mod may declare <code>[[entrypoint]]</code> blocks with <em>no</em> <code>[[symlink]]</code> rules at all — it still bundles the exe and installs normally; enabling it just links nothing.</p>
</div>
<h3>Trust, running state, and lifecycle</h3>
<ul>
  <li><strong>First-launch consent.</strong> Launching a mod-shipped executable is gated: the first time you launch a given mod + entrypoint, DCS Studio shows a modal naming the exe path. Choose <em>Launch</em> to run it once, or <em>Always allow for this mod</em> to remember the choice. Declining does not launch.</li>
  <li><strong>Tracked, not fire-and-forget.</strong> Launched processes are tracked so My Mods can show a running state and offer <em>Stop</em> (which kills the whole process tree).</li>
  <li><strong>Stop on disable / uninstall.</strong> Disabling or uninstalling a mod first stops any of its running entrypoints.</li>
  <li><strong>On IDE exit.</strong> DCS Studio deliberately leaves launched processes running when it closes (the same policy as the DCS launcher, which never kills DCS on exit) — a companion app keeps running until you stop it.</li>
</ul>

<h2><code>[[mission_script]]</code> — Lua run at mission start</h2>
<p>Zero or more Lua scripts DCS Studio runs at mission start through its <a data-page="mission-scripting">managed <code>MissionScripting.lua</code> entrypoint</a>. Use this when a mod needs Lua to run automatically for every mission — MOOSE-style frameworks, telemetry exporters, server-side script packs — rather than being loaded by a mission trigger.</p>
<table>
  <tr><th>Key</th><th>Required</th><th>Meaning</th></tr>
  <tr><td><code>name</code></td><td>Yes</td><td>Display name shown to subscribers and used as the aggregator tag. Preflight rejects an empty name.</td></tr>
  <tr><td><code>purpose</code></td><td>No</td><td>One line explaining what the script does, shown to subscribers.</td></tr>
  <tr><td><code>path</code></td><td>Yes</td><td>Path to the <code>.lua</code> file, relative to the bundled payload. Must be covered by a <code>[[bundle]]</code> path, exactly like a symlink source or an entrypoint exe.</td></tr>
  <tr><td><code>run_on</code></td><td>Yes</td><td><code>"after-sanitize"</code> (the safe default — runs in the normal sandboxed mission environment) or <code>"before-sanitize"</code> (runs with the full unsanitized Lua environment).</td></tr>
</table>
<pre><code>[[bundle]]
path = "Scripts/my-framework"

[[mission_script]]
name = "My Framework loader"
purpose = "Boots the framework so missions can require it"
path = "Scripts/my-framework/loader.lua"
run_on = "after-sanitize"</code></pre>
<div class="note warn">
  <p><strong>Security — <code>before-sanitize</code> runs unsandboxed.</strong> A <code>run_on = "before-sanitize"</code> script executes <em>before</em> DCS's lockdown, with full <code>os</code>, <code>io</code>, <code>lfs</code> and <code>require</code>/<code>package</code> access — i.e. arbitrary file and process access on the subscriber's machine. That is the point for some mods (exporters, hooks bridges) and also the entire risk. Only use it when a mod genuinely needs it. The marketplace will surface a prominent warning on any mod that injects pre-sanitization code so subscribers can judge the source before installing; the manifest form marks these rows with a warning too.</p>
</div>
<p>How it runs: DCS Studio owns two <code>dofile</code> trigger lines in <code>&lt;gameInstall&gt;/Scripts/MissionScripting.lua</code> — one before the sanitize block, one after — and regenerates two managed aggregator files in <code>Saved Games/DCS/Scripts/</code> from your enabled mods on every enable/disable. See <a data-page="mission-scripting">MissionScripting</a>.</p>

<h2><code>[[requires_module]]</code> — stock DCS content</h2>
<p>Declares official DCS modules the user must own. Shown as prerequisites on the product page.</p>
<table>
  <tr><th>Key</th><th>Required</th><th>Meaning</th></tr>
  <tr><td><code>id</code></td><td>Yes</td><td>Module id, e.g. <code>ed/f16c</code>, <code>ed/syria</code>.</td></tr>
  <tr><td><code>name</code></td><td>No</td><td>Display name, e.g. <code>"F-16C Viper"</code>.</td></tr>
</table>

<h2>Editing</h2>
<p>Open the file to get the <a data-page="creating-a-project">form editor</a> beside the text. The parser is tolerant: unknown sections (<code>[format]</code>, <code>[release]</code>, …) round-trip untouched. One v1 limitation — comments <em>inside</em> the modeled sections aren't preserved when the form rewrites them.</p>
`,
        },
        {
          id: "publishing",
          title: "Publishing Your Mod",
          lede: "Publishing is three guided steps — preflight, share to GitHub, create a release — and needs nothing but a GitHub account. What makes your mod appear in the marketplace is precisely two things: the topic on the repo, and a manifest asset on the release.",
          body: `
<h2>Prerequisites (checked by preflight)</h2>
<p>The Publish panel runs a preflight and shows a checklist. It verifies:</p>
<ul>
  <li><code>dcs-studio.toml</code> exists at the workspace root, parses, and has a non-blank <code>project.name</code>;</li>
  <li>every <code>[[bundle]].path</code> exists on disk (build first!) and none is a symlink — the packager refuses symlinks;</li>
  <li>every <code>[[symlink]].source</code> is covered by a <code>[[bundle]]</code> path (you can't link content the payload never ships);</li>
  <li>every <code>[[entrypoint]].exe</code> is covered by a <code>[[bundle]]</code> path and every entrypoint <code>id</code> is unique;</li>
  <li><strong>7-Zip</strong> is installed (or set <code>dcsStudio.sevenZipPath</code>);</li>
  <li><strong>git</strong> is installed;</li>
  <li>the <strong>GitHub CLI</strong> (<code>gh</code>) is installed <em>and</em> signed in (<code>gh auth login</code>).</li>
</ul>

<h2>Step 1 — Share to GitHub</h2>
<p>One click turns the folder into a published repo:</p>
<ol>
  <li>Initializes git if needed (branch <code>main</code>) and adds <code>.dcs-studio/</code> to <code>.gitignore</code> (release artifacts stay out of the repo).</li>
  <li>Commits any pending changes and creates a <strong>public</strong> GitHub repository via <code>gh repo create</code> (or just pushes if <code>origin</code> already exists).</li>
  <li>Applies the <code>dcs-studio</code> topic — <strong>this is what makes the marketplace find your repo</strong>.</li>
</ol>

<h2>Step 2 — Create a release</h2>
<p>Enter a tag (your manifest <code>version</code> is suggested) and optional notes. DCS Studio then:</p>
<ol>
  <li>packs <code>dcs-studio.toml</code> + every <code>[[bundle]]</code> path into <code>dcs-studio-&lt;name&gt;-&lt;tag&gt;.7z</code> under <code>.dcs-studio/release/</code>, splitting into numbered volumes if it exceeds ~1.5&nbsp;GiB;</li>
  <li>uploads the payload <em>and</em> a standalone <code>dcs-studio.toml</code> as release assets;</li>
  <li>creates the git tag and GitHub release. Re-publishing the same tag first deletes the old release+tag, so releasing <code>1.0.0</code> twice is safe and idempotent.</li>
</ol>

<h2>What makes a mod "detected"</h2>
<table>
  <tr><th>You want</th><th>You need</th></tr>
  <tr><td>Appear in the marketplace grid</td><td>Public GitHub repo with the <code>dcs-studio</code> topic.</td></tr>
  <tr><td>A live <strong>Install</strong> button</td><td>The <em>latest</em> release must include a <code>dcs-studio.toml</code> asset.</td></tr>
  <tr><td>Tags/labels on your card</td><td>Add more GitHub topics — every extra topic becomes a filterable label.</td></tr>
  <tr><td>Users get updates</td><td>Create a release with a new tag; <a data-page="updating-uninstalling">Update</a> follows your latest release.</td></tr>
</table>
<div class="note warn">
  <p>The marketplace always reads the <strong>latest</strong> release. If you create a release without the manifest asset (e.g. by hand on github.com), your mod will show as not installable until the next proper release.</p>
</div>
<div class="cmd-row">
  <button class="cmd-btn" data-command="dcs.publish.open">Open Publish Panel</button>
</div>
`,
        },
      ],
    },
    {
      title: "Tools",
      pages: [
        {
          id: "dcs-console",
          title: "DCS Console",
          lede: "A live Lua REPL against the running sim, over the DCS Studio bridge.",
          body: `
<p>The console evaluates Lua inside a running DCS and prints the result. Pick the target environment at the top:</p>
<ul>
  <li><strong>GUI / hooks</strong> — the GameGUI state where <code>DCS.*</code> and <code>net.*</code> live (the bridge's home).</li>
  <li><strong>Mission</strong> — the mission scripting sandbox (<code>trigger.action</code>, <code>coalition</code>, <code>world</code>…), served by the mission bridge. Needs a running mission and a <a data-page="mission-scripting">desanitized MissionScripting.lua</a>.</li>
</ul>
<p><code>print</code> output from any environment streams into the console. The <strong>Explorer</strong> tab lazily drills into live Lua tables and can export any table as JSON to a file of your choice.</p>
<p>The console requires the <a data-page="bridge">bridge</a> to be injected and DCS running — the sidebar footer and status bar show the live connection state.</p>
<div class="cmd-row">
  <button class="cmd-btn" data-command="dcs.bridge.console">Open Lua Console</button>
</div>
`,
        },
        {
          id: "mission-scripting",
          title: "MissionScripting Sanitization",
          lede: "DCS ships its mission scripting environment locked down. DCS Studio edits that lockdown safely, reversibly, and with a backup.",
          body: `
<p><code>MissionScripting.lua</code> in the DCS install sanitizes <code>os</code>, <code>io</code>, <code>lfs</code> and nils <code>require</code>, <code>loadlib</code> and <code>package</code> for every mission script. Mission-side tooling (including the bridge's mission features and the debugger's mission environment) needs some of that restored.</p>
<ul>
  <li><strong>Desanitize</strong> — comments out the lockdown lines, preserving the file's indentation and line endings. The first change writes a pristine backup next to the file (<code>MissionScripting.lua.dcsstudio.bak</code>).</li>
  <li><strong>Re-sanitize</strong> — uncomments them, restoring stock behavior.</li>
  <li><strong>Restore</strong> — copies the pristine backup back, for when an update or manual edit leaves the file in doubt.</li>
</ul>
<div class="note warn">
  <p>Desanitizing gives mission scripts filesystem and OS access. Re-sanitize when you're not actively developing, and remember DCS updates may overwrite the file (Restore + Desanitize again).</p>
</div>
<div class="cmd-row">
  <button class="cmd-btn" data-command="dcs.mission.open">Open MissionScripting.lua</button>
</div>

<h2>Managed mod mission-script hooks</h2>
<p>Separately from the sanitize toggle above, DCS Studio can own two <code>dofile</code> trigger lines in <code>MissionScripting.lua</code> so mods that declare <a data-page="manifest-schema"><code>[[mission_script]]</code></a> blocks run automatically at mission start:</p>
<ul>
  <li><code>dofile(lfs.writedir()..'Scripts/DcsStudioMissionScriptsBeforeSanitize.lua')</code> — inserted <strong>before</strong> the sanitize block, so its scripts run with the full unsanitized Lua environment.</li>
  <li><code>dofile(lfs.writedir()..'Scripts/DcsStudioMissionScriptsAfterSanitize.lua')</code> — inserted <strong>after</strong> it, for scripts that run in the normal sandbox.</li>
</ul>
<p>Those two aggregator files (in <code>Saved Games/DCS/Scripts/</code>) are <strong>regenerated from scratch</strong> from your enabled mods every time you enable or disable one — a disabled or uninstalled mod leaves no trace. Installing the hooks is idempotent and backup-first (the same <code>.dcsstudio.bak</code> snapshot), validates the trigger positions, and one-click-fixes a missing or misplaced line. Removing them clears the lines cleanly.</p>
<div class="note warn">
  <p><strong>Independent of the bridge.</strong> These hooks are for <em>mod</em> mission scripts only. The DCS Studio bridge boots via a GUI hook and does <em>not</em> edit <code>MissionScripting.lua</code> — the two mechanisms coexist. And a <code>before-sanitize</code> script runs with full <code>os</code>/<code>io</code>/<code>lfs</code>/<code>require</code> access; only install hooks for mods whose source you trust.</p>
</div>
<div class="cmd-row">
  <button class="cmd-btn" data-command="dcs.mission.hooks.install">Install mod mission-script hooks</button>
  <button class="cmd-btn" data-command="dcs.mission.hooks.remove">Remove mod mission-script hooks</button>
</div>
`,
        },
        {
          id: "sandbox",
          title: "Scripting Sandbox & Trust",
          lede: "DCS World sandboxes mission Lua to keep scripts away from your files and OS. Some mods run code before that sandbox is applied — this page explains what that means and how to judge whether to trust one.",
          body: `
<h2>What the sandbox is</h2>
<p>DCS World applies a <strong>Lua scripting sandbox</strong> that restricts what mission and mod scripts may touch at runtime. It is meant to stop scripts from doing unsafe things — unrestricted file access, operating-system calls, loading native libraries, or network operations. Once the sandbox is active, <code>os</code>, <code>io</code> and <code>lfs</code> are cut down and <code>require</code>/<code>package</code>/<code>loadlib</code> are removed.</p>

<h2>Scripts that run <em>before</em> the sandbox</h2>
<p>A mod may declare a <a data-page="manifest-reference"><code>[[mission_script]]</code></a> with <code>run_on = "before-sanitize"</code>. DCS Studio runs that script through its managed <a data-page="mission-scripting"><code>MissionScripting.lua</code></a> entrypoint <strong>before</strong> the sandbox lockdown is applied — so it executes with the <strong>full, unsanitized</strong> Lua environment.</p>
<div class="note warn">
  <p>A <code>before-sanitize</code> script has broader access than a normal sandboxed script. Because it runs prior to sandbox enforcement it can reach Lua standard libraries and functions that are otherwise restricted, including:</p>
  <ul>
    <li>File-system access (read/write/delete anywhere your account can)</li>
    <li>Operating-system functions (spawning processes, environment)</li>
    <li>Lua module / native-library loading</li>
    <li>Broad interaction with the DCS scripting environment</li>
  </ul>
  <p>This is not inherently malicious — exporters, telemetry bridges and hook frameworks legitimately need it — but it <strong>bypasses the protection the DCS sandbox normally provides</strong>.</p>
</div>

<h2>Why the marketplace warns you</h2>
<p>Because the risk is invisible from a mod's name alone, the product page and My Mods surface it up front: a <strong>pre-sanitize script</strong> risk badge next to the title, an orange count on the Mission scripts section, and a leading <strong>Script Execution Notice</strong>. The goal is informed consent — you see exactly what a mod will do before you install it.</p>

<h2>How to judge a mod</h2>
<p>Only install a mod that runs unsandboxed scripts if you:</p>
<ul>
  <li>Trust the source (author, repository, community reputation — stars and recency help);</li>
  <li>Understand the implications of unsandboxed execution;</li>
  <li>Are comfortable reviewing the Lua yourself — the source is on the mod's public GitHub repo.</li>
</ul>
<p>Neither Eagle Dynamics nor the DCS sandbox can restrict a script that runs before sandbox initialization. Installing any mod that executes unsandboxed scripts carries inherent risk; use them at your own discretion.</p>
<div class="cmd-row">
  <button class="cmd-btn" data-command="dcs.marketplace.open">Open Marketplace</button>
  <button class="cmd-btn" data-command="dcs.mymods.open">Open My Mods</button>
</div>
`,
        },
        {
          id: "debugger",
          title: "Lua Debugger",
          lede: "Run and debug Lua inside the live sim — breakpoints, stepping, scopes, watches and a debug console — in either DCS Lua environment.",
          body: `
<p>Open any <code>.lua</code> file and press <kbd>F5</kbd> (or use the editor run/debug buttons). The debugger type is <code>dcs-lua</code> with two environments:</p>
<table>
  <tr><th><code>env</code></th><th>Runs in</th><th>Needs</th></tr>
  <tr><td><code>mission</code> (default)</td><td>The mission scripting sandbox — <code>trigger.action</code>, <code>coalition</code>, <code>world</code>…</td><td>A running mission and a <a data-page="mission-scripting">desanitized</a> MissionScripting.lua.</td></tr>
  <tr><td><code>gui</code></td><td>The GameGUI hooks state — <code>DCS.*</code>, <code>net.*</code>.</td><td>Just the <a data-page="bridge">bridge</a>.</td></tr>
</table>
<p>Supported: breakpoints, step in/over/out, call stack, local/upvalue scopes, watch, hover evaluation, and assignment from the Debug Console (<code>x = 42</code> writes back into the paused frame). <code>pauseOnError</code> (default on) pauses with frames inspectable on uncaught errors.</p>
<div class="note">
  <p>A held breakpoint auto-continues after 30 seconds if the editor disappears, so a crashed editor can never freeze the sim.</p>
</div>
<pre><code>{
  "type": "dcs-lua",
  "request": "launch",
  "name": "DCS: Debug Mission Script",
  "program": "\${file}",
  "env": "mission"
}</code></pre>
`,
        },
        {
          id: "bridge",
          title: "The Bridge (Inject / Launch)",
          lede: "The bridge is a small native DLL + hook script that lives in Saved Games and gives the extension its live link into DCS.",
          body: `
<p>Everything live — the console, the debugger, the status indicators — talks to DCS through the bridges. They install into your Saved Games write dir as <code>Mods\\tech\\DcsStudio\\bin\\dcs_studio_gui.dll</code> + <code>dcs_studio_mission.dll</code> plus <code>Scripts\\Hooks\\DcsStudio.lua</code>. The GUI bridge serves the hooks state (port 25569, up whenever DCS runs); the mission bridge serves the mission scripting state (port 25570) and is booted by the hook at each mission start — which needs a <a data-page="mission-scripting">desanitized MissionScripting.lua</a>.</p>
<ul>
  <li><strong>Inject Bridge</strong> — copies the files into place. If a DLL is locked, DCS is running — close it first.</li>
  <li><strong>Launch DCS (with bridge)</strong> — injects, then starts <code>DCS.exe --no-launcher</code> from your configured install; when DCS exits the bridge is automatically ejected.</li>
  <li><strong>Eject Bridge</strong> — removes the files.</li>
  <li><strong>Build Bridge</strong> — for contributors: rebuilds the bridge workspace with cargo; inject prefers freshly built DLLs over the shipped ones.</li>
</ul>
<div class="cmd-row">
  <button class="cmd-btn" data-command="dcs.bridge.inject">Inject Bridge</button>
  <button class="cmd-btn" data-command="dcs.bridge.launch">Launch DCS</button>
</div>
`,
        },
        {
          id: "settings",
          title: "Settings & Paths",
          lede: "All configuration lives in standard VS Code settings under dcsStudio.*; the Settings panel detects sensible values for you.",
          body: `
<p>The Settings panel auto-detects DCS <strong>Saved Games</strong> write dirs (<code>Saved Games\\DCS</code> and variants, validated by their <code>Config</code> folder) and <strong>game installs</strong> (from the Eagle Dynamics registry keys and common Program Files locations, validated by <code>bin\\DCS.exe</code>).</p>
<table>
  <tr><th>Setting</th><th>Purpose</th></tr>
  <tr><td><code>dcsStudio.savedGamesPath</code></td><td>The DCS write dir — where mods link and the bridge injects. Auto-detected if unset.</td></tr>
  <tr><td><code>dcsStudio.gameInstallPath</code></td><td>The DCS installation — needed for Launch and <code>{GameInstall}</code> destinations.</td></tr>
  <tr><td><code>dcsStudio.dataDir</code></td><td>Where downloaded mods are stored. Default <code>%USERPROFILE%\\DCSStudio\\mods</code>.</td></tr>
  <tr><td><code>dcsStudio.sevenZipPath</code></td><td>Path to <code>7z.exe</code> if it isn't found automatically.</td></tr>
  <tr><td><code>dcsStudio.discoveryTopic</code></td><td>The GitHub topic the marketplace searches. Default <code>dcs-studio</code>.</td></tr>
</table>
<div class="cmd-row">
  <button class="cmd-btn" data-command="dcs.setup.open">Open Settings</button>
</div>
`,
        },
      ],
    },
  ],
};
