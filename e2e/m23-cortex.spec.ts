// M23 M4 (CXA-015, CXA-010, CXA-005, AT-72, AT-74; D-1643, D-1765): the research half of the Cortex page on the seeded state
// `cortex-research` (part of E2E_STATES=all): three looks (Pass, Null, Inconclusive) with the first 12 characters of their plan
// fingerprint and one refused repeat look, the waiting-for-data meters (a collecting one with an expected date, a mover rule that
// reached its sample and a blocked one), the eight risk monitors with the stall alarm in words, the industry-group series
// labelled "static industry" and, for the Owner alone, the proposal counts. The Editor and Viewer see the same sections masked
// (an ISO week for a date, no proposal counts). No lineage key and no internal code is on the page. Lane: rich.
import { expect, test } from "@playwright/test";
import { axeViolations, expectNoHorizontalScroll, signIn, type Role } from "./helpers";
import { requireScenario } from "./support/requireScenario";

requireScenario("rich", "run it in the rich lane: E2E_SCENARIO=rich E2E_STATES=all");
test.describe.configure({ timeout: 300_000 });

const PATH = "/cortex";
const SECTIONS = [
  "research-tests",
  "research-waiting",
  "research-monitors",
  "research-sector",
] as const;
// keys and codes a reader must never see (names are shown instead)
const KEYS = [
  "cxa003_lowvol",
  "cxa003_hi52_vol",
  "cxa003_short_cover",
  "ann_angles",
  "movers_a1",
  "neff_live_F1",
  "llm_proposal_",
  "holdout_look",
  "research_meter",
];

for (const role of ["owner", "editor", "viewer"] as const satisfies readonly Role[]) {
  test(`${role}: the four research sections show names, results and plain words`, async ({
    page,
    context,
  }) => {
    await signIn(context, role);
    const res = await page.goto(PATH);
    expect(res?.status()).toBe(200);
    for (const id of SECTIONS) {
      await expect(page.locator(`[data-cortex-section="${id}"]`)).toBeVisible();
    }

    const tests = page.locator('[data-cortex-section="research-tests"]');
    await expect(tests).toContainText("Lowest-volatility stocks");
    await expect(tests).toContainText("New 52-week high on heavy volume");
    await expect(tests).toContainText("Falling short positions");
    await expect(tests).toContainText("Pass");
    await expect(tests).toContainText("Null (no edge found)");
    await expect(tests.locator("[data-research-inconclusive]")).toContainText(
      "not enough data to say either way",
    );
    // the fingerprint is the first 12 hex characters, never the whole hash
    await expect(tests.locator(".font-mono").first()).toHaveText(/^[0-9a-f]{12}$/);

    const waiting = page.locator('[data-cortex-section="research-waiting"]');
    await expect(waiting).toContainText("Announcement history");
    await expect(waiting).toContainText("14 of 252 sessions collected");
    await expect(waiting).toContainText("Expected about");
    await expect(waiting).toContainText("Waiting for a forward record");
    await expect(waiting).toContainText("the look is waiting for complete events");

    const monitors = page.locator('[data-cortex-section="research-monitors"]');
    for (let m = 1; m <= 8; m++) {
      await expect(monitors.locator(`[data-research-monitor="${m}"]`)).toBeVisible();
    }
    await expect(monitors.locator("[data-research-alarm]").first()).toContainText("Alarm:");
    await expect(monitors).toContainText("Trades are stalling more than expected");
    await expect(monitors).toContainText("one regime only");

    const sector = page.locator('[data-cortex-section="research-sector"]');
    await expect(sector).toContainText("static industry");
    await expect(sector).toContainText("ZZ Industrials");

    const proposals = page.locator("[data-owner-proposals]");
    const body = await page.locator("main").innerText();
    if (role === "owner") {
      await expect(proposals).toContainText("1 kept for your review, 1 refused");
    } else {
      await expect(proposals).toHaveCount(0);
      // masked: a week, never an exact date, in the research half
      expect(await tests.innerText()).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
    }
    for (const k of KEYS) expect(body).not.toContain(k);
    await expectNoHorizontalScroll(page);
    expect(await axeViolations(page)).toEqual([]);
  });
}

test("the research sections fit a phone without sideways scrolling", async ({ page, context }) => {
  await signIn(context, "owner");
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(PATH);
  await expect(page.locator('[data-cortex-section="research-tests"]')).toBeVisible();
  await expectNoHorizontalScroll(page);
  expect(await axeViolations(page)).toEqual([]);
});

test("the System Health page carries one research line for the Owner", async ({
  page,
  context,
}) => {
  await signIn(context, "owner");
  await page.goto("/health");
  await expect(page.getByTestId("m22-health")).toContainText("Research tests and risk monitors");
  await expect(page.getByTestId("m22-health")).toContainText("open alarm");
});
