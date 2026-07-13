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
  <li><strong>Create a Mod</strong> — start a project from a template, or edit the current project's manifest. Reads as <em>Edit Project</em> once your workspace has a <code>dcs-studio.toml</code>. <a data-page="creating-a-project">Creating a project</a></li>
  <li><strong>Publish Mod</strong> — preflight checks, share to GitHub, cut a release. Appears once the workspace has a manifest. <a data-page="publishing">Publishing</a></li>
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

<h2>Libraries vs. installable mods</h2>
<p>A repo additionally tagged <code>dcs-studio-library</code> is a <strong>library</strong> — a shared dependency for other mods, not something you install directly. Libraries appear in the grid but offer <em>Add as dependency</em> instead of <em>Install</em>.</p>
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
  <li><strong>Subscribe</strong> — the mod's <a data-page="mod-bundles">bundle</a> (its <code>.7z</code> payload, possibly split into numbered volumes) is downloaded from the GitHub release and extracted with 7-Zip into your local mod data directory.</li>
  <li><strong>Enable</strong> — each <code>[[install]]</code> rule in the mod's manifest is resolved and a link is created from the unpacked files into your DCS folders (Saved Games and/or the game install).</li>
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
<p>Enabling a mod places links into DCS's folders instead of copying files:</p>
<ul>
  <li>a <strong>directory</strong> is linked as an NTFS <em>junction</em>,</li>
  <li>a <strong>file on the same drive</strong> as a <em>hard link</em>,</li>
  <li>a <strong>file on another drive</strong> as a <em>symlink</em> (Windows may show a one-time elevation prompt for this case).</li>
</ul>
<p>Links cost no disk space, and disabling a mod is instant — the links are removed while the downloaded files stay put. If any link fails to create, the whole enable is rolled back so you're never left half-installed.</p>

<h2>Prerequisites shown on the product page</h2>
<ul>
  <li><strong>Dependencies</strong> — other marketplace mods this one needs; install them alongside.</li>
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
  <tr><td><code>dcs-studio-&lt;name&gt;-&lt;tag&gt;.7z</code></td><td>The payload: the manifest plus every <code>[[install]]</code> source path, compressed with 7-Zip.</td></tr>
  <tr><td><code>…&#8203;.7z.001</code>, <code>.002</code>, …</td><td>Large payloads are split into numbered volumes (1.5&nbsp;GiB each by default) because GitHub rejects single assets over 2&nbsp;GiB. The installer downloads all volumes and extracts them as one archive.</td></tr>
</table>

<h2>Inside the archive</h2>
<p>The archive's internal structure <strong>mirrors the project layout</strong> — files are stored relative to the project root, exactly as the author's repo is laid out:</p>
<pre><code>dcs-studio.toml
Scripts/my-mod.lua
Scripts/Hooks/my-mod_hook.lua
target/release/my-mod.dll</code></pre>
<p>On install this tree is extracted verbatim into the mod's folder under the <a data-page="installing-mods">data directory</a>. The manifest's <code>[[install]]</code> rules then map paths in that tree to destinations in DCS:</p>
<pre><code>[[install]]
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
  <tr><td><strong>Blank Project</strong></td><td>Just a <code>dcs-studio.toml</code> with commented examples for dependencies and install rules.</td></tr>
  <tr><td><strong>Lua Mission Script</strong></td><td>A <code>Scripts/&lt;name&gt;.lua</code> using the mission environment (<code>env</code>, <code>timer</code>, <code>trigger</code>, <code>world</code>), an install rule targeting <code>{SavedGames}/Scripts</code>, and a README.</td></tr>
  <tr><td><strong>Lua GameGUI Hook</strong></td><td>A <code>Scripts/Hooks/&lt;name&gt;_hook.lua</code> using <code>DCS.setUserCallbacks</code>, installed to <code>{SavedGames}/Scripts/Hooks</code>.</td></tr>
  <tr><td><strong>Rust DLL Mod</strong></td><td>A complete <code>mlua</code> cdylib crate pre-configured to link against DCS's own <code>lua.dll</code>, a loader hook script, and install rules for both the built DLL (<code>{SavedGames}/Mods/tech/&lt;name&gt;/bin</code>) and the hook.</td></tr>
</table>

