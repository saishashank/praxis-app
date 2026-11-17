// M22 E2 (KB-082, UXN-296, D-1480; AT-79): the Owner's Sources page on the seeded `experts-sources` state (X-SRC1 tracked
// with an enabled licence row, X-SRC2 a discovery candidate; part of E2E_STATES=all). The Owner reads, in plain words, where
// the system reads from, sees the candidate with its three buttons and snoozes it (it leaves the list and the page says so);
// an Editor and a Viewer are refused with a 403; the page fits a phone and axe finds nothing in two themes. Lane: rich.
import { expect, test } from "@playwright/test";
import { axeViolations, expectNoHorizontalScroll, setTheme, signIn } from "./helpers";
import { requireScenario } from "./support/requireScenario";

requireScenario("rich", "run it in the rich lane: E2E_SCENARIO=rich (E2E_STATES includes all)");

const PATH = "/reviews/experts/sources";
const NAME_TRACKED = "ZZ Source Author";
const NAME_CANDIDATE = "ZZ Candidate Author";

test.describe.configure({ timeout: 300_000, mode: "serial" });

test("the Owner sees the sources in words and the candidate with its buttons", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ baseURL });
  await signIn(context, "owner");
  const page = await context.newPage();
  const r = await page.goto(PATH);
  expect(r?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "Expert sources" })).toBeVisible();
  await expect(page.getByRole("link", { name: NAME_TRACKED })).toBeVisible();
  await expect(
    page.getByText(/Not checked yet\. Nothing is read from it until it has been checked\./).first(),
  ).toBeVisible();
  const cand = page.locator("[data-candidate]").filter({ hasText: NAME_CANDIDATE });
  await expect(cand).toHaveCount(1);
  await expect(cand.getByRole("button", { name: "Approve" })).toBeVisible();
  await expect(cand.getByRole("button", { name: "Dismiss" })).toBeVisible();
  await expect(cand.getByRole("button", { name: "Snooze 90 days" })).toBeVisible();
  await expect(cand).toContainText("Red flags: manual check needed.");
  expect(await axeViolations(page)).toEqual([]);
  await context.close();
});

test("snoozing the candidate takes it off the list and says so", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  await signIn(context, "owner");
  const page = await context.newPage();
  await page.goto(PATH);
  const cand = page.locator("[data-candidate]").filter({ hasText: NAME_CANDIDATE });
  await cand.getByRole("button", { name: "Snooze 90 days" }).click();
  await expect(page.locator("[data-candidate]").filter({ hasText: NAME_CANDIDATE })).toHaveCount(0);
  await expect(page.getByText(/snoozed and will come back/)).toBeVisible();
  await context.close();
});

test("an Editor and a Viewer get the 403 page", async ({ browser, baseURL }) => {
  for (const role of ["editor", "viewer"] as const) {
    const context = await browser.newContext({ baseURL });
    await signIn(context, role);
    const r = await context.request.get(PATH, { maxRedirects: 0 });
    expect(r.status()).toBe(403);
    await context.close();
  }
});

test("the page fits a phone and axe is clean in two themes", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 360, height: 800 } });
  await signIn(context, "owner");
  const page = await context.newPage();
  for (const theme of ["light", "dark"]) {
    await setTheme("owner", theme);
    await page.goto(PATH);
    await expect(page.getByRole("heading", { level: 1, name: "Expert sources" })).toBeVisible();
    await expectNoHorizontalScroll(page);
    expect(await axeViolations(page)).toEqual([]);
  }
  await context.close();
});
