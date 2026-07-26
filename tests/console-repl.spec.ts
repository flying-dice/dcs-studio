import { expect, test } from "./fixtures";
import { expectSent, hostSend, openPreview, sentMessages, webviewState } from "./helpers";

// The Console tab of the Lua console: the REPL itself, the two-bridge status
// line, and the env picker that decides which bridge a snippet is routed to.
// (tests/console.spec.ts covers the Explorer tab of the same webview.)

/** The status shape the host pushes; both bridges default to offline. */
function status(gui: unknown, mission: unknown) {
  return { type: "status", status: { gui, mission } };
}
const OFFLINE = status({ connected: false, dcsTime: null }, { connected: false, dcsTime: null });
const AT_MENU = status({ connected: true, dcsTime: 0 }, { connected: false, dcsTime: null });
const IN_MISSION = status({ connected: true, dcsTime: 120.5 }, { connected: true, dcsTime: 42.25 });

test.describe("Lua Console — Console tab", () => {
  test("Run posts the code with the selected env and echoes it into the log", async ({ page }) => {
    const errors = await openPreview(page, "console");
    await expect(page.getByTestId("run-btn")).toBeEnabled();

    await page.getByTestId("code-input").fill("  return DCS.getVersion()  ");
    await page.getByTestId("run-btn").click();

    // Trimmed, because a stray newline from a paste would otherwise be sent to
    // the sim and counted as a distinct history entry.
    await expectSent(page, { type: "eval", env: "gui", code: "return DCS.getVersion()" });
    await expect(page.locator('[data-testid="log-entry"][data-kind="input"]')).toHaveText(
      "return DCS.getVersion()",
    );
    // The box clears so the next snippet starts from empty.
    await expect(page.getByTestId("code-input")).toHaveValue("");
    expect(errors).toEqual([]);
  });

  test("an empty or whitespace-only snippet is not sent", async ({ page }) => {
    await openPreview(page, "console");
    await page.getByTestId("code-input").fill("   \n  ");
    await page.getByTestId("run-btn").click();

    expect((await sentMessages(page)).filter((m) => m.type === "eval")).toHaveLength(0);
    await expect(page.locator('[data-testid="log-entry"][data-kind="input"]')).toHaveCount(0);
  });

  test("Ctrl+Enter and Cmd+Enter both run the snippet", async ({ page }) => {
    await openPreview(page, "console");

    await page.getByTestId("code-input").fill("return 1");
    await page.getByTestId("code-input").press("Control+Enter");
    await expectSent(page, { type: "eval", code: "return 1" });

    // macOS users reach for ⌘ — the placeholder promises both.
    await page.getByTestId("code-input").fill("return 2");
    await page.getByTestId("code-input").press("Meta+Enter");
    await expectSent(page, { type: "eval", code: "return 2" });
  });

  test("results, errors and sim print output land in the log with distinct kinds", async ({
    page,
  }) => {
    await openPreview(page, "console");

    await hostSend(page, { type: "result", value: { a: 1 } });
    await hostSend(page, { type: "result", value: "plain string" });
    // A nil return is a real Lua answer, not a missing one, so it has to read
    // as "nil" rather than as an empty entry.
    await hostSend(page, { type: "result", value: null });
    await hostSend(page, { type: "error", message: "attempt to call a nil value" });
    await hostSend(page, { type: "print", lines: [{ text: "one" }, { text: "two" }] });

    await expect(page.locator('[data-testid="log-entry"][data-kind="result"]')).toHaveText([
      '{\n  "a": 1\n}',
      "plain string",
      "nil",
    ]);
    await expect(page.locator('[data-testid="log-entry"][data-kind="error"]')).toHaveText(
      "attempt to call a nil value",
    );
    await expect(page.locator('[data-testid="log-entry"][data-kind="print"]')).toHaveText([
      "one",
      "two",
    ]);
  });

  test("a value that cannot be serialised still renders instead of throwing", async ({ page }) => {
    // Lua tables with cycles come back as cyclic JS objects; JSON.stringify
    // throws on those, and a REPL that dies on one result is worse than one
    // that prints something unhelpful.
    const errors = await openPreview(page, "console");
    await page.evaluate(() => {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      (window as unknown as { __host: { receive(m: unknown): void } }).__host.receive({
        type: "result",
        value: cyclic,
      });
    });

    await expect(page.locator('[data-testid="log-entry"][data-kind="result"]')).toHaveText(
      "[object Object]",
    );
    expect(errors).toEqual([]);
  });

  test("↑/↓ walk the history and ↓ past the end clears the box", async ({ page }) => {
    await openPreview(page, "console");
    for (const code of ["return 1", "return 2"]) {
      await page.getByTestId("code-input").fill(code);
      await page.getByTestId("run-btn").click();
    }

    const box = page.getByTestId("code-input");
    await box.press("ArrowUp");
    await expect(box).toHaveValue("return 2");

    // Recall leaves the caret at the end of the recalled text, and ↑ only
    // walks history from the start of the box — so the next ↑ is spent moving
    // the caret back to column 0 and the one after it does the recall. Worth
    // pinning: it's why stepping back through history feels like it needs a
    // double tap.
    await box.press("ArrowUp");
    await expect(box).toHaveValue("return 2");
    await box.press("ArrowUp");
    await expect(box).toHaveValue("return 1");

    // ↓ only walks when the caret is at the end, which it is after a recall.
    await box.press("ArrowDown");
    await expect(box).toHaveValue("return 2");
    // Past the newest entry is "the empty box you were typing in".
    await box.press("ArrowDown");
    await expect(box).toHaveValue("");
  });

  test("↑ is left to the caret when it is not at the start of the box", async ({ page }) => {
    // ↑ inside a multi-line snippet has to move the caret, not swap the text
    // out from under the user.
    await openPreview(page, "console");
    await page.getByTestId("code-input").fill("return 1");
    await page.getByTestId("run-btn").click();

    const box = page.getByTestId("code-input");
    await box.fill("local a = 1\nreturn a");
    await box.press("ArrowUp");
    await expect(box).toHaveValue("local a = 1\nreturn a");
  });

  test("re-running the same snippet does not duplicate the history entry", async ({ page }) => {
    await openPreview(page, "console");
    for (let i = 0; i < 2; i++) {
      await page.getByTestId("code-input").fill("return 1");
      await page.getByTestId("run-btn").click();
    }

    const box = page.getByTestId("code-input");
    await box.press("ArrowUp");
    await expect(box).toHaveValue("return 1");
    await box.press("ArrowUp");
    // One entry, so a second ↑ has nowhere older to go.
    await expect(box).toHaveValue("return 1");
  });

  test("history is capped at 100 entries", async ({ page }) => {
    // History is persisted with the panel, so an uncapped one would grow the
    // stored state forever. The oldest entries are dropped rather than the
    // newest refused.
    await openPreview(page, "console");
    await page.evaluate(() => {
      const box = document.getElementById("code") as HTMLTextAreaElement;
      const run = document.getElementById("run") as HTMLButtonElement;
      for (let i = 0; i < 105; i++) {
        box.value = `return ${i}`;
        run.click();
      }
    });

    const stored = await webviewState(page);
    expect(stored.history).toHaveLength(100);
    expect(stored.history[0]).toBe("return 5");
    expect(stored.history[99]).toBe("return 104");
  });

  test("a reloaded panel restores its history, env and tab", async ({ page }) => {
    // vscode.setState survives the webview being hidden and re-created, which
    // is what makes the console feel like a session rather than a scratchpad.
    await openPreview(page, "console", {
      state: { history: ["return old"], env: "mission", tab: "explorer" },
    });

    await expect(page.getByTestId("env-select")).toHaveValue("mission");
    await expect(page.locator('.tab[data-tab="explorer"]')).toHaveClass(/active/);
    await page.locator('.tab[data-tab="console"]').click();
    await page.getByTestId("code-input").press("ArrowUp");
    await expect(page.getByTestId("code-input")).toHaveValue("return old");
  });

  test("switching env re-targets eval and re-evaluates the warning", async ({ page }) => {
    await openPreview(page, "console");
    await expect(page.getByTestId("env-warn")).toHaveText("");

    await page.getByTestId("env-select").selectOption("mission");
    // The GUI bridge is up but no mission is running, so mission Lua has
    // nowhere to go — say so and refuse to send.
    await expect(page.getByTestId("env-warn")).toHaveText("needs a running mission");
    await expect(page.getByTestId("run-btn")).toBeDisabled();

    await page.getByTestId("env-select").selectOption("server");
    await expect(page.getByTestId("env-warn")).toHaveText("");
    await page.getByTestId("code-input").fill("return 1");
    await page.getByTestId("run-btn").click();
    await expectSent(page, { type: "eval", env: "server", code: "return 1" });
  });

  test("a stale mission bridge is called out separately from 'no mission'", async ({ page }) => {
    // The GUI bridge reporting a running sim clock while the mission bridge is
    // down means MissionScripting.lua is still sanitized — a different fix from
    // "start a mission", so it gets different words.
    await openPreview(page, "console");
    await hostSend(page, status({ connected: true, dcsTime: 88 }, { connected: false }));
    await expect(page.getByTestId("status-label")).toHaveText(
      "Mission running — mission bridge offline",
    );
    await expect(page.getByTestId("status-time")).toHaveText("sim t = 88.0s");

    await page.getByTestId("env-select").selectOption("mission");
    await expect(page.getByTestId("env-warn")).toHaveText(
      "mission bridge offline — desanitize MissionScripting.lua and restart the mission",
    );
  });

  test("the status line reflects each bridge combination", async ({ page }) => {
    await openPreview(page, "console");
    await expect(page.getByTestId("status-label")).toHaveText("Connected — at menu (no mission)");
    await expect(page.getByTestId("bridge-dot")).toHaveClass("dot menu");
    await expect(page.getByTestId("status-time")).toHaveText("");

    await hostSend(page, IN_MISSION);
    await expect(page.getByTestId("status-label")).toHaveText("Mission running");
    await expect(page.getByTestId("bridge-dot")).toHaveClass("dot mission");
    // The mission bridge's own clock wins over the GUI bridge's.
    await expect(page.getByTestId("status-time")).toHaveText("sim t = 42.3s");

    // A mission that has not ticked yet has no time worth showing.
    await hostSend(page, status({ connected: true, dcsTime: 0 }, { connected: true, dcsTime: 0 }));
    await expect(page.getByTestId("status-time")).toHaveText("");

    await hostSend(page, OFFLINE);
    await expect(page.getByTestId("status-label")).toHaveText(
      "Bridge offline — click Launch DCS (with bridge) to connect",
    );
    await expect(page.getByTestId("bridge-dot")).toHaveClass("dot off");
  });

  test("a status push missing either bridge is treated as that bridge being down", async ({
    page,
  }) => {
    const errors = await openPreview(page, "console");
    await hostSend(page, { type: "status", status: {} });
    await expect(page.getByTestId("status-label")).toHaveText(
      "Bridge offline — click Launch DCS (with bridge) to connect",
    );
    await expect(page.getByTestId("launch-btn")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("Launch shows progress and gives up after 15s", async ({ page }) => {
    // Nothing comes back over this channel to say the launch failed, so the
    // button un-latches on a timer — otherwise a failed launch leaves the only
    // way back online permanently disabled.
    await page.clock.install();
    await openPreview(page, "console");
    await page.clock.runFor(10);
    await hostSend(page, OFFLINE);

    await expect(page.getByTestId("launch-btn")).toBeVisible();
    await page.getByTestId("launch-btn").click();
    await expectSent(page, { type: "launch" });
    await expect(page.getByTestId("launch-btn")).toBeDisabled();
    await expect(page.getByTestId("launch-btn")).toHaveText("Launching…");

    await page.clock.runFor(15_000);
    await expect(page.getByTestId("launch-btn")).toBeEnabled();
    await expect(page.getByTestId("launch-btn")).toHaveText("Launch DCS (with bridge)");
  });

  test("a launch that connects hides the button and drops the guard", async ({ page }) => {
    await openPreview(page, "console");
    await hostSend(page, OFFLINE);
    await page.getByTestId("launch-btn").click();
    await expect(page.getByTestId("launch-btn")).toHaveText("Launching…");

    await hostSend(page, AT_MENU);
    await expect(page.getByTestId("launch-btn")).toBeHidden();

    // Going offline again must offer a fresh button, not the stuck "Launching…".
    await hostSend(page, OFFLINE);
    await expect(page.getByTestId("launch-btn")).toBeEnabled();
    await expect(page.getByTestId("launch-btn")).toHaveText("Launch DCS (with bridge)");
  });

  test("the host's wildcard depth is only taken when it is a number", async ({ page }) => {
    const errors = await openPreview(page, "console");
    await hostSend(page, { type: "explorerConfig", wildcardDepth: 3 });
    await hostSend(page, { type: "explorerConfig" });
    // Nothing user-visible changes; what matters is that a malformed config
    // push doesn't poison the sweep budget with NaN.
    await expect(page.getByTestId("status-label")).toHaveText("Connected — at menu (no mission)");
    expect(errors).toEqual([]);
  });

  test("ignores an empty host message", async ({ page }) => {
    const errors = await openPreview(page, "console");
    await hostSend(page, null);
    await expect(page.getByTestId("run-btn")).toBeEnabled();
    expect(errors).toEqual([]);
  });
});
