// M22 C2 (UXN-289, UXN-290, AT-76; D-1423): the Committee trial page on the opt-in seed state `committee-trial` (a
// pre-registered trial with three nights of ratings and their interim rows). The Owner sees the status, the record written
// before the start, the interim figure labelled "interim, not a result" and the night tables; an Editor and a Viewer see the
// same page masked (no trial id, no exact day). No rating appears on the Picks page. Lane: rich with
// E2E_STATES="all,committee-trial" (the state is opt-in, D-1452).
import { expect, test } from "@playwright/test";
import { axeViolations, expectNoHorizontalScroll, signIn, type Role } from "./helpers";
import { requireScenario } from "./support/requireScenario";

requireScenario(
  "rich",
  'run it in the rich lane: E2E_SCENARIO=rich E2E_STATES="all,committee-trial"',
);
if (!(process.env.E2E_STATES ?? "").split(",").includes("committee-trial")) {
  throw new Error(
    'this spec needs E2E_STATES to include committee-trial, e.g. E2E_STATES="all,committee-trial" (TST-134)',
  );
}
test.describe.configure({ timeout: 300_000 });

const PATH = "/strategies/experiments/committee";
const TRIAL_ID = "zz-e2e-trial-1";

for (const role of ["owner", "editor", "viewer"] as const satisfies readonly Role[]) {
  test(`${role}: the trial page shows status, the record, the interim label and the nights`, async ({
    page,
    context,
  }) => {
    await signIn(context, role);
    const res = await page.goto(PATH);
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: "Committee trial" })).toBeVisible();
    await expect(page.getByTestId("committee-status")).toContainText("The trial is running");
    await expect(page.getByTestId("committee-prereg")).toContainText(
      "Written down before it started",
    );
    await expect(page.getByTestId("committee-interim-note")).toHaveText("Interim, not a result");
    await expect(page.getByRole("heading", { name: "Night by night" })).toBeVisible();
    await expect(page.getByText("Approve", { exact: false }).first()).toBeVisible();
    const body = await page.locator("main").innerText();
    if (role === "owner") {
      expect(body).toContain(TRIAL_ID);
    } else {
      // masked: neither the trial id (it carries the start date) nor a code
      expect(body).not.toContain(TRIAL_ID);
      expect(body).not.toContain("ZZ-SIG");
    }
    await expectNoHorizontalScroll(page);
    expect(await axeViolations(page)).toEqual([]);
  });
}

test("no rating appears on the Picks page", async ({ page, context }) => {
  await signIn(context, "owner");
  await page.goto("/picks");
  const body = await page.locator("main").innerText();
  expect(body).not.toContain("Committee");
  expect(body).not.toContain("interim, not a result");
});
