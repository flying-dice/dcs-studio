import { test, expect } from "@playwright/test";
import { openPreview, expectSent, hostSend } from "./helpers";

test.describe("nav preview", () => {
  test("renders all 9 rows, publish hidden by default", async ({ page }) => {
    await openPreview(page, "nav");
    await expect(page.getByTestId("nav-item")).toHaveCount(9);
    await expect(page.locator('[data-testid="nav-item"][data-id="publish"]')).toHaveClass(/hidden/);
  });

  test("clicking a row posts {type: run, command} and activates the row", async ({ page }) => {
    await openPreview(page, "nav");
    const browse = page.locator('[data-testid="nav-item"][data-id="browse"]');
    await browse.click();
    await expectSent(page, { type: "run", command: "dcs.marketplace.open" });
    await expect(browse).toHaveClass(/active/);
  });

  test("manifest hasManifest toggles Edit-Project label + publish visibility", async ({ page }) => {
    await openPreview(page, "nav");
    const create = page.locator('[data-testid="nav-item"][data-id="create"]');
    const publish = page.locator('[data-testid="nav-item"][data-id="publish"]');
    await expect(create.locator(".label")).toHaveText("Create a Mod");
    await expect(publish).toHaveClass(/hidden/);

    await hostSend(page, { type: "manifest", hasManifest: true });
    await expect(create.locator(".label")).toHaveText("Edit Project");
    await expect(publish).not.toHaveClass(/hidden/);

    await hostSend(page, { type: "manifest", hasManifest: false });
    await expect(create.locator(".label")).toHaveText("Create a Mod");
    await expect(publish).toHaveClass(/hidden/);
  });

  test("skills updates:2 shows the nav badge", async ({ page }) => {
    await openPreview(page, "nav");
    const skillsRow = page.locator('[data-testid="nav-item"][data-id="skills"]');
    const badge = skillsRow.getByTestId("nav-badge");
    await expect(badge).toHaveClass(/hidden/);

    await hostSend(page, { type: "skills", updates: 2 });
    await expect(badge).not.toHaveClass(/hidden/);
    await expect(badge).toHaveText("2");
    await expect(skillsRow.locator(".desc")).toHaveText("Skill update available");
  });

  test("status transitions offline -> menu -> mission update the footer dot/label/time", async ({ page }) => {
    await openPreview(page, "nav");
    const dot = page.getByTestId("status-dot");
    const label = page.getByTestId("status-label");
    const time = page.getByTestId("status-time");

    await expect(dot).toHaveClass(/off/);
    await expect(label).toHaveText("Bridge offline");

    await hostSend(page, { type: "status", status: { connected: true, dcsTime: 0 } });
    await expect(dot).toHaveClass(/menu/);
    await expect(label).toHaveText("At menu");

    await hostSend(page, { type: "status", status: { connected: true, dcsTime: 213 } });
    await expect(dot).toHaveClass(/mission/);
    await expect(label).toHaveText("Mission running");
    await expect(time).toHaveText("t 213s");
  });
});
