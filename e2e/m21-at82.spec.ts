// M21 Z / AT-82 (D-1234, D-922, D-1325): the M21 walk. Every surface M21 added or changed is opened at 1280 and 375 px as
// each role that may see it, with: no horizontal scroll, axe (WCAG 2.2 AA) clean, and the rendered text of the page free of
// the internal-code patterns the static scan uses (scripts/ci/internal-codes.mjs, D-1233).
//
// Lane: rich, with E2E_STATES="all,owner-tools-on" (the Owner-tool pages exist only while the switch is on, D-1214, D-1243;
// the states `review-stored`, `steelman-cards`, `alerts-muted`, `blueprint-full` and `labels-queue` are part of "all").
// Roles: Owner sees every page; Editor and Viewer the pages that are not Owner-only (their refusal and the missing-route
// answers of the Owner tools are proved by m21-owner-tools-access and m21-owner-tools-on).
// Themes: the six themes are rotated over the pages of each role and width (page i uses theme i + the role and width offset),
// so every theme meets every page across the matrix without six times the page loads (D-1325).
// Not checked in the rendered text, each with its reason (D-1326): the Blueprint (a spec browser whose purpose is to show the
// requirement and decision ids of the build, Owner only) and the evidence markers of the steelman (E01-style citations the
// AI-written points refer to; they are reference labels inside `#ev-` and `#m-ev-` targets, not strategy codes).
import { expect, test, type Page } from "@playwright/test";
import { matchPatterns } from "../scripts/ci/internal-code-patterns.mjs";
import {
  axeViolations,
  expectNoHorizontalScroll,
  ROLE_LIST,
  setTheme,
  signIn,
  THEMES,
  type Role,
} from "./helpers";
import { opaqueDigest } from "../src/lib/view/opaqueRef";
import { ensureRich } from "./seed/rich";
import { ensureSteelman } from "./seed/steelman";
import { requireScenario } from "./support/requireScenario";

requireScenario(
  "rich",
  'run it in the rich lane: E2E_SCENARIO=rich E2E_STATES="all,owner-tools-on"',
);
if (!(process.env.E2E_STATES ?? "").split(",").includes("owner-tools-on")) {
  throw new Error(
    'this spec needs E2E_STATES to include owner-tools-on, e.g. E2E_STATES="all,owner-tools-on" (TST-134)',
  );
}

test.describe.configure({ timeout: 900_000 });

const WIDTHS = [1280, 375] as const;

type Surface = {
  name: string;
  /** The path, or "review" and "card" for the two pages whose id is read from the seed. */
  path: string;
  ownerOnly?: boolean;
  /** False for a page whose text legitimately holds ids (see the header). */
  text?: boolean;
};

const SURFACES: readonly Surface[] = [
  { name: "review", path: "review" },
  { name: "strategy", path: "/strategies/E01" },
  { name: "market", path: "/market" },
  { name: "alerts", path: "/alerts" },
  { name: "card", path: "card" },
  { name: "settings-alerts", path: "/settings/alerts" },
  { name: "strategies", path: "/strategies" },
  { name: "leaderboard", path: "/strategies/leaderboard" },
  { name: "risk", path: "/strategies/risk" },
  { name: "blueprint", path: "/blueprint", ownerOnly: true, text: false },
  { name: "labels", path: "/cortex/labels", ownerOnly: true },
  { name: "tax", path: "/reviews/tax", ownerOnly: true },
  { name: "recommendations", path: "/recommendations", ownerOnly: true },
  { name: "holdings", path: "/holdings", ownerOnly: true },
  { name: "trades", path: "/trades", ownerOnly: true },
];

let cardId = "";
test.beforeAll(async () => {
  await ensureRich();
  cardId = await ensureSteelman();
});

async function resolve(page: Page, s: Surface, role: string): Promise<string | null> {
  // a masked role opens a card by its opaque reference only (D-135, D-977); the stored id is the Owner's (D-1332)
  if (s.path === "card")
    return role === "owner"
      ? `/cards/${encodeURIComponent(cardId)}`
      : `/cards/ck:${opaqueDigest("ck", cardId)}`;
  if (s.path === "review") {
    await page.goto("/reviews");
    const link = page.locator('main a[href^="/reviews/20"]').first();
    if ((await link.count()) === 0) return null;
    return (await link.getAttribute("href")) ?? null;
  }
  return s.path;
}

/** The visible and screen-reader text of main, without scripts, styles, frames and the steelman's evidence markers. */
async function pageText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const clone = document.querySelector("main")!.cloneNode(true) as HTMLElement;
    for (const el of clone.querySelectorAll(
      'script, style, template, iframe, [hidden], [id^="ev-"], [id^="m-ev-"], a[href^="#ev-"], a[href^="#m-ev-"]',
    ))
      el.remove();
    return clone.textContent ?? "";
  });
}

for (const [ri, role] of ROLE_LIST.entries()) {
  for (const [wi, width] of WIDTHS.entries()) {
    test(`AT-82 walk: ${role} at ${width}px, every M21 surface`, async ({ page, context }) => {
      await signIn(context, role);
      await page.setViewportSize({ width, height: 900 });
      const surfaces = SURFACES.filter((s) => role === "owner" || s.ownerOnly !== true);
      for (const [i, s] of surfaces.entries()) {
        const theme = THEMES[(i + ri + wi) % THEMES.length]!;
        await setTheme(role as Role, theme);
        const path = await resolve(page, s, role);
        // the Owner must find every seeded page; a masked role may have no stored review to open
        if (path === null && role !== "owner") continue;
        expect(path, `${s.name}: the seeded page exists`).not.toBeNull();
        const res = await page.goto(path!);
        const where = `${role} ${width}px ${theme} ${path}`;
        expect(res?.status(), `${where}: status`).toBe(200);
        await expect(page.locator("main").first(), where).toBeVisible();
        await expectNoHorizontalScroll(page);
        // the review frame holds no script, so axe cannot inject into it (see m21-review-frame.spec.ts)
        const bad = await axeViolations(page, { exclude: ["iframe[srcdoc]"] });
        expect(bad, `${where}: axe`).toEqual([]);
        if (s.text !== false) {
          const text = await pageText(page);
          const found = matchPatterns(text);
          expect(found, `${where}: internal code in the page text`).toEqual([]);
        }
      }
    });
  }
}
