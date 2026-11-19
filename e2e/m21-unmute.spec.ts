// M21 C3 (UXN-322, D-1207; AT-82): My alerts shows a "Muted" chip with Unmute on the seeded muted alert
// (state alerts-muted, user e2e-viewer). The seeded viewer has not turned "Alerts for all picks" on, and the
// seeded pick is not on today's list, so the click is refused in words and the alert stays muted: the legal
// transition (an appended armed row) is proved on a migrated database by tests/alerts/unmute.test.ts and
// tests/settings/alerts.test.tsx. Lane: rich (E2E_STATES includes "all").
import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";
import { requireScenario } from "./support/requireScenario";

requireScenario("rich", "run it in the rich lane: E2E_SCENARIO=rich");

test("My alerts: a muted alert shows the Muted chip and an Unmute button; a refused unmute says why", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ baseURL });
  await signIn(context, "viewer");
  const page = await context.newPage();
  await page.goto("/alerts");
  const row = page.getByTestId("alert-row").filter({ has: page.getByTestId("muted-chip") });
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("muted-chip")).toHaveText("Muted");
  await row.getByRole("button", { name: /^Unmute the alert for/ }).click();
  await expect(row.getByRole("alert")).toContainText("Turn on alerts for all picks first");
  await expect(row.getByTestId("muted-chip")).toBeVisible();
  await context.close();
});
