// UXR-050 / AT-48 walk capture. Only runs with E2E_WALK=<output dir>: screenshots every tab, Settings and
// one sub-page per tab at 375 and 1280 px for one theme and one role (E2E_WALK_THEME, E2E_WALK_ROLE), and
// writes metrics (overflow, contrast, selection cues, sticky offsets) to <dir>/<role>-<theme>.json.
// The images and the log stay outside this repo (SEC-110).
import { test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";
import path from "node:path";
import { setTheme, signIn, type Role } from "./helpers";

const OUT = process.env.E2E_WALK ?? "";
const THEMES_ = (process.env.E2E_WALK_THEME ?? "dark").split(",");
const ROLES_ = (process.env.E2E_WALK_ROLE ?? "owner").split(",") as Role[];
test.skip(!OUT, "set E2E_WALK=<dir> to capture a walk");
test.describe.configure({ timeout: 900_000 });

const PAGES: [string, string][] = [
  ["home", "/"],
  ["picks", "/picks"],
  ["picks-track", "/picks/track-record"],
  ["market", "/market"],
  ["strategies", "/strategies"],
  ["strategies-leaderboard", "/strategies/leaderboard"],
  ["news", "/news"],
  ["reviews", "/reviews"],
  ["reviews-learned", "/reviews/learned"],
  ["settings", "/settings"],
  ["settings-appearance", "/settings/appearance"],
];

async function metrics(page: Page) {
  return page.evaluate(() => {
    const vw = window.innerWidth;
    const wide: string[] = [];
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > vw + 1 && getComputedStyle(el).position !== "fixed") {
        // ignore content inside an element that scrolls on its own
        let scrolls = false;
        for (let p = el.parentElement; p; p = p.parentElement) {
          const o = getComputedStyle(p).overflowX;
          if (o === "auto" || o === "scroll") scrolls = true;
        }
        if (!scrolls) wide.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)}`);
      }
    }
    const header = document.querySelector("header");
    const hb = header ? header.getBoundingClientRect().bottom : 0;
    const sticky = Array.from(document.querySelectorAll("body *"))
      .filter((e) => getComputedStyle(e).position === "sticky" && e !== header)
      .map((e) => ({
        el: `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 30)}`,
        top: getComputedStyle(e).top,
        y: Math.round(e.getBoundingClientRect().top),
        headerBottom: Math.round(hb),
      }));
    return {
      overflowX: document.documentElement.scrollWidth > vw,
      wide: wide.slice(0, 5),
      sticky,
      h1: document.querySelector("h1")?.textContent?.trim() ?? null,
      selected: document.querySelectorAll('[aria-current="page"],[aria-selected="true"]').length,
    };
  });
}

for (const ROLE of ROLES_)
  for (const THEME of THEMES_)
    test(`walk ${ROLE} ${THEME}`, async ({ page, context }) => {
      fs.mkdirSync(OUT, { recursive: true });
      await setTheme(ROLE, THEME);
      await signIn(context, ROLE);
      const log: Record<string, unknown>[] = [];
      for (const width of [375, 1280]) {
        await page.setViewportSize({ width, height: 800 });
        for (const [name, p] of PAGES) {
          const res = await page.goto(p);
          await page
            .locator('[data-boot="on"]')
            .waitFor({ state: "detached", timeout: 5000 })
            .catch(() => {});
          await page.waitForTimeout(300);
          const rec: Record<string, unknown> = {
            page: p,
            width,
            theme: THEME,
            role: ROLE,
            status: res?.status(),
          };
          try {
            Object.assign(rec, await metrics(page));
            const axe = await new AxeBuilder({ page })
              .withRules(
                THEME === "high_contrast"
                  ? ["color-contrast", "color-contrast-enhanced"]
                  : ["color-contrast"],
              )
              .analyze();
            rec.contrast = axe.violations.map((v) => `${v.id} x${v.nodes.length}`);
          } catch (e) {
            rec.error = String(e).slice(0, 200);
          }
          await page.screenshot({
            path: path.join(OUT, `${ROLE}-${THEME}-${width}-${name}.png`),
            fullPage: true,
          });
          log.push(rec);
        }
      }
      fs.writeFileSync(path.join(OUT, `${ROLE}-${THEME}.json`), JSON.stringify(log, null, 1));
    });
