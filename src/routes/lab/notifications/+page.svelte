<script lang="ts">
  // Browser test surface for the Notifications panel (issue #56): a fresh
  // NotificationStore driven by buttons that call the REAL classifiers +
  // add()/dismiss()/clear(), with the real Notifications component mounted
  // behind a toggle. The toggle lets the e2e raise the unread count with the
  // panel closed, then open it and watch the count clear (the read/unread race
  // in model/studio/notifications.pds BadgeCountsUnseen) — no Tauri, no DCS.
  import Notifications from "$lib/components/Notifications.svelte";
  import { NotificationStore } from "$lib/notifications.svelte";
  import {
    classifyBuildDone,
    dcsDisconnectedNotification,
    publishSharedNotification,
  } from "$lib/notifications-classify";

  const store = new NotificationStore();

  // The panel mounts only while "open", so the badge count can be raised with
  // it closed, then cleared by opening (NotificationStore.setOpen marks read).
  let panelOpen = $state(false);

  function addBuildFail() {
    // The real classification: a failed build is an actionable error.
    const note = classifyBuildDone({ succeeded: false, exit_code: 101, no_op: false });
    if (note) store.add(note);
  }

  function addLinkDrop() {
    store.add(dcsDisconnectedNotification());
  }

  function addPublishShare() {
    store.add(publishSharedNotification("octo/hornet-mod"));
  }
</script>

<div class="flex h-screen flex-col gap-2 p-3" data-testid="notifications-lab">
  <div class="text-xs text-muted-foreground" data-testid="lab-status">
    unread: <span data-testid="lab-unread">{store.unreadCount}</span> · total:
    <span data-testid="lab-total">{store.entries.length}</span>
  </div>
  <div class="flex flex-wrap items-center gap-2 text-xs">
    <button class="rounded border px-2 py-0.5" data-testid="add-build-fail" onclick={addBuildFail}>
      add build-fail
    </button>
    <button class="rounded border px-2 py-0.5" data-testid="add-link-drop" onclick={addLinkDrop}>
      add link-drop
    </button>
    <button
      class="rounded border px-2 py-0.5"
      data-testid="add-publish-share"
      onclick={addPublishShare}
    >
      add publish-share
    </button>
    <button
      class="rounded border px-2 py-0.5"
      data-testid="toggle-panel"
      onclick={() => (panelOpen = !panelOpen)}
    >
      {panelOpen ? "close panel" : "open panel"}
    </button>
  </div>
  <div class="h-72 w-80 shrink-0 overflow-hidden rounded border">
    {#if panelOpen}
      <Notifications {store} />
    {/if}
  </div>
</div>
