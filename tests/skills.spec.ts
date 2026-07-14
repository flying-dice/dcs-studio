import { test, expect } from "@playwright/test";
import { openPreview, expectSent, hostSend } from "./helpers";

test.describe("skills preview", () => {
  test("renders one card per status with correct pill + version text", async ({ page }) => {
    await openPreview(page, "skills");
    await expect(page.getByTestId("skill-card")).toHaveCount(4);

    const notInstalled = page.locator('[data-testid="skill-card"][data-id="dcs-studio"]');
    await expect(notInstalled.getByTestId("status-pill")).toHaveText("Not installed");
    await expect(notInstalled.getByTestId("version-line")).toHaveText("v1.0.0");

    const outdated = page.locator('[data-testid="skill-card"][data-id="dcs-studio-2"]');
    await expect(outdated.getByTestId("status-pill")).toHaveText("Update available");
    await expect(outdated.getByTestId("version-line")).toHaveText("installed v1.0.0 → bundled v1.2.0");

    const upToDate = page.locator('[data-testid="skill-card"][data-id="dcs-studio-3"]');
    await expect(upToDate.getByTestId("status-pill")).toHaveText("Installed · up to date");
    await expect(upToDate.getByTestId("version-line")).toHaveText("installed v1.0.0");

    const modified = page.locator('[data-testid="skill-card"][data-id="dcs-studio-4"]');
    await expect(modified.getByTestId("status-pill")).toHaveText("Installed · locally modified");
    await expect(modified.getByTestId("version-line")).toHaveText("installed v1.0.0");
  });

  test("install-btn label changes per status (install / update / reset)", async ({ page }) => {
    await openPreview(page, "skills");

    const notInstalled = page.locator('[data-testid="skill-card"][data-id="dcs-studio"]');
    await expect(notInstalled.getByTestId("install-btn")).toHaveText("Install into repo");

    const outdated = page.locator('[data-testid="skill-card"][data-id="dcs-studio-2"]');
    await expect(outdated.getByTestId("install-btn")).toHaveText("Update to v1.2.0");

    const modified = page.locator('[data-testid="skill-card"][data-id="dcs-studio-4"]');
    await expect(modified.getByTestId("install-btn")).toHaveText("Reset to bundled");

    // up-to-date has nothing left to install/update/reset.
    const upToDate = page.locator('[data-testid="skill-card"][data-id="dcs-studio-3"]');
    await expect(upToDate.getByTestId("install-btn")).toHaveCount(0);
  });

  test("install-btn posts {type: install, id}", async ({ page }) => {
    await openPreview(page, "skills");
    const notInstalled = page.locator('[data-testid="skill-card"][data-id="dcs-studio"]');
    await notInstalled.getByTestId("install-btn").click();
    await expectSent(page, { type: "install", id: "dcs-studio" });
  });

  test("remove-btn posts {type: remove, id}", async ({ page }) => {
    await openPreview(page, "skills");
    const outdated = page.locator('[data-testid="skill-card"][data-id="dcs-studio-2"]');
    await outdated.getByTestId("remove-btn").click();
    await expectSent(page, { type: "remove", id: "dcs-studio-2" });
  });

  test("hasWorkspace:false shows no-workspace-note", async ({ page }) => {
    await openPreview(page, "skills");
    await hostSend(page, {
      type: "skills",
      installDir: ".claude/skills",
      hasWorkspace: false,
      skills: [{ id: "s1", name: "s1", description: "d", bundledVersion: "1.0.0", status: "not-installed" }],
    });
    await expect(page.getByTestId("no-workspace-note")).toBeVisible();
    await expect(page.getByTestId("empty-note")).toHaveCount(0);
  });

  test("empty skills list shows empty-note", async ({ page }) => {
    await openPreview(page, "skills");
    await hostSend(page, { type: "skills", installDir: ".claude/skills", hasWorkspace: true, skills: [] });
    await expect(page.getByTestId("empty-note")).toBeVisible();
    await expect(page.getByTestId("skill-card")).toHaveCount(0);
  });
});
