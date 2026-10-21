import { expect, test } from "@playwright/test";
import { testLogin } from "../scripts/e2e/test-login.mjs";

// Staging checks (M8 T12; TST-106, TST-132). Read-only: no form is submitted and nothing is
// changed. Assertions never include the staging URL or a cookie value in a message.

const VIEWER = "viewer@praxis.test"; // the seeded test identity (.test addresses only)

test.describe("staging, signed out", () => {
  test("/ sends a signed-out visitor to sign-in", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/signin/);
    await expect(page.getByRole("button", { name: "Sign in with Google" })).toBeVisible();
  });

  test("the health endpoint answers", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.status()).toBe(200);
  });
});

test.describe("staging, test identity (viewer)", () => {
  test.beforeEach(async ({ context, baseURL }) => {
    const secret = process.env.TEST_IDENTITY_SECRET;
    if (!secret || !baseURL) throw new Error("test identity is not configured");
    const pair = await testLogin(baseURL, secret, VIEWER);
    const eq = pair.indexOf("=");
    await context.addCookies([
      { name: pair.slice(0, eq), value: pair.slice(eq + 1), url: baseURL, httpOnly: true },
    ]);
  });

  for (const [path, heading] of [
    ["/", null],
    ["/health", "System Health"],
    ["/market", null],
    ["/reviews", null],
  ] as const) {
    test(`${path} loads for a viewer`, async ({ page }) => {
      const res = await page.goto(path);
      expect(res?.status()).toBe(200);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      if (heading) await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
    });
  }

  test("System Health hides the Owner-only day timeline from a viewer", async ({ page }) => {
    await page.goto("/health");
    await expect(page.getByRole("heading", { name: "Day timeline check" })).toHaveCount(0);
  });
});
