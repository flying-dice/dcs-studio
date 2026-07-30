import { expect, test } from "./fixtures";
import { expectSent, hostSend, openPreview } from "./helpers";

test.describe("nav preview", () => {
  test("renders all 10 rows, publish hidden by default", async ({ page }) => {
    await openPreview(page, "nav");
    await expect(page.getByTestId("nav-item")).toHaveCount(10);
    await expect(page.locator('[data-testid="nav-item"][data-id="publish"]')).toHaveClass(/hidden/);
  });

  test("posts a boot handshake so the opening state can be re-asked for", async ({ page }) => {
    // The sidebar renders complete from static data, which is why it had no
    // handshake at all — but the host's opening pushes are async and can land
    // before this listener exists, and nothing else re-pushes (card 29).
    await openPreview(page, "nav");
    await expectSent(page, { type: "ready" });
  });

  test("the handshake answer reveals Publish Mod when the opening push was lost", async ({
    page,
  }) => {
    // The whole user-visible cost of the lost race: in a workspace that IS a mod
    // project, the route to publishing is simply absent from the sidebar. This
    // fixture answers ONLY the handshake, so the row's appearance is the
    // handshake's doing and nothing else's.
    const errors = await openPreview(page, "nav", { query: { scenario: "modproject" } });

    await expect(page.locator('[data-testid="nav-item"][data-id="publish"]')).not.toHaveClass(
      /hidden/,
    );
    await expect(page.locator('[data-testid="nav-item"][data-id="create"] .label')).toHaveText(
      "Edit Project",
    );
    await expect(
      page.locator('[data-testid="nav-item"][data-id="skills"]').getByTestId("nav-badge"),
    ).toHaveText("1");
    expect(errors).toEqual([]);
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

  test("status transitions offline -> menu -> mission update the footer dot/label/time", async ({
    page,
  }) => {
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

    // DCS quitting has to walk the footer all the way back, sim clock and all
    // — a stale "t 213s" under an offline dot reads as a live mission.
    await hostSend(page, { type: "status", status: { connected: false, dcsTime: null } });
    await expect(dot).toHaveClass(/off/);
    await expect(label).toHaveText("Bridge offline");
    await expect(time).toHaveText("");
  });
});
