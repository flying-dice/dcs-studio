<script lang="ts">
  import { app } from "$lib/state.svelte";
  import { build } from "$lib/build.svelte";
  import { installer } from "$lib/install.svelte";
  import { EDITOR_THEMES, editorThemeById } from "$lib/themes";
  import { fileIconFor } from "$lib/file-icons";
  import FileIcon from "$lib/components/FileIcon.svelte";
  import FileTree from "$lib/components/FileTree.svelte";
  import BuildOutput from "$lib/components/BuildOutput.svelte";
  import InjectionManager from "$lib/components/InjectionManager.svelte";
  import PackagesManager from "$lib/components/PackagesManager.svelte";
  import PublishManager from "$lib/components/PublishManager.svelte";
  import LuaConsole from "$lib/components/LuaConsole.svelte";
  import Repl from "$lib/components/Repl.svelte";
  import LogViewer from "$lib/components/LogViewer.svelte";
  import MissionScriptingManager from "$lib/components/MissionScriptingManager.svelte";
  import Problems from "$lib/components/Problems.svelte";
  import ProblemChips from "$lib/components/ProblemChips.svelte";
  import Terminal from "$lib/components/Terminal.svelte";
  import Structure from "$lib/components/Structure.svelte";
  import Todos from "$lib/components/Todos.svelte";
  import Usages from "$lib/components/Usages.svelte";
  import Editor from "$lib/components/Editor.svelte";
  import EditorTabs from "$lib/components/EditorTabs.svelte";
  import Welcome from "$lib/components/Welcome.svelte";
  import GithubAuth from "$lib/components/GithubAuth.svelte";
  import McpHelpModal from "$lib/components/McpHelpModal.svelte";
  import PanelResizeHandle from "$lib/components/PanelResizeHandle.svelte";
  import { lang } from "$lib/lang/intel.svelte";
  import { mcp } from "$lib/mcp.svelte";
  import { runFile, runViewInDcs } from "$lib/lua-console.svelte";
  import { editorViewFor } from "$lib/lang/codemirror";
  import { cn } from "$lib/utils.js";

  import { Button } from "$lib/components/ui/button/index.js";
  import { Card } from "$lib/components/ui/card/index.js";
  import { ScrollArea } from "$lib/components/ui/scroll-area/index.js";
  import { Separator } from "$lib/components/ui/separator/index.js";
  import * as Tooltip from "$lib/components/ui/tooltip/index.js";
  import * as Menubar from "$lib/components/ui/menubar/index.js";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu/index.js";

  import {
    FolderTree,
    ListTree,
    Bookmark,
    Database,
    Bell,
    Sparkles,
    SquareTerminal,
    TriangleAlert,
    ListTodo,
    ScrollText,
    FolderOpen,
    Boxes,
    Sun,
    Moon,
    Search,
    Hammer,
    PackageCheck,
    PackageMinus,
    Play,
    SquareChevronRight,
    Bug,
    Settings,
    Palette,
    Syringe,
    ShieldOff,
    Rocket,
    FileCode,
    FileClock,
    LoaderCircle,
    type LucideIcon,
  } from "@lucide/svelte";
  import { onMount } from "svelte";

  // Setup-help modal for the IDE-hosted MCP server (issue #39).
  let mcpHelpOpen = $state(false);

  // Read the cached GitHub session first (for the header chip), then open the project
  // the app was launched with (`--open <path>`), if any.
  onMount(() => {
    void (async () => {
      await app.loadSession();
      await app.openStartupProject();
    })();
  });

  const darkThemes = EDITOR_THEMES.filter((t) => t.dark);
  const lightThemes = EDITOR_THEMES.filter((t) => !t.dark);
  const editorThemeLabel = $derived(editorThemeById(app.editorThemeId).label);

  type Tool = { id: string; label: string; icon: LucideIcon };

  // Each register drives one island. Only "project" is wired to real behaviour;
  // the rest pop open a labelled placeholder island for now.
  const leftTools: Tool[] = [
    { id: "project", label: "Project", icon: FolderTree },
    { id: "bookmarks", label: "Bookmarks", icon: Bookmark },
  ];
  const rightTools: Tool[] = [
    { id: "structure", label: "Structure", icon: ListTree },
    { id: "inject", label: "Inject", icon: Syringe },
    { id: "packages", label: "Packages", icon: Boxes },
    { id: "publish", label: "Publish", icon: Rocket },
    { id: "mission", label: "Mission", icon: ShieldOff },
    { id: "repl", label: "REPL", icon: SquareChevronRight },
    { id: "database", label: "Database", icon: Database },
    { id: "notifications", label: "Notifications", icon: Bell },
    { id: "ai", label: "Assistant", icon: Sparkles },
  ];
  const bottomTools: Tool[] = [
    { id: "lua", label: "Console", icon: FileCode },
    { id: "terminal", label: "Terminal", icon: SquareTerminal },
    { id: "problems", label: "Problems", icon: TriangleAlert },
    { id: "usages", label: "Usages", icon: Search },
    { id: "todos", label: "Todos", icon: ListTodo },
    { id: "output", label: "Output", icon: ScrollText },
    { id: "dcslog", label: "DCS Log", icon: FileClock },
  ];

  const labelFor = (list: Tool[], id: string | null) =>
    list.find((t) => t.id === id)?.label ?? "";

  const providerShortLabel: Record<string, string> = {
    "dcs-lua": "Lua",
    "rust-analyzer": "Rust",
  };
  function providerLabel(id: string): string {
    return providerShortLabel[id] ?? id;
  }
  function providerStatusTitle(id: string, pStatus: string): string {
    const label = providerLabel(id);
    const progress = lang.providerProgress[id];
    if (pStatus === "ready" && progress) return `${label}: ${progress}`;
    if (pStatus === "ready") return `${label}: running`;
    if (pStatus === "loading") return `${label}: starting…`;
    if (pStatus === "disabled") return `${label}: binary not found — run: rustup component add rust-analyzer`;
    if (pStatus === "failed") return `${label}: crashed`;
    return `${label}: off`;
  }

  // Top-left application menu. Items with an `action` are wired; the rest are
  // representative placeholders. View items toggle the panel islands.
  type MenuItem = { label?: string; shortcut?: string; action?: () => void; sep?: boolean };
  type MenuDef = { label: string; items: MenuItem[] };
  const MENUS: MenuDef[] = [
    {
      label: "File",
      items: [
        { label: "New Project…", action: () => void app.closeProject() },
        { label: "Open Project…", shortcut: "⌘O", action: () => app.openFolder() },
        { sep: true },
        { label: "New File", shortcut: "⌘N" },
        { label: "Save", shortcut: "⌘S", action: () => app.saveFile() },
        { sep: true },
        { label: "Close Editor", action: () => app.closeActiveFile() },
        { label: "Close Project", action: () => void app.closeProject() },
      ],
    },
    {
      label: "Edit",
      items: [
        { label: "Undo", shortcut: "⌘Z" },
        { label: "Redo", shortcut: "⇧⌘Z" },
        { sep: true },
        { label: "Cut", shortcut: "⌘X" },
        { label: "Copy", shortcut: "⌘C" },
        { label: "Paste", shortcut: "⌘V" },
      ],
    },
    {
      label: "View",
      items: [
        { label: "Project", action: () => app.toggleTool("left", "project") },
        { label: "Database", action: () => app.toggleTool("right", "database") },
        { label: "Terminal", action: () => app.toggleTool("bottom", "terminal") },
      ],
    },
    {
      label: "Run",
      items: [
        { label: "Run", shortcut: "⇧F10" },
        { label: "Debug", shortcut: "⇧F9" },
        { label: "Build Project", shortcut: "⌘F9" },
      ],
    },
    { label: "Help", items: [{ label: "About DCS Studio" }] },
  ];

  // Top-right IDE controls (placeholder, no actions wired yet).
  const controls: { icon: LucideIcon; label: string }[] = [
    { icon: Play, label: "Run" },
    { icon: Bug, label: "Debug" },
  ];

  function openOutput() {
    app.bottomTool = "output";
  }

  // Global Save shortcut — works regardless of editor focus.
  function onKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      app.saveFile();
    }
  }
