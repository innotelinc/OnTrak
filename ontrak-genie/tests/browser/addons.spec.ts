import { expect, test } from "@playwright/test";

/**
 * The add-ons panel, in a browser.
 *
 * Two things are being pinned, and only one of them is about the add-ons. The first
 * is that the panel *renders*: it was reachable from the rail, it fetched and built
 * its rows, and it was invisible anyway, because the stylesheet listed the rail views
 * it draws by name and this one was not in the list. A test that asked the API would
 * have passed all along — this asserts the thing a person sees.
 *
 * The second is what the rows say: one per add-on, each opening its own front door
 * (`re.` for Engineer, `uc.` for Uncensored Godmode) rather than a path inside this
 * console. Balances belong to the control-plane tests; a deployment with no plane
 * says so in the row instead of inventing a number.
 */
test.describe("the add-ons panel", () => {
  test("opens from the rail, lists both doors, and says it is unmetered here", async ({ page }) => {
    await page.goto("/");

    // The button toggles the rail's current view, so a click that lands while the
    // panel is already the open view closes it — click until it is on screen.
    for (let attempt = 0; attempt < 3 && !(await page.locator("#addons").isVisible()); attempt += 1) {
      await page.click("#addons-open");
      await page.waitForTimeout(300);
    }

    const panel = page.locator("#addons");
    await expect(panel).toBeVisible();
    await expect(panel.locator(".addon")).toHaveCount(2);

    const engineer = panel.locator(".addon", { hasText: "OnTrak Engineer" });
    const godmode = panel.locator(".addon", { hasText: "Uncensored Godmode" });
    await expect(engineer.locator("a.addon__open")).toHaveAttribute("href", "https://re.genie.innotel.us");
    await expect(godmode.locator("a.addon__open")).toHaveAttribute("href", "https://uc.genie.innotel.us");

    // No control plane on this instance: the honest sentence is that nothing is
    // metered, and a "buy" button would be the lie that it was.
    await expect(panel.locator(".addon__note").first()).toContainText("not metered");
    await expect(panel.locator("a.addon__buy")).toHaveCount(0);

    // And it closes again, which is the other half of "the panel works".
    await page.click("#addons-close");
    await expect(panel).toBeHidden();
  });
});