<h2>The manifest form</h2>
<p>Opening any <code>dcs-studio.toml</code> keeps the real text editor and opens an <strong>authoring form beside it</strong>. The two are two-way bound: edit either side and the other follows. The form covers the project info, install rules, dependencies and required modules; anything it doesn't model (custom sections like <code>[release]</code> or <code>[lints]</code>) is preserved verbatim in the file.</p>
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
          lede: "The manifest is a TOML file at the project root. It names the mod, declares what gets installed where, and lists dependencies — it is both the build recipe for publishing and the install plan for users.",
          body: `
<h2>Complete example</h2>
<pre><code>[project]
name = "My F-16 Weapons Expansion"
version = "1.2.0"
author = "Viper Drivers"
description = "Adds new loadout options for the F-16C."
dcs_min_version = "2.9.0"

[[dependencies]]
id = "community/shared-weapons-lib"
version = "*"
optional = false

[[requires_module]]
id = "ed/f16c"
name = "F-16C Viper"

[[install]]
source = "Scripts/f16-weapons.lua"
dest = "{SavedGames}/Scripts/f16-weapons.lua"

[[install]]
source = "Mods/tech/f16-weapons"
dest = "{SavedGames}/Mods/tech/f16-weapons"</code></pre>

<h2><code>[project]</code> — identity</h2>
<table>
  <tr><th>Key</th><th>Required</th><th>Meaning</th></tr>
  <tr><td><code>name</code></td><td><strong>Yes</strong></td><td>The mod's display name. Publishing fails preflight if blank; also the default GitHub repo name.</td></tr>
  <tr><td><code>version</code></td><td>No (default <code>"0.1.0"</code>)</td><td>Suggested as the release tag when you publish.</td></tr>
  <tr><td><code>author</code></td><td>No</td><td>Shown on the product page.</td></tr>
  <tr><td><code>description</code></td><td>No</td><td>Becomes the GitHub repo description on first publish.</td></tr>
  <tr><td><em>anything else</em></td><td>No</td><td>Extra keys (e.g. <code>dcs_min_version</code>, <code>template</code>) are preserved verbatim — the tooling never strips what it doesn't model.</td></tr>
</table>

<h2><code>[[install]]</code> — what goes where</h2>
<p>Zero or more rules. Each links one path from your project into a DCS folder when a user enables the mod, and defines what gets packed into the <a data-page="mod-bundles">bundle</a> when you publish.</p>
<table>
  <tr><th>Key</th><th>Required</th><th>Meaning</th></tr>
  <tr><td><code>source</code></td><td>Yes</td><td>A file or directory, <strong>relative to the project root</strong>. Must exist on disk at publish time and must not be a symlink.</td></tr>
  <tr><td><code>dest</code></td><td>Yes</td><td>Destination path beginning with a root token (below).</td></tr>
</table>
<h3>Destination root tokens</h3>
<table>
  <tr><th>Token</th><th>Resolves to</th></tr>
  <tr><td><code>{SavedGames}</code></td><td>The user's DCS write dir, e.g. <code>%USERPROFILE%\\Saved Games\\DCS</code>. The default — a dest with no token is treated as under <code>{SavedGames}</code>.</td></tr>
  <tr><td><code>{GameInstall}</code></td><td>The DCS installation folder. Only resolvable if the user has configured it; prefer <code>{SavedGames}</code> whenever DCS supports it.</td></tr>
</table>
<div class="note">
  <p>A mod with <strong>no</strong> install rules publishes fine (with a warning) but ships only its manifest — useful for metadata-only or library packages.</p>
</div>

<h2><code>[[dependencies]]</code> — other marketplace mods</h2>
<table>
  <tr><th>Key</th><th>Required</th><th>Meaning</th></tr>
  <tr><td><code>id</code></td><td>Yes</td><td>The dependency's GitHub <code>owner/repo</code>.</td></tr>
  <tr><td><code>name</code></td><td>No</td><td>Display name.</td></tr>
  <tr><td><code>version</code></td><td>No</td><td>Version expression, e.g. <code>"*"</code>.</td></tr>
  <tr><td><code>optional</code></td><td>No (default <code>false</code>)</td><td>Marks a soft dependency.</td></tr>
</table>

<h2><code>[[requires_module]]</code> — stock DCS content</h2>
<p>Declares official DCS modules the user must own (distinct from mod dependencies). Shown as prerequisites on the product page.</p>
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
          lede: "Publishing is three guided steps — preflight, share to GitHub, cut a release — and needs nothing but a GitHub account. What makes your mod appear in the marketplace is precisely two things: the topic on the repo, and a manifest asset on the release.",
          body: `