</script>

<!-- A navigation cluster of panel toggles. Rendered as a vertical rail flanking
     the islands (left/right edges) or a horizontal row (footer). The active
     button borrows the island surface (bg-card + ring + shadow) so it reads as
     physically tethered to its panel. -->
{#snippet toggles(
  list: Tool[],
  active: string | null,
  toggle: (id: string) => void,
  vertical: boolean,
  side: "top" | "bottom" | "left" | "right",
)}
  <div class={cn("flex gap-1", vertical ? "flex-col items-center" : "items-center")}>
    {#each list as t (t.id)}
      {@const Icon = t.icon}
      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              variant="ghost"
              size="icon-sm"
              aria-pressed={active === t.id}
              onclick={() => toggle(t.id)}
              class={cn(
                "text-muted-foreground hover:text-foreground",
                active === t.id &&
                  "bg-card text-primary ring-1 ring-foreground/10 shadow-sm hover:bg-card hover:text-primary",
              )}
            >
              <Icon />
            </Button>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content {side} class="font-mono text-[11px] tracking-wide">
          {t.label}
        </Tooltip.Content>
      </Tooltip.Root>
    {/each}
  </div>
{/snippet}

{#snippet islandHead(title: string)}
  <div class="flex h-9 shrink-0 items-center justify-between gap-2 px-3">
    <span
      class="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"
      >{title}</span
    >
  </div>
{/snippet}

{#snippet placeholder(label: string)}
  <ScrollArea class="h-full">
    <div class="flex h-full min-h-[120px] flex-col items-center justify-center gap-1 p-6 text-center">
      <span class="text-sm text-foreground/80">{label}</span>
      <span class="text-[11px] tracking-wide text-muted-foreground">coming soon</span>
    </div>
  </ScrollArea>
{/snippet}

<!-- A top-right toolbar control: icon button with a tooltip. -->
{#snippet actionBtn(
  Icon: LucideIcon,
  label: string,
  onclick: () => void,
  disabled: boolean,
  loading: boolean,
)}
  <Tooltip.Root>
    <Tooltip.Trigger>
      {#snippet child({ props })}
        <Button
          {...props}
          variant="ghost"
          size="icon-sm"
          class="text-muted-foreground hover:text-foreground"
          aria-label={label}
          {onclick}
          {disabled}
        >
          {#if loading}<LoaderCircle class="animate-spin" />{:else}<Icon />{/if}
        </Button>
      {/snippet}
    </Tooltip.Trigger>
    <Tooltip.Content side="bottom" class="font-mono text-[11px] tracking-wide">
      {label}
    </Tooltip.Content>
  </Tooltip.Root>
{/snippet}

{#snippet headerBtn(Icon: LucideIcon, label: string)}
  <Tooltip.Root>
    <Tooltip.Trigger>
      {#snippet child({ props })}
        <Button
          {...props}
          variant="ghost"
          size="icon-sm"
          class="text-muted-foreground hover:text-foreground"
          aria-label={label}
        >
          <Icon />
        </Button>
      {/snippet}
    </Tooltip.Trigger>
    <Tooltip.Content side="bottom" class="font-mono text-[11px] tracking-wide">
      {label}
    </Tooltip.Content>
  </Tooltip.Root>
{/snippet}

<svelte:window onkeydown={onKeydown} />

{#if !app.rootPath}
  <Welcome />
{:else}
<Tooltip.Provider delayDuration={250}>
  <div class="flex h-screen flex-col bg-background text-foreground">
    <!-- ── APP MENU ── bare on the canvas ── -->
    <header class="flex h-11 shrink-0 select-none items-center gap-1 px-2">
      <!-- Brand -->
      <div class="flex items-center px-1.5">
        <Boxes class="size-4 text-foreground" />
      </div>

      <!-- Application menu (File / Edit / View / Run / Help) -->
      <Menubar.Root class="h-auto gap-0 border-0 bg-transparent p-0 shadow-none">
        {#each MENUS as menu (menu.label)}
          <Menubar.Menu>
            <Menubar.Trigger class="px-2 py-1 font-normal text-foreground/80">
              {menu.label}
            </Menubar.Trigger>
            <Menubar.Content align="start" class="min-w-48">
              {#each menu.items as item, i (i)}
                {#if item.sep}
                  <Menubar.Separator />
                {:else}
                  <Menubar.Item onclick={item.action}>
                    {item.label}
                    {#if item.shortcut}<Menubar.Shortcut>{item.shortcut}</Menubar.Shortcut>{/if}
                  </Menubar.Item>
                {/if}
              {/each}
            </Menubar.Content>
          </Menubar.Menu>
        {/each}
      </Menubar.Root>

      <!-- Center breadcrumb -->
      <div class="flex min-w-0 flex-1 items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
        {#if app.fileName}
          <span class="truncate">{app.rootName || "workspace"}</span>
          <span class="opacity-40">/</span>
          <FileIcon name={fileIconFor(app.fileName)} class="size-3.5" />
          <span class="truncate text-foreground">{app.fileName}</span>
        {/if}
      </div>

      <!-- Top-right controls: Search · Build/Install/Uninstall · Run/Debug · Quick settings -->
      <div class="flex items-center gap-0.5">
        {@render headerBtn(Search, "Search")}
        <Separator orientation="vertical" class="mx-1 !h-4" />
        {@render actionBtn(
          Hammer, "Build",
          () => { if (app.rootPath) { void build.start(app.rootPath); openOutput(); } },
          build.running || !app.rootPath,
          build.running,
        )}
        {@render actionBtn(
          PackageCheck, "Install",
          () => { if (app.rootPath) { void installer.install(app.rootPath); openOutput(); } },
          installer.installing || !app.rootPath,
          installer.installing,
        )}
        {@render actionBtn(
          PackageMinus, "Uninstall",
          () => { if (app.rootPath) { void installer.uninstall(app.rootPath); openOutput(); } },
          installer.uninstalling || !app.rootPath || !installer.status?.installed,
          installer.uninstalling,
        )}
        <Separator orientation="vertical" class="mx-1 !h-4" />
        {#each controls as c (c.label)}
          {@render headerBtn(c.icon, c.label)}
        {/each}
        <Separator orientation="vertical" class="mx-1 !h-4" />

        <GithubAuth />
        <Separator orientation="vertical" class="mx-1 !h-4" />

        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            {#snippet child({ props })}
              <Button
                {...props}
                variant="ghost"
                size="icon-sm"
                class="text-muted-foreground hover:text-foreground"
                aria-label="Quick settings"
              >
                <Settings />
              </Button>
            {/snippet}
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="end" class="min-w-52">
            <DropdownMenu.Label>Quick settings</DropdownMenu.Label>
            <DropdownMenu.Separator />
            <DropdownMenu.CheckboxItem
              checked={app.dark}
              onCheckedChange={() => app.toggleMode()}
            >
              {#if app.dark}<Moon />{:else}<Sun />{/if}
              Dark mode
            </DropdownMenu.CheckboxItem>

            <DropdownMenu.CheckboxItem
              checked={app.formatOnSave}
              onCheckedChange={(v) => app.setFormatOnSave(v)}
            >
              <Sparkles />
              Format on save
            </DropdownMenu.CheckboxItem>

            <DropdownMenu.Sub>
              <DropdownMenu.SubTrigger>
                <Palette />
                Editor theme
                <span class="ml-auto pl-3 text-xs text-muted-foreground">{editorThemeLabel}</span>
              </DropdownMenu.SubTrigger>
              <DropdownMenu.SubContent class="min-w-44">
                <DropdownMenu.RadioGroup
                  value={app.editorThemeId}
                  onValueChange={(v) => app.setEditorTheme(v)}
                >
                  <DropdownMenu.Label class="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    Dark
                  </DropdownMenu.Label>
                  {#each darkThemes as t (t.id)}
                    <DropdownMenu.RadioItem value={t.id}>{t.label}</DropdownMenu.RadioItem>
                  {/each}
                  <DropdownMenu.Separator />
                  <DropdownMenu.Label class="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    Light
                  </DropdownMenu.Label>
                  {#each lightThemes as t (t.id)}
                    <DropdownMenu.RadioItem value={t.id}>{t.label}</DropdownMenu.RadioItem>
                  {/each}
                </DropdownMenu.RadioGroup>
              </DropdownMenu.SubContent>
            </DropdownMenu.Sub>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </div>
    </header>

    <!-- ── WORKSPACE ── islands float on the canvas, nav rails flank them ── -->
    <main class="flex min-h-0 flex-1 gap-2 px-2 pb-2">
      <!-- LEFT STRIPE: full height. Panel tools at the top, bottom-window tools
           anchored at the bottom (JetBrains-style) so toggling the bottom panel
           never resizes the top row. -->
      <nav class="flex shrink-0 flex-col items-center justify-between">
        {@render toggles(leftTools, app.leftTool, (id) => app.toggleTool("left", id), true, "right")}
        {@render toggles(bottomTools, app.bottomTool, (id) => app.toggleTool("bottom", id), true, "right")}
      </nav>

      <!-- CONTENT COLUMN: top row of islands + optional bottom island -->
      <div class="flex min-h-0 min-w-0 flex-1 flex-col">
        <div class="flex min-h-0 flex-1">
        {#if app.leftTool}
          <Card class="flex h-full min-h-0 shrink-0 flex-col gap-0 rounded-xl py-0" style="width: {app.leftPanelWidth}px">
            <div class="flex h-9 shrink-0 items-center justify-between gap-2 px-3">
              <span class="truncate font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {app.leftTool === "project"
                  ? app.rootName || "Project"
                  : labelFor(leftTools, app.leftTool)}
              </span>
              {#if app.leftTool === "project"}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  class="text-muted-foreground hover:text-foreground"
                  title="Open Folder"
                  onclick={() => app.openFolder()}
                >
                  <FolderOpen />
                </Button>
              {/if}
            </div>
            <div class="min-h-0 flex-1">
              {#if app.leftTool === "project"}
                <ScrollArea class="h-full">
                  <FileTree />
                </ScrollArea>
              {:else}
                {@render placeholder(labelFor(leftTools, app.leftTool))}
              {/if}
            </div>
          </Card>
        {/if}
        {#if app.leftTool}
          <PanelResizeHandle side="left" currentSize={app.leftPanelWidth}
            onresize={(w) => app.setPanelSize("left", w)} />
        {/if}

        <!-- CENTER island: tab strip as the head, editor as the body. -->
        <Card class="flex h-full min-h-0 min-w-0 flex-1 flex-col gap-0 rounded-xl py-0">
          <div
            role="tablist"
            aria-label="Open files"
            class="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-border/60 px-2"
          >
            <EditorTabs />
            {#if app.filePath}
              <Button
                variant="ghost"
                size="icon-sm"
                class="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
                title="Run in DCS (Ctrl+Enter)"
                aria-label="Run in DCS"
                data-testid="editor-run-in-dcs"
                onclick={() => {
                  const p = app.filePath;
                  if (!p) return;
                  // Same gesture as the editor's Ctrl+Enter: selection, else the
                  // whole file. A live editor view carries the selection; a
                  // binary tab has none, so run its content (surfacing a read
                  // failure rather than dropping it, like the file-tree action).
                  const view = editorViewFor(p);
                  if (view) runViewInDcs(view);
                  else void runFile(p).catch((e) => console.error("Run in DCS failed:", e));
                }}
              >
                <Play />
              </Button>
            {/if}
          </div>
          <div class="min-h-0 flex-1">
            {#if app.filePath}
              <Editor />
            {:else}
              <div class="flex h-full flex-col items-center justify-center gap-2.5 px-10 text-center">
                <Boxes class="size-8 text-primary/85" />
                <h1 class="text-lg font-semibold tracking-tight">{app.rootName || "DCS Studio"}</h1>
                <p class="max-w-xs text-sm text-muted-foreground">
                  Pick a file from the project tree to start editing.
                </p>
              </div>
            {/if}
          </div>
        </Card>

        {#if app.rightTool}
          <PanelResizeHandle side="right" currentSize={app.rightPanelWidth}
            onresize={(w) => app.setPanelSize("right", w)} />
          <Card class="flex h-full min-h-0 shrink-0 flex-col gap-0 rounded-xl py-0" style="width: {app.rightPanelWidth}px">
            {@render islandHead(labelFor(rightTools, app.rightTool))}
            <div class="min-h-0 flex-1">
              {#if app.rightTool === "inject"}
                <InjectionManager />
              {:else if app.rightTool === "packages"}
                <PackagesManager />
              {:else if app.rightTool === "publish"}
                <PublishManager />
              {:else if app.rightTool === "mission"}
                <MissionScriptingManager />
              {:else if app.rightTool === "repl"}
                <Repl />
              {:else if app.rightTool === "structure"}
                <ScrollArea class="h-full">
                  <Structure path={app.filePath} />
                </ScrollArea>
              {:else}
                {@render placeholder(labelFor(rightTools, app.rightTool))}
              {/if}
            </div>
          </Card>
        {/if}
        </div>

        <!-- BOTTOM PANEL island spans the content column, so its left/right
             edges line up with the top row's panels automatically. -->
        {#if app.bottomTool}
          <PanelResizeHandle side="bottom" currentSize={app.bottomPanelHeight}
            onresize={(h) => app.setPanelSize("bottom", h)} />
          <Card class="flex shrink-0 flex-col gap-0 rounded-xl py-0" style="height: {app.bottomPanelHeight}px">
            {@render islandHead(labelFor(bottomTools, app.bottomTool))}
            <div class="min-h-0 flex-1">
              {#if app.bottomTool === "lua"}
                <LuaConsole />
              {:else if app.bottomTool === "problems"}
                <Problems />
              {:else if app.bottomTool === "usages"}
                <Usages />
              {:else if app.bottomTool === "todos"}
                <Todos />
              {:else if app.bottomTool === "output"}
                <BuildOutput />
              {:else if app.bottomTool === "terminal"}
                <Terminal />
              {:else if app.bottomTool === "dcslog"}
                <LogViewer />
              {:else}
                {@render placeholder(labelFor(bottomTools, app.bottomTool))}
              {/if}
            </div>
          </Card>
        {/if}
      </div>

      <!-- RIGHT STRIPE: full height, panel tools at the top. -->
      <nav class="flex shrink-0 flex-col items-center">
        {@render toggles(rightTools, app.rightTool, (id) => app.toggleTool("right", id), true, "left")}
      </nav>
    </main>

    <!-- ── APP FOOTER ── bare on the canvas ── -->
    <footer class="flex h-8 shrink-0 select-none items-center gap-2.5 px-3 text-[11px]">
      <div class="flex min-w-0 flex-1 items-center gap-2">
        <span class="truncate font-mono text-[11px] text-muted-foreground">
          {app.filePath ?? "Ready"}
        </span>
        {#if app.dirty}
          <span class="shrink-0 font-mono text-[11px] text-primary">● {app.saving ? "saving…" : "modified"}</span>
        {/if}
      </div>
      <!-- Per-provider language intelligence status chips. Only providers
           that are not "off" or "not-applicable" get a chip — "not-applicable"
           means the provider has nothing to do (e.g. no Cargo.toml), which is
           expected and not worth surfacing. "disabled" means applicable but
           broken (binary not found) — shown amber so it's actionable. -->
      {#each Object.entries(lang.providerStatuses).filter(([, s]) => s !== "off" && s !== "not-applicable") as [id, pStatus]}
        {@const busy = Boolean(lang.providerProgress[id])}
        <span
          class="flex shrink-0 items-center gap-1 font-mono text-[11px] tracking-wide text-muted-foreground"
          data-testid="provider-status-{id}"
          title={providerStatusTitle(id, pStatus)}
        >
          <span
            class={cn(
              "size-1.5 rounded-full",
              pStatus === "ready" && !busy && "bg-emerald-500",
              pStatus === "ready" && busy && "animate-pulse bg-amber-400",
              (pStatus === "loading") && "animate-pulse bg-amber-500",
              pStatus === "disabled" && "bg-amber-500",
              pStatus === "failed" && "bg-red-500",
            )}
          ></span>
          {providerLabel(id)}
        </span>
      {/each}
      <!-- Fallback while no project is open (no provider has mounted yet). -->
      {#if Object.keys(lang.providerStatuses).length === 0}
        <span
          class="flex shrink-0 items-center gap-1.5 font-mono text-[11px] tracking-wide text-muted-foreground"
          data-testid="engine-status"
        >
          <span
            class={cn(
              "size-1.5 rounded-full",
              lang.engineStatus === "loading" && "bg-amber-500",
              lang.engineStatus === "failed" && "bg-red-500",
              (lang.engineStatus === "off" || lang.engineStatus === "ready") && "bg-muted-foreground/40",
            )}
          ></span>
          {lang.engineStatus === "off" ? "No project" : lang.engineStatus}
        </span>
      {/if}
      <!-- Problem count chips: click opens the Problems panel
           (model StatusBarCountsOpenProblems). -->
      <ProblemChips
        onOpen={() => {
          if (app.bottomTool !== "problems") app.toggleTool("bottom", "problems");
        }}
      />
      <Separator orientation="vertical" class="!h-3" />
      <!-- DCS link: dot = WS liveness (green = mission running, amber = in menu). -->
      <span class="flex shrink-0 items-center gap-1.5 font-mono text-[11px] tracking-wide text-muted-foreground">
        <span
          class={cn(
            "size-1.5 rounded-full",
            !app.dcsConnected && "bg-muted-foreground/40",
            app.dcsConnected && (app.dcsSimRunning ? "bg-emerald-500" : "bg-amber-500"),
          )}
        ></span>
        {#if !app.dcsConnected}
          DCS: offline
        {:else if app.dcsSimRunning}
          DCS: connected{#if app.dcsTime != null}&nbsp;· sim {app.dcsTime.toFixed(1)}s{/if}{#if app.dcsLatencyMs != null}&nbsp;· {app.dcsLatencyMs}ms{/if}
        {:else}
          DCS: connected · in menu{#if app.dcsLatencyMs != null}&nbsp;· {app.dcsLatencyMs}ms{/if}
        {/if}
      </span>
      <Separator orientation="vertical" class="!h-3" />
      <!-- MCP server: click opens setup help for wiring an editor (issue #39).
           dot = green serving, red bind error, grey not started yet. -->
      <button
        class="flex shrink-0 items-center gap-1.5 font-mono text-[11px] tracking-wide text-muted-foreground hover:text-foreground"
        data-testid="mcp-status"
        title={mcp.running
          ? `MCP server: ${mcp.url} — click for editor setup`
          : (mcp.error ?? "MCP server not started") + " — click for setup"}
        onclick={() => (mcpHelpOpen = true)}
      >
        <span
          class={cn(
            "size-1.5 rounded-full",
            mcp.running && "bg-emerald-500",
            !mcp.running && mcp.error && "bg-red-500",
            !mcp.running && !mcp.error && "bg-muted-foreground/40",
          )}
        ></span>
        {#if mcp.running}
          MCP :{mcp.port}
        {:else if mcp.error}
          MCP: error
        {:else}
          MCP: off
        {/if}
      </button>
      <Separator orientation="vertical" class="!h-3" />
      <span class="flex items-center gap-1.5 font-mono text-[11px] tracking-wide text-muted-foreground">
        {#if app.dark}<Moon class="size-3" />{:else}<Sun class="size-3" />{/if}
        {editorThemeLabel}
      </span>
    </footer>
  </div>
  <McpHelpModal open={mcpHelpOpen} onClose={() => (mcpHelpOpen = false)} />
</Tooltip.Provider>
{/if}
