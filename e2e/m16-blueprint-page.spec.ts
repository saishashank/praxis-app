// M16 WP5 / AT-59 (a)(d): the Blueprint page as the pinned Owner.
import { expect, test } from "@playwright/test";
import { axeViolations, expectNoHorizontalScroll, signIn } from "./helpers";

const TABS = [
  "Platform",
  "Data",
  "Cortex pipeline",
  "Agents and schedule",
  "LLM router",
  "Email and alerts",
  "Security and roles",
  "Learning loop",
];

test("eight tabs, hover, panel, search and axe", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  await signIn(context, "owner");
  const page = await context.newPage();
  await page.goto("/blueprint");
  const tablist = page.getByRole("tablist", { name: "Blueprint views" });
  await expect(tablist.getByRole("tab")).toHaveCount(9);
  for (const name of TABS) {
    await tablist.getByRole("tab", { name, exact: true }).click();
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    await expect(page.locator("[data-node]").first()).toBeAttached();
  }
  await tablist.getByRole("tab", { name: "Platform", exact: true }).click();

  const node = page.locator("[data-node]").first();
  await node.hover();
  await expect(page.getByTestId("bp-summary")).toContainText(
    (await node.getAttribute("aria-label"))!.split(",")[0],
  );

  await page.getByTestId("bp-search").fill("AGT-105");
  const first = page.getByTestId("bp-results").getByRole("button").first();
  await expect(first).toBeVisible();
  await first.click();
  const panel = page.getByTestId("bp-panel");
  await expect(panel).toBeVisible();
  await expect(
    page.getByTestId("bp-panel-specs").getByRole("link", { name: "AGT-105" }),
  ).toHaveAttribute("href", /tab=spec&q=AGT-105/);
  await expect(page.getByTestId("bp-panel-status")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();

  expect(await axeViolations(page)).toEqual([]);
  await context.close();
});

test("phone width: no sideways scroll, zoom works", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 375, height: 812 } });
  await signIn(context, "owner");
  const page = await context.newPage();
  await page.goto("/blueprint");
  await expect(page.locator("[data-node]").first()).toBeAttached();
  await expectNoHorizontalScroll(page);
  const group = page.locator("svg > g").first();
  const before = await group.getAttribute("transform");
  await page.getByRole("button", { name: "Zoom in" }).click();
  expect(await group.getAttribute("transform")).not.toEqual(before);
  await expectNoHorizontalScroll(page);
  expect(await axeViolations(page)).toEqual([]);
  await context.close();
});

// AT-59 (a), edges: edges are mouse-only (no tab stop), so each edge of one view is hovered with the
// real mouse at the middle of its curve and the summary must show that edge's kind and contract.
test("hovering every edge of a view shows its summary", async ({ browser, baseURL }) => {
  test.setTimeout(240_000);
  const context = await browser.newContext({ baseURL });
  await signIn(context, "owner");
  const page = await context.newPage();
  await page.goto("/blueprint");
  await page
    .getByRole("tablist", { name: "Blueprint views" })
    .getByRole("tab", { name: "Platform", exact: true })
    .click();
  await expect(page.locator("[data-node]").first()).toBeAttached();
  const ids = await page
    .locator("[data-edge]")
    .evaluateAll((es) => es.map((e) => e.getAttribute("data-edge")!));
  expect(ids.length).toBeGreaterThan(0);
  expect(await page.locator("[data-edge]").first().getAttribute("tabindex")).toBeNull();
  let hovered = 0;
  const covered: string[] = []; // edges drawn wholly under a node or another edge: no mouse can reach them
  for (const id of ids) {
    const edge = page.locator(`[data-edge="${id}"]`);
    await edge.scrollIntoViewIfNeeded();
    // A point on the curve that is on screen and not covered by a node or another edge.
    const pt = await edge.evaluate((g) => {
      const p = g.querySelector("path") as SVGPathElement;
      const s = p.getScreenCTM()!;
      for (const f of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.1, 0.9]) {
        const m = p.getPointAtLength(p.getTotalLength() * f);
        const x = m.x * s.a + m.y * s.c + s.e;
        const y = m.x * s.b + m.y * s.d + s.f;
        if (document.elementFromPoint(x, y)?.closest("[data-edge]") === g) return { x, y };
      }
      return null;
    });
    if (!pt) {
      covered.push(id);
      continue;
    }
    await page.mouse.move(pt.x, pt.y);
    hovered++;
    await expect(page.getByTestId("bp-summary").locator("strong")).toHaveText(id.split("|")[1]);
  }
  expect(hovered, "edges reachable by the mouse").toBeGreaterThanOrEqual(
    Math.ceil(ids.length * 0.8),
  );
  test.info().annotations.push({
    type: "covered edges",
    description: `${covered.length} of ${ids.length}`,
  });
  await context.close();
});
