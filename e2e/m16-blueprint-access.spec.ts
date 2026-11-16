// M16 WP1 / AT-57 (a)(e): /blueprint must be indistinguishable from a missing route for everyone
// except the pinned Owner, at the HTTP layer of a production build (D-371).
// M21 A2 (D-1210): the D-831 residual is retired. The proxy marks hidden AND unknown paths alike, so both take the same
// rewrite and every header, x-nextjs-rewritten-path included, is compared plainly (src/lib/http/hiddenRoutes.ts).
// The DB allows one owner row, so a "second owner-role identity" cannot be seeded here; that case is
// covered by the guard unit test. Accepted: a signed-in non-owner costs one extra auth-DB read in the
// proxy, a timing difference we do not hide (no sleeps).
import { expect, test } from "@playwright/test";
import { expectHiddenEqualsMissing } from "./support/hiddenParity";
import { signIn, type Role } from "./helpers";

for (const role of [null, "editor", "viewer"] as const) {
  test(`/blueprint equals a missing route for ${role ?? "anonymous"}`, async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({ baseURL });
    if (role) await signIn(context, role as Role);
    await expectHiddenEqualsMissing(context, role ?? "anonymous", [
      ["/blueprint", "/zz-missing"],
      ["/api/blueprint/model", "/api/zz-missing/model"],
      [
        "/api/blueprint/export?view=platform&format=svg",
        "/api/zz-missing/export?view=platform&format=svg",
      ],
    ]);
    await context.close();
  });
}

test("signed-in non-owner sees a real 404", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  await signIn(context, "editor");
  const r = await context.request.get("/blueprint", { maxRedirects: 0 });
  expect(r.status()).toBe(404);
  await context.close();
});

test("the pinned Owner gets the shell", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  await signIn(context, "owner");
  const page = await context.newPage();
  const res = await page.goto("/blueprint");
  expect(res?.status()).toBe(200);
  await expect(page.getByTestId("blueprint-shell")).toBeAttached();
  const robots = await page.locator('meta[name="robots"]').getAttribute("content");
  expect(robots).toContain("noindex");
  await context.close();
});
