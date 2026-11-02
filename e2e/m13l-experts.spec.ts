// M13-lite WP6 (UXN-292..295, AT-41 (a), D-511, D-521, D-529): the expert directory, one expert, the claims
// queue and the techniques page. e2e/seed/experts.ts adds two ZZ experts, one red flag with its source, a
// proposed group and three claims to check. Owner and Editor open the queue and see the red-flag text; a Viewer
// gets the count only and a 403 on the queue; the pages fit a phone (360 px) and axe is clean in two themes.
import { expect, test } from "@playwright/test";
import { axeViolations, expectNoHorizontalScroll, setTheme, signIn } from "./helpers";
import { CLAIM_A, EXPERT_A, FLAG_TEXT, NAME_A, NAME_B, ensureExperts } from "./seed/experts";

test.describe.configure({ timeout: 300_000, mode: "serial" });
test.beforeAll(async () => {
  await ensureExperts();
});

const DETAIL = `/reviews/experts/${EXPERT_A}`;

test("directory: both experts listed, no sort by audience, links reach the knowledge page", async ({
  page,
  context,
}) => {
  await signIn(context, "viewer");
  await page.goto("/reviews/experts");
  await expect(page.getByRole("heading", { level: 1, name: "Experts" })).toBeVisible();
  await expect(page.getByRole("link", { name: NAME_A }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: NAME_B }).first()).toBeVisible();
  await expect(page.getByText("not enough tested claims").first()).toBeVisible();
  await expect(page.locator("[aria-sort]")).toHaveCount(0);
  // a Viewer has no link to the queue
  await expect(page.getByRole("link", { name: /Claims to check/ })).toHaveCount(0);
  await page.goto("/reviews/learned");
  await expect(page.getByRole("link", { name: "Experts" }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Techniques" }).first()).toBeVisible();
});

test("detail: Owner and Editor read the red flag and its source; a Viewer sees a count only", async ({
  page,
  context,
}) => {
  // the Owner sees the source as a link; the Editor (masked, ROL-107) reads the text but no outside link (D-631)
  await signIn(context, "owner");
  await page.goto(DETAIL);
  await expect(page.getByText(FLAG_TEXT)).toBeVisible();
  await expect(page.locator('a[href="https://zz-e2e.example.test/caveat"]')).toHaveAttribute(
    "rel",
    /noopener noreferrer/,
  );
  await signIn(context, "editor");
  await page.goto(DETAIL);
  await expect(page.getByText(FLAG_TEXT)).toBeVisible();
  await expect(page.locator('a[href="https://zz-e2e.example.test/caveat"]')).toHaveCount(0);
  await expect(page.locator("[data-red-flag-card] [data-link-hidden]")).toHaveCount(1);
  await signIn(context, "viewer");
  await page.goto(DETAIL);
  await expect(page.getByText(FLAG_TEXT)).toHaveCount(0);
  await expect(page.getByText("1 red flag is noted")).toBeVisible();
  await expect(page.getByText("Reach, not skill").first()).toBeVisible();
});

test("queue: a Viewer is refused (403); an Editor confirms one claim and it leaves the list", async ({
  page,
  context,
}) => {
  await signIn(context, "viewer");
  const refused = await page.goto("/reviews/experts/queue");
  expect(refused?.status()).toBe(403);

  await signIn(context, "editor");
  const ok = await page.goto("/reviews/experts/queue");
  expect(ok?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "Claims to check" })).toBeVisible();
  const claim = page.locator(`[data-queue-claim="${CLAIM_A}"]`);
  await expect(claim).toBeVisible();
  await claim.getByRole("button", { name: `Confirm claim ${CLAIM_A}` }).click();
  await expect(page.locator(`[data-queue-claim="${CLAIM_A}"]`)).toHaveCount(0);
});

test("techniques: the group is listed with its reason for waiting", async ({ page, context }) => {
  await signIn(context, "viewer");
  await page.goto("/reviews/techniques");
  await expect(page.getByRole("heading", { level: 1, name: "Techniques" })).toBeVisible();
  const card = page.locator('[data-technique="K-E2E1"]');
  await expect(card).toContainText("waiting for a person to confirm");
  await expect(card).toContainText("needs a new lineage (build change)");
});

test("phone: four pages fit 360 px and axe is clean in dark and light", async ({
  page,
  context,
}) => {
  await signIn(context, "owner");
  await page.setViewportSize({ width: 360, height: 800 });
  for (const theme of ["dark", "light"] as const) {
    await setTheme("owner", theme);
    for (const path of [
      "/reviews/experts",
      DETAIL,
      "/reviews/experts/queue",
      "/reviews/techniques",
    ]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectNoHorizontalScroll(page);
      expect(await axeViolations(page), `${path} ${theme}`).toEqual([]);
    }
  }
});
