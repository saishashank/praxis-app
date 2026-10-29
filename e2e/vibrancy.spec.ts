// AT-66 / UXR-051, UXR-057: on each of the six themes every tab shows at least three distinct
// meaningful hues (family / sector / outcome / status / tier / section tokens) above the fold beside
// the neutrals; text passes AA (AAA in High contrast) by axe color-contrast; and nothing animates with
// "Motion: Off" or under prefers-reduced-motion. Hues are counted by matching the computed colours of
// the visible elements against the resolved token values of the active theme.
// Note: the E2E seed has no picks or strategies, so family and sector hues come from what renders
// (nav icons, status chips, outcome colours); run with E2E_SCENARIO=populated for the richest page.
import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";
import path from "node:path";
import { THEMES, setTheme, signIn } from "./helpers";

test.describe.configure({ timeout: 480_000 });
const TABS = ["/", "/picks", "/market", "/strategies", "/news", "/reviews"];
const GROUP =
  /^--color-(family|sector|status|tier|section|positive|negative|warning|brand)[a-z0-9-]*$/;
const SKIP = /-(fill|text|on-fill|tint)$/;

const css = fs.readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");
const TOKENS = [
  ...new Set(
    [...css.matchAll(/(--color-[a-z0-9-]+):/g)].map((m) => m[1]).filter((n) => GROUP.test(n)),
  ),
];

async function hues(page: Page): Promise<{ groups: string[]; tokens: string[] }> {
  return page.evaluate(
    (tokens) => {
      const probe = document.createElement("span");
      document.body.appendChild(probe);
      const resolved = new Map<string, string>();
      for (const t of tokens) {
        probe.style.color = `var(${t})`;
        resolved.set(getComputedStyle(probe).color, t);
      }
      probe.remove();
      const rgb = (c: string) =>
        c
          .match(/[\d.]+/g)
          ?.slice(0, 3)
          .map(Number)
          .join(",");
      const byRgb = new Map<string, string>();
      for (const [c, t] of resolved) byRgb.set(rgb(c)!, t);
      const found = new Set<string>();
      const vh = window.innerHeight;
      const props = [
        "color",
        "backgroundColor",
        "borderTopColor",
        "borderLeftColor",
        "borderBottomColor",
        "fill",
        "stroke",
      ] as const;
      for (const el of Array.from(document.querySelectorAll("body *"))) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || r.top > vh || r.bottom < 0) continue;
        const s = getComputedStyle(el);
        for (const p of props) {
          const hit = byRgb.get(rgb(s[p]) ?? "");
          if (hit) found.add(hit.replace(/-(fill|text|on-fill)$/, ""));
        }
      }
      const tokensFound = [...found];
      const groups = new Set(
        tokensFound.map((t) =>
          t
            .replace(/^--color-/, "")
            .split("-")
            .slice(0, 2)
            .join("-"),
        ),
      );
      return { groups: [...groups], tokens: tokensFound };
    },
    TOKENS.filter((t) => !SKIP.test(t)),
  );
}

test("AT-66: at least three meaningful hues above the fold, on every tab and theme", async ({
  page,
  context,
}, testInfo) => {
  await signIn(context, "owner");
  const report: string[] = [];
  const bad: string[] = [];
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 800 });
    for (const theme of THEMES) {
      await setTheme("owner", theme);
      for (const p of TABS) {
        await page.goto(p);
        await page
          .locator('[data-boot="on"]')
          .waitFor({ state: "detached", timeout: 5000 })
          .catch(() => {});
        const h = await hues(page);
        report.push(`${width} ${theme} ${p}: ${h.tokens.length} (${h.tokens.join(" ")})`);
        if (h.tokens.length < 3) bad.push(`${width} ${theme} ${p}: ${h.tokens.length} hues`);
      }
    }
  }
  await testInfo.attach("hue-report", { body: report.join("\n"), contentType: "text/plain" });
  expect(bad).toEqual([]);
});

test("AT-66: text contrast passes AA (AAA in High contrast) on every tab", async ({
  page,
  context,
}) => {
  await signIn(context, "owner");
  const bad: string[] = [];
  for (const theme of THEMES) {
    await setTheme("owner", theme);
    for (const p of TABS) {
      await page.goto(p);
      await page
        .locator('[data-boot="on"]')
        .waitFor({ state: "detached", timeout: 5000 })
        .catch(() => {});
      const aaa = theme === "high_contrast";
      const builder = new AxeBuilder({ page }).withRules(
        aaa ? ["color-contrast", "color-contrast-enhanced"] : ["color-contrast"],
      );
      const r = await builder.analyze();
      for (const v of r.violations) bad.push(`${theme} ${p}: ${v.id} x${v.nodes.length}`);
    }
  }
  expect(bad).toEqual([]);
});

async function running(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    document
      .getAnimations()
      .filter((a) => a.playState === "running")
      .filter((a) => {
        const t = a.effect?.getComputedTiming();
        // finite animations that finished are not "running"; infinite ones are the continuous kind
        return (t?.iterations ?? 1) === Infinity || Number(t?.activeDuration ?? 0) > 250;
      })
      .map((a) => `${(a as CSSAnimation).animationName ?? a.id ?? "animation"}`),
  );
}

test("AT-66: no continuous motion with Motion Off or prefers-reduced-motion", async ({
  page,
  context,
  browser,
}) => {
  await signIn(context, "owner");
  await setTheme("owner", "dark");
  // reduced motion via the OS preference
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const p of TABS) {
    await page.goto(p);
    await page.waitForTimeout(1500);
    expect(await running(page), `reduced-motion ${p}`).toEqual([]);
  }
  // data-motion="off" with the OS preference unset
  await page.emulateMedia({ reducedMotion: "no-preference" });
  for (const p of TABS) {
    await page.goto(p);
    await page.evaluate(() => document.documentElement.setAttribute("data-motion", "off"));
    await page.waitForTimeout(500);
    expect(await running(page), `motion off ${p}`).toEqual([]);
  }
  void browser;
});
