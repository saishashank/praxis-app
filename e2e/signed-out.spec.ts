import { expect, test } from "@playwright/test";

test.describe("signed out (TST-126)", () => {
  test("/ redirects to /signin with callbackUrl", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/signin\?callbackUrl=%2F$/);
    await expect(page.getByRole("button", { name: "Sign in with Google" })).toBeVisible();
  });

  test("/privacy and /terms are public", async ({ page }) => {
    for (const p of ["/privacy", "/terms"]) {
      const res = await page.goto(p);
      expect(res?.status()).toBe(200);
      await expect(page).toHaveURL(new RegExp(`${p}$`));
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    }
  });

  test("robots noindex header", async ({ request }) => {
    const res = await request.get("/signin");
    expect(res.headers()["x-robots-tag"]).toContain("noindex");
  });

  test("CSP has a nonce and no unsafe-inline in script-src", async ({ request }) => {
    const res = await request.get("/signin");
    const csp = res.headers()["content-security-policy"];
    const script = csp.split(";").find((d) => d.trim().startsWith("script-src")) ?? "";
    expect(script).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
    expect(script).not.toContain("'unsafe-inline'");
  });

  test("API without a session answers 401", async ({ request }) => {
    const res = await request.get("/api/internal/nothing", { maxRedirects: 0 });
    expect(res.status()).toBe(401);
  });
});
