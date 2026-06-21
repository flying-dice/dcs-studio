<script lang="ts">
  // Inline "new file/folder" input shared by the per-node menu (TreeNode) and
  // the root/empty-space menu (FileTree). The owning state — `creating`,
  // `createValue`, and the commit target — stays in each parent because the
  // create destination differs (a node's targetDir vs the workspace root); this
  // component owns only the input element and its commit/cancel keying.
  import { app } from "$lib/state.svelte";
  import { untrack } from "svelte";

  let {
    kind,
    value = $bindable(""),
    paddingLeft,
    oncommit,
    oncancel,
  }: {
    kind: "file" | "folder";
    value: string;
    paddingLeft: number;
    oncommit: () => void;
    oncancel: () => void;
  } = $props();

  let el = $state<HTMLInputElement | null>(null);

  /** Focus and select an input the moment it mounts (inline edit UX). */
  function autofocus(node: HTMLInputElement) {
    node.focus();
    node.select();
  }

  // The box deliberately does NOT commit on blur. It is blurred
  // *programmatically* all the time — bits-ui's context-menu focus scope
  // releases focus on close, the SWR poll re-renders the tree under it, and the
  // surrounding IDE steals focus when it pleases — and a blur-commit would tear
  // the box down before the user can type (the "namebox appears then vanishes"
  // bug). Instead we commit on Enter and on a genuine outside pointer press,
  // both of which are real user intent and immune to programmatic focus moves.
  // While the box is open we also suspend the SWR poll so the tree holds still.
  $effect(() => {
    untrack(() => app.beginTreeEdit());
    const onPointerDown = (e: PointerEvent) => {
      if (el && !el.contains(e.target as Node)) oncommit();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      app.endTreeEdit();
    };
  });
</script>

<!-- svelte-ignore a11y_autofocus -->
<input
  bind:this={el}
  class="h-[22px] w-full rounded-md border border-primary/50 bg-input px-1 text-[13px] outline-none"
  style="padding-left: {paddingLeft}px"
  data-testid="tree-create-input"
  placeholder={kind === "file" ? "filename" : "folder name"}
  bind:value
  use:autofocus
  onkeydown={(e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      oncommit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      oncancel();
    }
  }}
/>
