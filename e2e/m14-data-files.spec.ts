// M14 WP8 (DAT-234, DAT-236, FAM-006): the "Data files" card on Configuration. Owner only (Editor and
// Viewer get the 403 page, covered in roles.spec.ts). The Owner uploads an index-change file and a
// bad one; the append-only table makes a re-run load 0 new rows, so the check reads "Loaded N new".
import { expect, test } from "@playwright/test";
import { axeViolations, signIn } from "./helpers";

test.describe.configure({ timeout: 300_000 });

const GOOD =
  "code,index,change,announced,effective,source\nZZE2E,S&P/ASX 200,add,2026-03-06,2026-03-23,e2e\n";

test("owner sees three upload forms, each needing a file and a confirmation", async ({
  page,
  context,
}) => {
  await signIn(context, "owner");
  await page.goto("/config");
  const card = page.locator("[data-data-files]");
  await expect(card.getByRole("heading", { name: "Data files" })).toBeVisible();
  for (const id of ["index_changes", "industry_map", "universe"]) {
    const form = card.locator(`[data-upload="${id}"]`);
    await expect(form.locator('input[type="file"]')).toBeVisible();
    await expect(form.locator('input[name="confirm"]')).not.toBeChecked();
    await expect(form.getByRole("button", { name: "Upload" })).toBeVisible();
  }
  expect(await axeViolations(page)).toEqual([]);
});

test("owner loads an index-change file; a bad file is refused with its line", async ({
  page,
  context,
}) => {
  await signIn(context, "owner");
  await page.goto("/config");
  const form = page.locator('[data-upload="index_changes"]');

  await form.locator('input[type="file"]').setInputFiles({
    name: "bad.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(`${GOOD}ZZE2F,X,add,,2026-02-30,e2e\n`),
  });
  await form.locator('input[name="confirm"]').check();
  await form.getByRole("button", { name: "Upload" }).click();
  await expect(form.getByRole("alert")).toContainText("line 3");

  await form.locator('input[type="file"]').setInputFiles({
    name: "good.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(GOOD),
  });
  // React resets an uncontrolled form after each action, so the box is ticked again.
  await form.locator('input[name="confirm"]').check();
  await form.getByRole("button", { name: "Upload" }).click();
  await expect(form.getByRole("status")).toContainText(/Loaded \d+ new rows?/);
});