<h2>Prerequisites (checked by preflight)</h2>
<p>The Publish panel runs a preflight and shows a checklist. It verifies:</p>
<ul>
  <li><code>dcs-studio.toml</code> exists at the workspace root, parses, and has a non-blank <code>project.name</code>;</li>
  <li>every <code>[[install]].source</code> exists on disk (build first!) and none is a symlink — the packager refuses symlinks;</li>
  <li><strong>7-Zip</strong> is installed (or set <code>dcsStudio.sevenZipPath</code>);</li>
  <li><strong>git</strong> is installed;</li>
  <li>the <strong>GitHub CLI</strong> (<code>gh</code>) is installed <em>and</em> signed in (<code>gh auth login</code>).</li>
</ul>

<h2>Step 1 — Share to GitHub</h2>
<p>One click turns the folder into a published repo:</p>
<ol>
  <li>Initializes git if needed (branch <code>main</code>) and adds <code>.dcs-studio/</code> to <code>.gitignore</code> (release artifacts stay out of the repo).</li>
  <li>Commits any pending changes and creates a <strong>public</strong> GitHub repository via <code>gh repo create</code> (or just pushes if <code>origin</code> already exists).</li>
  <li>Applies the <code>dcs-studio</code> topic — <strong>this is what makes the marketplace find your repo</strong>. Library packages also get <code>dcs-studio-library</code>.</li>
</ol>

<h2>Step 2 — Cut a release</h2>
<p>Enter a tag (your manifest <code>version</code> is suggested) and optional notes. DCS Studio then:</p>
<ol>
  <li>packs <code>dcs-studio.toml</code> + every install source into <code>dcs-studio-&lt;name&gt;-&lt;tag&gt;.7z</code> under <code>.dcs-studio/release/</code>, splitting into numbered volumes if it exceeds ~1.5&nbsp;GiB;</li>
  <li>uploads the payload <em>and</em> a standalone <code>dcs-studio.toml</code> as release assets;</li>
  <li>creates the git tag and GitHub release. Re-publishing the same tag first deletes the old release+tag, so cutting <code>1.0.0</code> twice is safe and idempotent.</li>
</ol>

<h2>What makes a mod "detected"</h2>
<table>
  <tr><th>You want</th><th>You need</th></tr>
  <tr><td>Appear in the marketplace grid</td><td>Public GitHub repo with the <code>dcs-studio</code> topic.</td></tr>
  <tr><td>A live <strong>Install</strong> button</td><td>The <em>latest</em> release must include a <code>dcs-studio.toml</code> asset (and the repo must not be a library).</td></tr>
  <tr><td>Tags/labels on your card</td><td>Add more GitHub topics — every extra topic becomes a filterable label.</td></tr>
  <tr><td>Users get updates</td><td>Cut a release with a new tag; <a data-page="updating-uninstalling">Update</a> follows your latest release.</td></tr>
</table>
<div class="note warn">
  <p>The marketplace always reads the <strong>latest</strong> release. If you cut a release without the manifest asset (e.g. by hand on github.com), your mod will show as not installable until the next proper release.</p>
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
  <li><strong>Mission</strong> — the mission scripting sandbox (<code>trigger.action</code>, <code>coalition</code>, <code>world</code>…). Needs a running mission and a <a data-page="mission-scripting">desanitized MissionScripting.lua</a>.</li>
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
<p>Everything live — the console, the debugger, the status indicators — talks to DCS through the bridge. It installs into your Saved Games write dir as <code>Mods\\tech\\DcsStudio\\bin\\dcs_studio.dll</code> plus <code>Scripts\\Hooks\\DcsStudio.lua</code>.</p>
<ul>
  <li><strong>Inject Bridge</strong> — copies both files into place. If the DLL is locked, DCS is running — close it first.</li>
  <li><strong>Launch DCS (with bridge)</strong> — injects, then starts <code>DCS.exe --no-launcher</code> from your configured install; when DCS exits the bridge is automatically ejected.</li>
  <li><strong>Eject Bridge</strong> — removes both files.</li>
  <li><strong>Build Bridge</strong> — for contributors: rebuilds the native crate with cargo; inject prefers a freshly built DLL over the shipped one.</li>
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
