// M19 E2, AT-68 (c), MKT-110 (c), SEC-112 (V2 ch. 18 l.7), D-997, D-1064: with only AU enabled, a market that is built
// but not enabled (IN, US) appears NOWHERE in a rendered page for an Editor or a Viewer, and for the Owner only inside
// the Markets table of Settings. Every signed-in page carries `data-market="AU"`. A market parameter that names a
// market that is not enabled is a 404: `/market?market=IN` through the resolver, `/market/IN` because the company
// route finds no such code. Runs in the empty lane (the production shape: `market` rows AU enabled, IN and US built
// and off); it never enables a market.
import { expect, test, type BrowserContext } from "@playwright/test";
import { PAGES, allowedRoles } from "./pages";
import { ROLE_LIST, concretePath, signIn, type Role } from "./helpers";
import { marketLeaks, withoutMarketsTable } from "./support/leaks";
import { requireScenario } from "./support/requireScenario";

requireScenario("empty", "AT-68 (c): the empty lane is the production shape (AU only enabled)");

const signedInPages = PAGES.filter((p) => p.action !== "public");

async function walk(context: BrowserContext, role: Role) {
  const seen: { url: string; html: string }[] = [];
  for (const entry of signedInPages) {
    if (!allowedRoles(entry).includes(role)) continue;
    const url = concretePath(entry.path, role);
    if (!url) continue;
    const res = await context.request.get(url, { maxRedirects: 5 });
    if (res.status() !== 200) continue;
    seen.push({ url, html: await res.text() });
  }
  return seen;
}

for (const role of ["editor", "viewer"] as const) {
  test(`${role}: no built-off market appears on any page, and every page carries data-market="AU"`, async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({ baseURL });
    await signIn(context, role);
    const seen = await walk(context, role);
    expect(seen.length).toBeGreaterThan(15);
    for (const { url, html } of seen) {
      expect(marketLeaks(html), `${role} ${url}`).toEqual([]);
      expect(html, `${role} ${url} names its market`).toContain('data-market="AU"');
    }
    await context.close();
  });
}

test("owner: IN and US appear only in the Markets table of Settings, as built and off", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ baseURL });
  await signIn(context, "owner");
  const seen = await walk(context, "owner");
  expect(seen.length).toBeGreaterThan(20);
  for (const { url, html } of seen) {
    expect(
      marketLeaks(withoutMarketsTable(html)),
      `owner ${url} outside the Markets table`,
    ).toEqual([]);
    expect(html, `owner ${url} names its market`).toContain('data-market="AU"');
  }
  const page = await context.newPage();
  await page.goto("/settings/region");
  // DataTable renders a <table> and a stacked card view of the same rows (UXN-017); count in the table only.
  const table = page.locator("[data-markets-table] table");
  await expect(table.locator('[data-market="AU"]')).toHaveCount(1);
  await expect(table.locator('[data-market="IN"]')).toHaveCount(1);
  await expect(table.locator('[data-market="US"]')).toHaveCount(1);
  await expect(table.getByText("Built — off in production")).toHaveCount(2);
  await expect(table.getByText("Active")).toHaveCount(1);
  await context.close();
});

test("a market that is not enabled is a 404: /market?market=IN, ?market=US and /market/IN", async ({
  browser,
  baseURL,
}) => {
  for (const role of ROLE_LIST) {
    const context = await browser.newContext({ baseURL });
    await signIn(context, role);
    for (const url of ["/market?market=IN", "/market?market=US", "/market/IN"]) {
      const res = await context.request.get(url, { maxRedirects: 5 });
      expect(res.status(), `${role} ${url}`).toBe(404);
    }
    const ok = await context.request.get("/market?market=AU", { maxRedirects: 5 });
    expect(ok.status(), `${role} /market?market=AU`).toBe(200);
    await context.close();
  }
});

test("the region menu lists the enabled market only", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  await signIn(context, "viewer");
  const page = await context.newPage();
  await page.goto("/");
  const items = await page
    .locator("li[data-market]")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-market")));
  expect(items.filter((c) => c !== "AU")).toEqual([]);
  await context.close();
});
