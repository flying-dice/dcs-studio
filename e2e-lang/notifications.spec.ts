// E2E: the Notifications panel — a notification center for the transient IDE
// events that otherwise only flash, in the real app over CDP (model/studio/
// notifications.pds BadgeCountsUnseen, FailedBuildIsActionableError). The lab
// builds a fresh NotificationStore and drives the REAL classifiers + the real
// panel component, so the reverse-chronological render, the unread badge,
// mark-read-on-open, per-entry dismiss, and Clear all under test are the
// production ones — no Tauri, no DCS.

import { test, expect, labUrl } from "./_tauri";

test.beforeEach(async ({ page }) => {
  await page.goto(labUrl("notifications"));
  await expect(page.getByTestId("notifications-lab")).toBeVisible({ timeout: 30_000 });
});

test("an empty panel reads cleanly", async ({ page }) => {
  await page.getByTestId("toggle-panel").click();
  await expect(page.getByTestId("notifications-empty")).toContainText("No notifications");
  await expect(page.getByTestId("notifications-count")).toHaveText("0 notifications");
});

// Feature BadgeCountsUnseen: events arriving while the panel is closed raise
// the unread count; opening marks them read and clears it; an event arriving
// while the panel is open never re-raises it.
test("the unread count tracks unseen events and clears on open", async ({ page }) => {
  await page.getByTestId("add-build-fail").click();
  await page.getByTestId("add-link-drop").click();
  await expect(page.getByTestId("lab-unread")).toHaveText("2");
  await expect(page.getByTestId("lab-total")).toHaveText("2");

  // Opening the panel marks the backlog read.
  await page.getByTestId("toggle-panel").click();
  await expect(page.getByTestId("lab-unread")).toHaveText("0");

  // An event arriving while the panel is open stays read — no badge re-raise.
  await page.getByTestId("add-publish-share").click();
  await expect(page.getByTestId("lab-total")).toHaveText("3");
  await expect(page.getByTestId("lab-unread")).toHaveText("0");
});

// Feature FailedBuildIsActionableError: a failed build is an actionable error;
// a success/info entry is review-only. Entries render newest-first.
test("entries render newest-first; a failed build is actionable", async ({ page }) => {
  await page.getByTestId("add-build-fail").click();
  await page.getByTestId("add-publish-share").click();
  await page.getByTestId("toggle-panel").click();

  // Newest first: the publish share sits above the earlier build failure.
  await expect(page.getByTestId("notification-source")).toHaveText(["publish", "build"]);
  await expect(page.getByTestId("notification-message")).toHaveText([
    "Shared to octo/hornet-mod.",
    "Build failed (exit code 101).",
  ]);

  // The failed build navigates; the review-only share carries no action.
  const bodies = page.getByTestId("notification-body");
  await expect(bodies.nth(0)).not.toHaveAttribute("data-actionable", "true");
  await expect(bodies.nth(1)).toHaveAttribute("data-actionable", "true");
});

test("dismiss removes one entry; Clear all empties the list", async ({ page }) => {
  await page.getByTestId("add-build-fail").click();
  await page.getByTestId("add-link-drop").click();
  await page.getByTestId("toggle-panel").click();
  await expect(page.getByTestId("notification")).toHaveCount(2);

  // Dismiss the newest entry → one remains.
  await page.getByTestId("notification-dismiss").first().click();
  await expect(page.getByTestId("notification")).toHaveCount(1);
  await expect(page.getByTestId("lab-total")).toHaveText("1");

  // Clear all empties the list and restores the empty state.
  await page.getByTestId("notifications-clear").click();
  await expect(page.getByTestId("notification")).toHaveCount(0);
  await expect(page.getByTestId("notifications-empty")).toBeVisible();
});
