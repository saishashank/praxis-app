// M21 C6 (UXN-324 a, D-1320 to D-1324; AT-82, AT-59): the Blueprint is operable by keyboard alone. The pinned Owner (the same
// e2e identity as m16-blueprint-access.spec.ts) on the seeded `blueprint-full` state (part of E2E_STATES=all) walks the
// Platform view with Tab and the arrow keys: every node is reached, each shows a visible focus ring, the open node's
// connections are buttons that light their edge, and axe is clean at 1280 and 375 px. Lane: rich.
import { expect, test, type Page } from "@playwright/test";
import { axeViolations, signIn } from "./helpers";
import { requireScenario } from "./support/requireScenario";

requireScenario("rich", "run it in the rich lane: E2E_SCENARIO=rich (E2E_STATES includes all)");

const activeNode = (page: Page) =>
  page.evaluate(() => document.activeElement?.getAttribute("data-node") ?? null);

async function openPlatform(page: Page) {
  await page.goto("/blueprint");
  await page
    .getByRole("tablist", { name: "Blueprint views" })
    .getByRole("tab", { name: "Platform", exact: true })
    .click();
  await expect(page.locator("[data-node]").first()).toBeAttached();
}

for (const [label, width] of [
  ["1280", 1280],
  ["375", 375],
] as const) {
  test(`a keyboard-only walk reaches every node of the Platform view with a visible focus ring, axe clean at ${label}`, async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(240_000);
    const context = await browser.newContext({ baseURL, viewport: { width, height: 900 } });
    await signIn(context, "owner");
    const page = await context.newPage();
    await openPlatform(page);

    const all = await page
      .locator("[data-node]")
      .evaluateAll((ns) => ns.map((n) => n.getAttribute("data-node")!));
    expect(all.length).toBeGreaterThan(5);
    // One tab stop among the nodes.
    await expect(page.locator('[data-node][tabindex="0"]')).toHaveCount(1);

    // Tab from the viewport enters the diagram on its single node stop.
    await page.getByTestId("bp-viewport").focus();
    await page.keyboard.press("Tab");
    const entered = await activeNode(page);
    expect(entered).not.toBeNull();

    const seen = new Set<string>();
    const visit = async () => {
      const id = await activeNode(page);
      if (id === null || seen.has(id)) return;
      seen.add(id);
      // The ring is drawn inside the focused node and is on screen.
      await expect(page.locator(`[data-node="${id}"] [data-focus-ring]`)).toBeVisible();
    };
    const run = async (key: string) => {
      for (let i = 0; i < all.length; i++) {
        const before = await activeNode(page);
        await page.keyboard.press(key);
        if ((await activeNode(page)) === before) break;
        await visit();
      }
    };

    await page.keyboard.press("Home");
    await visit();
    for (let col = 0; col < all.length; col++) {
      await run("ArrowUp");
      await run("ArrowDown");
      const before = await activeNode(page);
      await page.keyboard.press("ArrowRight");
      if ((await activeNode(page)) === before) break;
      await visit();
    }
    expect([...seen].sort()).toEqual([...all].sort());

    // End is the last node and carries a ring; axe with a ring on screen.
    await page.keyboard.press("End");
    await expect(page.locator("[data-node] [data-focus-ring]")).toHaveCount(1);
    expect(await axeViolations(page)).toEqual([]);
    await context.close();
  });
}

test("the open node lists its connections as buttons that light the matching edge", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ baseURL });
  await signIn(context, "owner");
  const page = await context.newPage();
  await openPlatform(page);

  // A node that has at least one edge.
  const withEdge = await page.evaluate(() => {
    const ends = new Set<string>();
    for (const g of document.querySelectorAll("[data-edge]")) {
      const [from, , to] = g.getAttribute("data-edge")!.split("|");
      ends.add(from);
      ends.add(to);
    }
    return [...ends][0];
  });
  const node = page.locator(`[data-node="${withEdge}"]`);
  await node.focus();
  await page.keyboard.press("Enter");
  const panel = page.getByTestId("bp-panel");
  await expect(panel).toBeVisible();
  const buttons = panel.getByTestId("bp-connection");
  const n = await buttons.count();
  expect(n).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) {
    await buttons.nth(i).focus();
    await expect(page.getByTestId("bp-summary").locator("strong")).toBeVisible();
  }
  await buttons.first().focus();
  expect(await axeViolations(page)).toEqual([]);

  // Escape closes the panel and the keyboard is back on the page, not lost.
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await context.close();
});

test("the export links download the draw.io and SVG files for the shown view", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ baseURL });
  await signIn(context, "owner");
  const page = await context.newPage();
  await openPlatform(page);
  for (const [name, format, type] of [
    ["Export as draw.io", "drawio", "application/xml"],
    ["Export as SVG", "svg", "image/svg+xml"],
  ] as const) {
    const href = await page.getByRole("link", { name }).getAttribute("href");
    expect(href).toBe(`/api/blueprint/export?view=platform&format=${format}`);
    const r = await context.request.get(href!);
    expect(r.status()).toBe(200);
    expect(r.headers()["content-type"]).toContain(type);
    expect(r.headers()["content-disposition"]).toContain(`blueprint-platform.${format}`);
  }
  await context.close();
});
